import { expect, it } from 'vitest'
import { BILLING_WINDOW_MS, STALE_RUNNING_MS, newClipJob, planRequest } from './clip-job-store.js'

/**
 * An in-memory `clip_jobs`, for the suites that need a job store but are not
 * about its SQL (`clip-job-runner.test.js`, `app.test.js`).
 *
 * It shares the one piece of policy the real store has — what a request does
 * to an existing row (`planRequest`) — rather than restating it, and
 * `clipJobStoreContract` below runs the same assertions against this and
 * against the real store on a live Postgres (`db.postgres.test.js`). A fake
 * that is only ever checked against itself is a second claim about the
 * schema; this one is checked against the first.
 */
export function createMemoryClipJobStore() {
  const rows = new Map()
  const copy = (row) => ({ ...row })

  return {
    rows,
    async init() {},

    async request(fields, now) {
      const row = rows.get(fields.hash)
      if (!row) {
        const job = newClipJob(fields, now)
        rows.set(job.hash, job)
        return { capped: false, job: copy(job) }
      }
      const plan = planRequest(row, now)
      if (plan.next) rows.set(row.hash, plan.next)
      return plan.capped ? { capped: true } : { capped: false, job: copy(rows.get(row.hash)) }
    },

    async get(hash) {
      const row = rows.get(hash)
      return row ? copy(row) : null
    },

    async delete(hash) {
      return rows.delete(hash)
    },

    async claim(now) {
      const [due] = [...rows.values()]
        .filter((row) => row.state === 'queued' && row.nextAttemptAt <= now)
        .sort((a, b) => a.createdAt - b.createdAt || (a.hash < b.hash ? -1 : 1))
      if (!due) return null
      Object.assign(due, { state: 'running', updatedAt: now })
      return copy(due)
    },

    async complete(hash, now) {
      const row = rows.get(hash)
      if (row) Object.assign(row, { state: 'done', billedCalls: row.billedCalls + 1, lastErrorKind: null, updatedAt: now })
    },

    async retryLater(hash, { nextAttemptAt, kind }, now) {
      const row = rows.get(hash)
      if (row) Object.assign(row, { state: 'queued', attempts: row.attempts + 1, nextAttemptAt, lastErrorKind: kind, updatedAt: now })
    },

    async fail(hash, kind, now, { billed = false } = {}) {
      const row = rows.get(hash)
      if (row) Object.assign(row, { state: 'failed', billedCalls: row.billedCalls + (billed ? 1 : 0), lastErrorKind: kind, updatedAt: now })
    },

    async reapStale(now) {
      for (const row of rows.values()) {
        if (row.state === 'running' && row.updatedAt <= now - STALE_RUNNING_MS) {
          Object.assign(row, { state: 'queued', nextAttemptAt: now, updatedAt: now })
        }
        if ((row.state === 'done' || row.state === 'failed') && row.windowStartedAt <= now - BILLING_WINDOW_MS) rows.delete(row.hash)
      }
    },

    async counts() {
      const counts = { queued: 0, running: 0, failed: 0 }
      for (const row of rows.values()) if (row.state in counts) counts[row.state] += 1
      return counts
    },
  }
}

/** The five content-address fields plus their hash — the shape `request` takes. */
export function jobFields(overrides = {}) {
  return { hash: 'h1', provider: 'elevenlabs', modelId: 'm1', voiceId: 'v1', lang: 'fr-FR', text: 'bonjour', ...overrides }
}

/**
 * What any clip job store must do, real or fake. Registered as `it`s inside
 * the caller's `describe`; `makeStore` returns a fresh, initialised, empty
 * store for every test.
 */
