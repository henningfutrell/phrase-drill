/**
 * Runs the clip job queue (`clip-job-store.js`): the only code that
 * calls `elevenLabs.synthesize`, and so the only code that decides what
 * happens after a failure (S5).
 *
 * **Retry policy, and why it lives here.** Retries used to sit in two places
 * — `withRetry` inside the provider and the device's own retry loop — and
 * neither knew what the other had spent. Between 2026-09-02 and 2026-10-03
 * that multiplied every billed-then-failed generation up to nine times. Now
 * each attempt is exactly one provider call, and its outcome is decided once:
 *
 * | outcome | billed | next |
 * |---|---|---|
 * | clip, valid | yes | stored, `done` |
 * | clip, fails `validateClip` | yes | `failed` `unreadable` |
 * | `billed-failure` (body lost after a 2xx) | yes | `failed` |
 * | `network`, `upstream`, `rate-limited` | no | retried with backoff, 3 attempts in all |
 * | `not-configured`, `quota`, `rejected-request` | no | `failed` — no wait fixes it |
 *
 * Billed outcomes count against the hash's window in the job store, which is
 * what caps a hash at two billed calls a day whatever the next bug is.
 *
 * **Waiting.** `/api/tts` queues a job and waits on it here, in-process
 * (`waitFor`), for up to its own deadline. One provider call answers every
 * request waiting on that hash. A waiter on another instance (a deploy
 * overlap) is not told; its device re-polls and finds the clip in the store.
 *
 * **Concurrency** is this runner's: at most `concurrency` jobs in flight. It
 * replaced the provider's bounded queue, which bounded the same calls.
 */

/** Attempts per run, the first included. A retry spends nothing, but it does spend their wait. */
export const MAX_ATTEMPTS = 3

const RETRYABLE = new Set(['network', 'upstream', 'rate-limited'])

/**
 * The wait before attempt `attempt + 1`: 1 s, then 4 s — or, for a rate
 * limit that names its own wait, that wait. Only failures ElevenLabs did not
 * bill reach this.
 */
export function defaultRetryDelayMs(attempt, err) {
  if (err.kind === 'rate-limited' && err.retryAfterMs) return err.retryAfterMs
  return 1000 * 4 ** (attempt - 1)
}

