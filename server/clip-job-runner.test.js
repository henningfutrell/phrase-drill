// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClipJobRunner, defaultRetryDelayMs } from './clip-job-runner.js'
import { STALE_RUNNING_MS } from './clip-job-store.js'
import { createMemoryClipJobStore, jobFields } from './clip-job-store.test-support.js'
import { createClipStore } from './db.js'
import { fakeClipPool } from './pool.test-support.js'
import { validateClip } from './clip-validation.js'

/**
 * S5. The runner owns every ElevenLabs call `/api/tts` makes, and so owns
 * the one decision that cost a month of credit: what to do after a failure.
 * Retried: only what ElevenLabs cannot have billed (no answer, a 5xx, a 429),
 * three attempts at most, with backoff. Never retried: anything after a billed
 * 2xx, and anything a retry cannot fix.
 *
 * The provider is faked at its seam (`synthesize`), the job store is the
 * contract-checked in-memory one, and validation and the clip store are real.
 */

/** A body `validateClip` accepts for 'bonjour': ID3 tag, audio/mpeg, a plausible size. */
function goodClip(mark = 1) {
  const bytes = Buffer.alloc(1600)
  bytes.set([0x49, 0x44, 0x33, mark])
  return { bytes, contentType: 'audio/mpeg', durationMs: 100 }
}

function providerError(kind, extra = {}) {
  return Object.assign(new Error(`fake ${kind}`), { kind, ...extra })
}

/**
 * A fake ElevenLabs provider. Each call takes the next scripted outcome — a
 * result, an Error to throw, or a function returning either (for a deferred
 * answer); the last one repeats.
 */
function fakeProvider(...script) {
  const provider = {
    calls: 0,
    active: 0,
    maxActive: 0,
    async synthesize(request) {
      provider.calls += 1
      provider.active += 1
      provider.maxActive = Math.max(provider.maxActive, provider.active)
      provider.lastRequest = request
      const step = script[Math.min(provider.calls - 1, script.length - 1)]
      try {
        const outcome = typeof step === 'function' ? await step() : step
        if (outcome instanceof Error) throw outcome
        return outcome
      } finally {
        provider.active -= 1
      }
    },
  }
  return provider
}