export function clipJobStoreContract(makeStore) {
  const T0 = 1_760_000_000_000

  it('queues an unknown hash, due now, with nothing spent', async () => {
    const store = await makeStore()
    const { capped, job } = await store.request(jobFields(), T0)

    expect(capped).toBe(false)
    expect(job).toMatchObject({
      hash: 'h1',
      provider: 'elevenlabs',
      modelId: 'm1',
      voiceId: 'v1',
      lang: 'fr-FR',
      text: 'bonjour',
      state: 'queued',
      attempts: 0,
      billedCalls: 0,
      windowStartedAt: T0,
      nextAttemptAt: T0,
      lastErrorKind: null,
      createdAt: T0,
      updatedAt: T0,
    })
  })

  // Regenerate reads the row before it decides anything (R1): a job in
  // flight is joined, a capped hash is refused before its Clip is deleted.
  it('reads one job by hash without changing it, and null for a hash never asked for', async () => {
    const store = await makeStore()
    expect(await store.get('h1')).toBeNull()

    await store.request(jobFields(), T0)
    await store.claim(T0)
    await store.complete('h1', T0 + 1)

    expect(await store.get('h1')).toMatchObject({ hash: 'h1', state: 'done', billedCalls: 1, updatedAt: T0 + 1, windowStartedAt: T0 })
    expect(await store.get('h1'), 'a read is not a request').toMatchObject({ state: 'done', updatedAt: T0 + 1 })
  })

  // `scripts/clip-delete.mjs` (R2): the operator removes a hash's row — and
  // with it the billing cap — so the next request starts a fresh window.
  it('deletes one job by hash, saying whether there was one, and leaves the rest', async () => {
    const store = await makeStore()
    await store.request(jobFields({ hash: 'gone' }), T0)
    await store.request(jobFields({ hash: 'kept' }), T0)

    expect(await store.delete('gone')).toBe(true)
    expect(await store.delete('gone')).toBe(false)
    expect(await store.get('gone')).toBeNull()
    expect(await store.get('kept')).not.toBeNull()
    expect((await store.request(jobFields({ hash: 'gone' }), T0 + 5)).job).toMatchObject({ billedCalls: 0, createdAt: T0 + 5 })
  })

  // The device re-polls a 202 by POSTing again. That must join the job, not
  // restart it: a reset here would hand a backing-off job a fresh three
  // attempts on every poll, which is the retry multiplication this exists to end.
  it('returns a queued job unchanged on a re-poll, keeping its attempts and backoff', async () => {
    const store = await makeStore()
    await store.request(jobFields(), T0)
    await store.claim(T0)
    await store.retryLater('h1', { nextAttemptAt: T0 + 4000, kind: 'network' }, T0 + 1)

    const { capped, job } = await store.request(jobFields(), T0 + 2)

    expect(capped).toBe(false)
    expect(job).toMatchObject({ state: 'queued', attempts: 1, nextAttemptAt: T0 + 4000, lastErrorKind: 'network', updatedAt: T0 + 1 })
  })

  it('returns a running job unchanged — one generation per hash at a time', async () => {
    const store = await makeStore()
    await store.request(jobFields(), T0)
    await store.claim(T0)

    const { job } = await store.request(jobFields(), T0 + 5)

    expect(job).toMatchObject({ state: 'running', updatedAt: T0 })
    expect(await store.claim(T0 + 5), 'a running job is not claimable twice').toBeNull()
  })

  it('claims the oldest due job, marks it running, and never one not yet due', async () => {
    const store = await makeStore()
    await store.request(jobFields({ hash: 'b' }), T0)
    await store.request(jobFields({ hash: 'a' }), T0 + 1)
    await store.request(jobFields({ hash: 'later' }), T0 + 2)
    await store.claim(T0 + 2).then((job) => store.retryLater(job.hash, { nextAttemptAt: T0 + 10_000, kind: 'upstream' }, T0 + 2))

    const first = await store.claim(T0 + 3)
    expect(first).toMatchObject({ hash: 'a', state: 'running', updatedAt: T0 + 3 })
    expect((await store.claim(T0 + 3)).hash).toBe('later')
    expect(await store.claim(T0 + 3), "'b', the oldest, is backing off until T0+10s").toBeNull()
    expect((await store.claim(T0 + 10_000)).hash).toBe('b')
  })

  it('completes a job as done with one billed call, and a later miss queues it afresh', async () => {
    const store = await makeStore()
    await store.request(jobFields(), T0)
    await store.claim(T0)
    await store.complete('h1', T0 + 1)

    expect(await store.counts()).toEqual({ queued: 0, running: 0, failed: 0 })

    // A miss on a done job: the clip was evicted, or its write failed.
    const { job } = await store.request(jobFields(), T0 + 2)
    expect(job).toMatchObject({ state: 'queued', attempts: 0, billedCalls: 1, nextAttemptAt: T0 + 2, lastErrorKind: null })
  })

  it('fails a job, counting the call only when it was billed', async () => {
    const store = await makeStore()
    await store.request(jobFields({ hash: 'free' }), T0)
    await store.request(jobFields({ hash: 'paid' }), T0)
    await store.claim(T0)
    await store.claim(T0)
    await store.fail('free', 'quota', T0 + 1)
    await store.fail('paid', 'billed-failure', T0 + 1, { billed: true })

    expect(await store.counts()).toEqual({ queued: 0, running: 0, failed: 2 })
    expect((await store.request(jobFields({ hash: 'free' }), T0 + 2)).job.billedCalls).toBe(0)
    expect((await store.request(jobFields({ hash: 'paid' }), T0 + 2)).job.billedCalls).toBe(1)
  })

  // The month that was lost: every miss billed, nothing stored, retried. The
  // cap is the backstop that holds whatever the next such bug is.
  it('caps a hash at two billed calls per window, leaving it failed billing-capped', async () => {
    const store = await makeStore()
    for (let i = 0; i < 2; i += 1) {
      await store.request(jobFields(), T0 + i)
      await store.claim(T0 + i)
      await store.fail('h1', 'unreadable', T0 + i, { billed: true })
    }

    expect(await store.request(jobFields(), T0 + 10)).toEqual({ capped: true })
    expect(await store.claim(T0 + 10), 'a capped hash is not queued').toBeNull()
    expect(await store.counts()).toEqual({ queued: 0, running: 0, failed: 1 })
  })

  it('opens a new billing window once 24 h have passed since the last one began', async () => {
    const store = await makeStore()
    for (let i = 0; i < 2; i += 1) {
      await store.request(jobFields(), T0 + i)
      await store.claim(T0 + i)
      await store.complete('h1', T0 + i)
    }
    expect(await store.request(jobFields(), T0 + BILLING_WINDOW_MS - 1)).toEqual({ capped: true })

    const { capped, job } = await store.request(jobFields(), T0 + BILLING_WINDOW_MS)
    expect(capped).toBe(false)
    expect(job).toMatchObject({ state: 'queued', billedCalls: 0, windowStartedAt: T0 + BILLING_WINDOW_MS })
  })

  // Age-gated so that during a deploy overlap the new instance does not take
  // a job the old one is still finishing (a provider call is at most 30 s).
  it('reaps a running job back to queued only once it is older than STALE_RUNNING_MS', async () => {
    const store = await makeStore()
    await store.request(jobFields(), T0)
    await store.claim(T0)

    await store.reapStale(T0 + STALE_RUNNING_MS - 1)
    expect(await store.counts()).toEqual({ queued: 0, running: 1, failed: 0 })

    await store.reapStale(T0 + STALE_RUNNING_MS)
    expect(await store.counts()).toEqual({ queued: 1, running: 0, failed: 0 })
    expect(await store.claim(T0 + STALE_RUNNING_MS)).toMatchObject({ hash: 'h1', state: 'running' })
  })

  it('prunes done and failed rows whose billing window is over, and nothing else', async () => {
    const store = await makeStore()
    for (const hash of ['done', 'failed']) await store.request(jobFields({ hash }), T0)
    await store.claim(T0)
    await store.claim(T0)
    await store.complete('done', T0)
    await store.fail('failed', 'quota', T0)
    await store.request(jobFields({ hash: 'young' }), T0 + 1000)
    await store.claim(T0 + 1000)
    await store.complete('young', T0 + 1000)
    await store.request(jobFields({ hash: 'queued' }), T0 + 2000)

    await store.reapStale(T0 + BILLING_WINDOW_MS)

    expect(await store.counts()).toEqual({ queued: 1, running: 0, failed: 0 })
    // `young` survived: its window is not over, so its billed call still counts.
    expect((await store.request(jobFields({ hash: 'young' }), T0 + BILLING_WINDOW_MS)).job.billedCalls).toBe(1)
    expect((await store.request(jobFields({ hash: 'done' }), T0 + BILLING_WINDOW_MS)).job.createdAt).toBe(T0 + BILLING_WINDOW_MS)
  })
}