export function createClipJobRunner({
  jobStore,
  clipStore,
  elevenLabs,
  validateClip,
  logger,
  concurrency = 4,
  pollMs = 1000,
  maxAttempts = MAX_ATTEMPTS,
  retryDelayMs = defaultRetryDelayMs,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  /** hash → the resolvers of every request waiting on it. */
  const waiters = new Map()
  const inFlight = new Set()
  let billedFailures = 0
  let started = false
  let stopping = null
  let timer = null
  let looping = null
  let loopAgain = false
  let lastReapAt = -Infinity

  function schedule(ms) {
    clearTimer(timer)
    timer = setTimer(tick, ms)
    timer?.unref?.()
  }

  /** One loop at a time; a wake during a loop runs another right after it. */
  function tick() {
    if (!started || stopping) return
    if (looping) {
      loopAgain = true
      return
    }
    looping = loop().finally(() => {
      looping = null
      if (stopping) return
      if (loopAgain) {
        loopAgain = false
        tick()
      } else {
        schedule(pollMs)
      }
    })
  }

  async function loop() {
    try {
      // Reaped on the poll's cadence, not on every wake: a sweep wakes the
      // loop once per finished job, and the reap is two statements.
      if (now() - lastReapAt >= pollMs) {
        lastReapAt = now()
        await jobStore.reapStale(now())
      }
      while (!stopping && inFlight.size < concurrency) {
        const job = await jobStore.claim(now())
        if (!job) break
        const run = runJob(job).finally(() => {
          inFlight.delete(run)
          tick() // a slot is free
        })
        inFlight.add(run)
      }
    } catch (err) {
      logger.error('clip job loop failed', { message: describeError(err) })
    }
  }

  async function runJob(job) {
    let result
    try {
      result = await elevenLabs.synthesize({ text: job.text, voiceId: job.voiceId, modelId: job.modelId })
    } catch (err) {
      return afterFailure(job, err)
    }

    const invalid = validateClip({ bytes: result.bytes, contentType: result.contentType, text: job.text })
    if (invalid) {
      // Billed, and a retry would very likely buy the same unusable body.
      billedFailures += 1
      logger.error('tts provider error', { kind: 'unreadable', message: `ElevenLabs returned an unusable clip: ${invalid}` })
      await record(job, () => jobStore.fail(job.hash, 'unreadable', now(), { billed: true }))
      return settle(job.hash, { status: 'failed', kind: 'unreadable' })
    }

    const clip = { bytes: result.bytes, mime: 'audio/mpeg', durationMs: result.durationMs }
    // A failed write must not fail the job's waiters: the bytes are paid for
    // and they want the audio more than a complete store. The next miss for
    // this hash pays again, inside the cap.
    try {
      await clipStore.put({ hash: job.hash, ...clip, createdAt: now() })
    } catch (err) {
      logger.warn('could not store generated clip', { hash: job.hash, message: describeError(err) })
    }
    await record(job, () => jobStore.complete(job.hash, now()))
    settle(job.hash, { status: 'done', clip })
  }

  async function afterFailure(job, err) {
    const kind = err?.kind ?? 'network'
    // Kind and message only — never the text or the session.
    logger.error('tts provider error', { kind, message: describeError(err) })

    if (kind === 'billed-failure') {
      billedFailures += 1
      await record(job, () => jobStore.fail(job.hash, kind, now(), { billed: true }))
      return settle(job.hash, { status: 'failed', kind })
    }

    const attempts = job.attempts + 1
    if (RETRYABLE.has(kind) && attempts < maxAttempts) {
      const nextAttemptAt = now() + retryDelayMs(attempts, err)
      // Its waiters keep waiting: the job is not over.
      return record(job, () => jobStore.retryLater(job.hash, { nextAttemptAt, kind }, now()))
    }

    await record(job, () => jobStore.fail(job.hash, kind, now()))
    settle(job.hash, { status: 'failed', kind, ...(kind === 'rate-limited' && err.retryAfterMs ? { retryAfterMs: err.retryAfterMs } : {}) })
  }

  /**
   * A job store write that fails leaves the row `running`; `reapStale` puts it
   * back in the queue after `STALE_RUNNING_MS`. Logged, never thrown — the
   * outcome in hand is still given to the waiters.
   */
  async function record(job, write) {
    try {
      await write()
    } catch (err) {
      logger.error('could not record clip job outcome', { hash: job.hash, message: describeError(err) })
    }
  }

  function settle(hash, outcome) {
    for (const done of [...(waiters.get(hash) ?? [])]) done(outcome)
  }

  return {
    start() {
      if (started) return
      started = true
      tick()
    },

    /** Runs the loop now instead of at the next poll — called when a job is queued. */
    wake() {
      if (!started || stopping) return
      clearTimer(timer)
      tick()
    },

    /**
     * Resolves with the job's outcome: `{ status: 'done', clip }`,
     * `{ status: 'failed', kind[, retryAfterMs] }`, or `{ status: 'pending' }`
     * once `timeoutMs` passes (or the runner stops) first.
     */
    waitFor(hash, timeoutMs) {
      return new Promise((resolve) => {
        if (stopping) return resolve({ status: 'pending' })
        const set = waiters.get(hash) ?? new Set()
        waiters.set(hash, set)
        const deadline = setTimer(() => done({ status: 'pending' }), timeoutMs)
        deadline?.unref?.()
        function done(outcome) {
          clearTimer(deadline)
          set.delete(done)
          if (set.size === 0 && waiters.get(hash) === set) waiters.delete(hash)
          resolve(outcome)
        }
        set.add(done)
      })
    },

    /**
     * Graceful: claims nothing more and answers every waiter `pending` at once
     * (so an HTTP drain is not held for a generation), then waits for the
     * calls already made — they are paid for, and their clips should land.
     */
    stop() {
      stopping ??= (async () => {
        clearTimer(timer)
        for (const set of [...waiters.values()]) for (const done of [...set]) done({ status: 'pending' })
        await looping
        await Promise.allSettled([...inFlight])
      })()
      return stopping
    },

    /** Read by `/api/status`: provider 2xx responses that yielded no stored clip. */
    stats: () => ({ billedFailures }),
  }
}

function describeError(err) {
  return err instanceof Error ? err.message : String(err)
}