function deferred() {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

let runner

afterEach(async () => {
  await runner?.stop()
  runner = undefined
})

async function setup({ provider = fakeProvider(goodClip()), start = true, ...options } = {}) {
  const jobStore = createMemoryClipJobStore()
  const clipStore = createClipStore(fakeClipPool())
  await clipStore.init()
  const logger = silentLogger()
  runner = createClipJobRunner({
    jobStore,
    clipStore,
    elevenLabs: provider,
    validateClip,
    logger,
    pollMs: 5,
    retryDelayMs: () => 1,
    ...options,
  })
  if (start) runner.start()
  /** What `/api/tts` does on a miss: queue, wake, wait. */
  async function ask(hash = 'h1', timeoutMs = 2000) {
    await jobStore.request(jobFields({ hash }), (options.now ?? Date.now)())
    const outcome = runner.waitFor(hash, timeoutMs)
    runner.wake()
    return outcome
  }
  return { jobStore, clipStore, provider, logger, ask }
}

describe('createClipJobRunner (S5)', () => {
  it('generates a queued job once, stores the clip, and resolves its waiter done', async () => {
    const { ask, provider, clipStore, jobStore } = await setup()

    const outcome = await ask()

    expect(outcome.status).toBe('done')
    expect(outcome.clip).toMatchObject({ mime: 'audio/mpeg', durationMs: 100 })
    expect(Buffer.from(outcome.clip.bytes).equals(goodClip().bytes)).toBe(true)
    expect(provider.calls).toBe(1)
    expect(provider.lastRequest).toEqual({ text: 'bonjour', voiceId: 'v1', modelId: 'm1' })
    expect(await clipStore.get('h1')).not.toBeNull()
    expect(jobStore.rows.get('h1')).toMatchObject({ state: 'done', billedCalls: 1 })
  })

  // Two devices missing the same clip at once used to pay twice.
  it('answers every waiter on one hash from a single provider call', async () => {
    const { ask, provider } = await setup()

    const [a, b] = await Promise.all([ask(), ask()])

    expect(a.status).toBe('done')
    expect(b.status).toBe('done')
    expect(provider.calls).toBe(1)
  })

  it('never retries a failure after a billed 2xx, and counts it', async () => {
    const { ask, provider, jobStore } = await setup({ provider: fakeProvider(providerError('billed-failure')) })

    expect(await ask()).toEqual({ status: 'failed', kind: 'billed-failure' })
    expect(provider.calls).toBe(1)
    expect(jobStore.rows.get('h1')).toMatchObject({ state: 'failed', billedCalls: 1, lastErrorKind: 'billed-failure' })
    expect(runner.stats().billedFailures).toBe(1)
  })

  it('fails a clip that does not validate as unreadable: billed, never stored, never retried', async () => {
    const junk = { bytes: Buffer.alloc(2000, 0x7b), contentType: 'application/json', durationMs: 125 }
    const { ask, provider, jobStore, clipStore } = await setup({ provider: fakeProvider(junk) })

    expect(await ask()).toEqual({ status: 'failed', kind: 'unreadable' })
    expect(provider.calls).toBe(1)
    expect(await clipStore.get('h1')).toBeNull()
    expect(jobStore.rows.get('h1')).toMatchObject({ state: 'failed', billedCalls: 1, lastErrorKind: 'unreadable' })
    expect(runner.stats().billedFailures).toBe(1)
  })

  it.each([['network'], ['upstream'], ['rate-limited']])('retries %s up to three attempts, unbilled, then fails with it', async (kind) => {
    const { ask, provider, jobStore } = await setup({ provider: fakeProvider(providerError(kind)) })

    const outcome = await ask()

    expect(outcome).toMatchObject({ status: 'failed', kind })
    expect(provider.calls).toBe(3)
    expect(jobStore.rows.get('h1')).toMatchObject({ state: 'failed', billedCalls: 0, lastErrorKind: kind })
    expect(runner.stats().billedFailures).toBe(0)
  })

  it('carries a rate limit’s own wait to the waiter', async () => {
    const { ask } = await setup({ provider: fakeProvider(providerError('rate-limited', { retryAfterMs: 3000 })) })
    expect(await ask()).toEqual({ status: 'failed', kind: 'rate-limited', retryAfterMs: 3000 })
  })

  it('stores the clip when a retried failure then succeeds', async () => {
    const { ask, provider, jobStore } = await setup({ provider: fakeProvider(providerError('upstream'), goodClip()) })

    expect((await ask()).status).toBe('done')
    expect(provider.calls).toBe(2)
    expect(jobStore.rows.get('h1')).toMatchObject({ state: 'done', billedCalls: 1 })
  })

  it.each([['not-configured'], ['quota'], ['rejected-request']])('fails %s at once, unbilled — no wait fixes it', async (kind) => {
    const { ask, provider, jobStore } = await setup({ provider: fakeProvider(providerError(kind)) })

    expect(await ask()).toEqual({ status: 'failed', kind })
    expect(provider.calls).toBe(1)
    expect(jobStore.rows.get('h1')).toMatchObject({ state: 'failed', billedCalls: 0 })
  })

  it('does not try again before the backoff is over', async () => {
    let clock = 1_000_000
    const retryDelayMs = vi.fn(() => 1000)
    const { ask, provider } = await setup({
      provider: fakeProvider(providerError('network'), goodClip()),
      now: () => clock,
      retryDelayMs,
    })

    const outcome = ask()
    await vi.waitFor(() => expect(provider.calls).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 30)) // several polls
    expect(provider.calls, 'still inside the backoff').toBe(1)
    expect(retryDelayMs).toHaveBeenCalledWith(1, expect.objectContaining({ kind: 'network' }))

    clock += 1000
    runner.wake()
    expect((await outcome).status).toBe('done')
    expect(provider.calls).toBe(2)
  })

  it('answers pending when the job outlives the wait, and finishes it anyway', async () => {
    const gate = deferred()
    const { ask, jobStore } = await setup({ provider: fakeProvider(() => gate.promise) })

    expect(await ask('h1', 20)).toEqual({ status: 'pending' })

    gate.resolve(goodClip())
    await vi.waitFor(() => expect(jobStore.rows.get('h1').state).toBe('done'))
  })

  it('never runs more than `concurrency` provider calls at once', async () => {
    const gate = deferred()
    // No poll to fall back on: a freed slot must claim the next job itself.
    const { ask, provider } = await setup({ provider: fakeProvider(() => gate.promise), concurrency: 2, pollMs: 60_000 })

    const outcomes = ['a', 'b', 'c', 'd', 'e'].map((hash) => ask(hash))
    await vi.waitFor(() => expect(provider.calls).toBe(2))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(provider.calls).toBe(2)

    gate.resolve(goodClip())
    const settled = await Promise.all(outcomes)
    expect(settled.every((o) => o.status === 'done')).toBe(true)
    expect(provider.maxActive).toBe(2)
  })

  // The bytes are paid for; a full or broken store must not cost them the audio.
  it('still answers done with the clip when the store write fails', async () => {
    const { ask, clipStore, jobStore, logger } = await setup()
    clipStore.put = async () => {
      throw new Error('disk full')
    }

    const outcome = await ask()

    expect(outcome.status).toBe('done')
    expect(outcome.clip.bytes.byteLength).toBe(1600)
    expect(jobStore.rows.get('h1').state).toBe('done')
    expect(logger.warn).toHaveBeenCalledWith('could not store generated clip', expect.objectContaining({ hash: 'h1' }))
  })

  it('reruns a job left running by an instance that went away', async () => {
    const t0 = 2_000_000
    const { jobStore, provider } = await setup({ now: () => t0 + STALE_RUNNING_MS, start: false })
    await jobStore.request(jobFields(), t0)
    await jobStore.claim(t0) // the other instance took it, then died

    runner.start()

    await vi.waitFor(() => expect(jobStore.rows.get('h1').state).toBe('done'))
    expect(provider.calls).toBe(1)
  })

  it('picks up a queued job on its own poll, without a wake', async () => {
    const { jobStore, provider } = await setup()
    await jobStore.request(jobFields(), Date.now())

    await vi.waitFor(() => expect(provider.calls).toBe(1))
  })

  it('logs a store failure in its loop and keeps polling', async () => {
    const { jobStore, provider, logger } = await setup()
    const claim = jobStore.claim
    jobStore.claim = async () => {
      jobStore.claim = claim
      throw new Error('connection reset')
    }
    await jobStore.request(jobFields(), Date.now())

    await vi.waitFor(() => expect(provider.calls).toBe(1))
    expect(logger.error).toHaveBeenCalledWith('clip job loop failed', { message: 'connection reset' })
  })

  it('on stop, claims nothing more, releases waiters as pending, and lets the call in flight finish', async () => {
    const gate = deferred()
    const { ask, jobStore, provider } = await setup({ provider: fakeProvider(() => gate.promise) })

    const waiting = ask('h1', 10_000)
    await vi.waitFor(() => expect(provider.calls).toBe(1))

    const stopped = runner.stop()
    expect(await waiting, 'a request in flight is answered, not held for the deadline').toEqual({ status: 'pending' })

    await jobStore.request(jobFields({ hash: 'h2' }), Date.now())
    runner.wake()
    gate.resolve(goodClip())
    await stopped

    expect(jobStore.rows.get('h1').state, 'the paid-for call in flight is stored').toBe('done')
    expect(jobStore.rows.get('h2').state, 'nothing new is claimed after stop').toBe('queued')
    expect(provider.calls).toBe(1)
  })
})

describe('defaultRetryDelayMs', () => {
  it('backs off 1 s, then 4 s', () => {
    expect(defaultRetryDelayMs(1, providerError('network'))).toBe(1000)
    expect(defaultRetryDelayMs(2, providerError('upstream'))).toBe(4000)
  })

  it('waits as long as a rate limit asks, when it says', () => {
    expect(defaultRetryDelayMs(1, providerError('rate-limited', { retryAfterMs: 3000 }))).toBe(3000)
    expect(defaultRetryDelayMs(2, providerError('rate-limited'))).toBe(4000)
  })
})
