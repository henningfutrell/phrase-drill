// @vitest-environment node
/**
 * AUDIT-T080 — adversarial probes against T071's two claims:
 *   (a) a library push never destroys what it replaces — the prior version is
 *       archived into `library_versions` first;
 *   (b) the Clip store is bounded.
 *
 * These tests assert the CLAIMS, not the current behaviour. A test that fails
 * here is a claim the code does not keep. Tests marked "HOLDS" are probes that
 * failed to break the code and are kept as the record of what was tried.
 *
 * Runs against the same in-memory fakes `db.test.js` uses
 * (`server/pool.test-support.js`) — `SMOKE_DATABASE_URL` is unset here, so the
 * live-Postgres suite is skipped and would be no evidence.
 */
import { describe, expect, it } from 'vitest'
import { createLibraryStore, createClipStore, LIBRARY_VERSION_SNAPSHOT_INTERVAL_MS } from './db.js'
import { fakeLibraryPool, fakeClipPool } from './pool.test-support.js'

const KEY = 'sub-1'
const HOUR = LIBRARY_VERSION_SNAPSHOT_INTERVAL_MS

/** A realistic envelope of `n` phrases, big enough that "how much was lost" is legible. */
function library(n, tag) {
  return JSON.stringify({
    format: 'phrase-drill-library',
    schemaVersion: 3,
    exportedAt: 0,
    decks: [{ id: 'd1', name: tag, phrases: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, fr: `phrase ${i}`, en: `en ${i}` })) }],
  })
}

async function newStore(options) {
  const pool = fakeLibraryPool()
  const store = createLibraryStore(pool, options)
  await store.init()
  return { pool, store }
}

// ---------------------------------------------------------------------------
// PROBE 1 — the one-hour snapshot throttle
// ---------------------------------------------------------------------------

describe('AUDIT-T080 probe 1 — the snapshot throttle', () => {
  /**
   * The concrete sequence the lead asked for.
   *
   * 09:00  she has 400 phrases (state A). First push of the day archives nothing
   *        yet (nothing to replace) / archives the previous day's state.
   * 10:00  a push carrying 500 phrases (state GOOD — an hour of adding phrases).
   *        This push archives A, because an hour has passed. GOOD itself is now
   *        the only copy of those 100 new phrases anywhere but the phone.
   * 10:01  the phone pushes an empty/truncated library (state BAD). Only 60s
   *        since the last archive, so NOTHING is archived. GOOD is overwritten.
   * 10:02  a second BAD push. Still throttled.
   *
   * Claim (a) says GOOD is recoverable. It is not: the deepest recovery point
   * is A, one hour stale.
   */
  it('P1 — a good push then a bad push a minute later destroys the good version, unarchived', async () => {
    const { store } = await newStore()
    const A = library(400, 'A-0900')
    const GOOD = library(500, 'GOOD-1000')
    const BAD = library(0, 'BAD-1001')

    await store.put(KEY, A, 1, { now: 9 * HOUR })
    await store.put(KEY, GOOD, 2, { now: 10 * HOUR })
    await store.put(KEY, BAD, 3, { now: 10 * HOUR + 60_000 })
    await store.put(KEY, BAD + ' ', 4, { now: 10 * HOUR + 120_000 })

    const archived = (await store.versions(KEY)).map((v) => v.data)
    expect(await store.get(KEY), 'the bad push is what is stored').toMatchObject({ data: BAD + ' ' })
    // The claim under audit.
    expect(archived, 'claim (a): the version the 10:01 push replaced must be archived').toContain(GOOD)
  })

  /**
   * The throttle is not a rare window — it is the normal state.
   *
   * docs/sync.md: the client debounces pushes at 2 seconds, and pushes on every
   * local edit. So an hour of editing is up to ~1800 pushes and EXACTLY ONE
   * archive: the first. Every state after that first push is unprotected until
   * the top of the next hour.
   */
  it('P1b — an hour of normal 2-second-debounced pushes yields exactly one archive, of the oldest state', async () => {
    const { store } = await newStore()
    await store.put(KEY, library(1, 's0'), 0, { now: 0 })
    // One push every 2s for an hour, each adding a phrase.
    for (let i = 1; i <= 1800; i += 1) await store.put(KEY, library(i, `s${i}`), i, { now: i * 2000 })

    const archived = await store.versions(KEY)
    expect(archived.length, 'one archive for 1800 pushes').toBe(1)
    expect(archived[0].data, 'and it is the state from the very first push').toBe(library(1, 's0'))
    // Claim (a), stated as recoverability: the state immediately before the
    // last push must be recoverable. It is 1799 pushes gone.
    expect(archived.map((v) => v.data), 'claim (a): the version the last push replaced must be recoverable').toContain(library(1799, 's1799'))
  })
})

// ---------------------------------------------------------------------------
// PROBE 2 — pruning by count AND bytes
// ---------------------------------------------------------------------------

describe('AUDIT-T080 probe 2 — pruneVersions', () => {
  /** HOLDS. `pruneVersions` exempts index 0 unconditionally, so it cannot empty the table. */
  it('P2 — HOLDS: count and byte budgets together cannot prune to zero', async () => {
    for (const options of [
      { versionMaxCount: 0, versionMaxBytes: 0 },
      { versionMaxCount: 1, versionMaxBytes: 1 },
      { versionMaxCount: 0, versionMaxBytes: -1 },
      { versionMaxCount: Number.NaN, versionMaxBytes: Number.NaN },
    ]) {
      const { store } = await newStore(options)
      for (let i = 0; i <= 6; i += 1) await store.put(KEY, library(20, `v${i}`), i, { now: i * HOUR })
      expect((await store.versions(KEY)).length, `at least one version survives with ${JSON.stringify(options)}`).toBeGreaterThanOrEqual(1)
    }
  })

  /**
   * BREAKS the retention depth, not the last-copy rule.
   *
   * `pruneVersions` runs a prefix sum from the NEWEST row and dooms every row
   * from the first index where the running total exceeds `versionMaxBytes`.
   * The newest row's own bytes are inside that running total, so one archived
   * version larger than the whole budget dooms every older row in a single
   * sweep — the history collapses from N to 1.
   */
  it('P2b — one oversized archived version deletes the entire remaining history in one sweep', async () => {
    const { store } = await newStore({ versionMaxBytes: 20_000 })
    // Six ordinary hourly snapshots first.
    for (let i = 0; i <= 6; i += 1) await store.put(KEY, library(5, `small${i}`), i, { now: i * HOUR })
    expect((await store.versions(KEY)).length, 'six hours of history built up').toBeGreaterThan(3)

    // She imports a big scan. The next push archives that oversized state.
    await store.put(KEY, library(600, 'huge'), 7, { now: 7 * HOUR })
    await store.put(KEY, library(5, 'after'), 8, { now: 8 * HOUR })

    expect((await store.versions(KEY)).length, 'one oversized version must not wipe the older, smaller ones').toBeGreaterThan(1)
  })
})

// ---------------------------------------------------------------------------
// PROBE 3 — the missing transaction
// ---------------------------------------------------------------------------

describe('AUDIT-T080 probe 3 — archive and overwrite are not one transaction', () => {
  /** HOLDS for a crash: archive-then-overwrite in that order is crash-safe on its own. */
  it('P3 — HOLDS: a crash between the archive INSERT and the overwrite leaves the previous version intact and archived', async () => {
    const inner = fakeLibraryPool()
    let crash = false
    const pool = {
      queries: inner.queries,
      async query(text, params) {
        if (crash && /INSERT INTO libraries/.test(text)) throw new Error('process died')
        return inner.query(text, params)
      },
      end: () => inner.end(),
    }
    const store = createLibraryStore(pool)
    await store.init()
    const GOOD = library(500, 'GOOD')
    await store.put(KEY, GOOD, 1, { now: 0 })

    crash = true
    await expect(store.put(KEY, library(0, 'BAD'), 2, { now: HOUR })).rejects.toThrow('process died')
    crash = false

    expect((await store.get(KEY)).data, 'the live row is untouched').toBe(GOOD)
    expect((await store.versions(KEY)).map((v) => v.data), 'and a duplicate copy is archived').toContain(GOOD)
  })

  /** No BEGIN/COMMIT is issued anywhere — every statement is its own autocommit transaction. */
  it('P3b — put issues no BEGIN, so the read, the archive and the overwrite are three separate transactions', async () => {
    const { pool, store } = await newStore()
    await store.put(KEY, library(3, 'a'), 1, { now: 0 })
    await store.put(KEY, library(4, 'b'), 2, { now: HOUR })

    expect(pool.queries.some((q) => /BEGIN/i.test(q.text)), 'put must serialise its read-modify-write').toBe(true)
  })

  /**
   * The consequence of P3b, and the real break: `put` is a read-modify-write
   * with no lock. Two overlapping pushes (she has two devices — AGENTS.md, and
   * docs/sync.md §"an older device winning a concurrent push") both read the
   * SAME previous state. The loser's data is overwritten and, because the
   * winner already spent this hour's snapshot, never archived.
   */
  it('P3c — two overlapping pushes: the second push is overwritten and never archived', async () => {
    const inner = fakeLibraryPool()
    let armed = false
    let release
    let reached
    const gate = new Promise((r) => (release = r))
    const atGate = new Promise((r) => (reached = r))
    const pool = {
      queries: inner.queries,
      async query(text, params) {
        const result = await inner.query(text, params)
        if (armed && /SELECT data, updated_at/.test(text)) {
          armed = false
          reached()
          await gate
        }
        return result
      },
      end: () => inner.end(),
    }
    const store = createLibraryStore(pool)
    await store.init()

    const BASE = library(100, 'base')
    const FROM_PHONE = library(140, 'phone')
    const FROM_IPAD = library(130, 'ipad')
    await store.put(KEY, BASE, 1, { now: 0 })

    // Phone's push starts, reads BASE, then stalls (network, GC, event loop).
    armed = true
    const phone = store.put(KEY, FROM_PHONE, 2, { now: HOUR })
    await atGate

    // iPad's push completes end to end in the meantime: archives BASE, stores FROM_IPAD.
    await store.put(KEY, FROM_IPAD, 3, { now: HOUR })
    expect((await store.get(KEY)).data).toBe(FROM_IPAD)

    // Phone resumes. Its `previous` is the stale BASE; the hour's snapshot is spent.
    release()
    await phone

    expect((await store.get(KEY)).data, 'last writer wins, as expected').toBe(FROM_PHONE)
    expect((await store.versions(KEY)).map((v) => v.data), 'claim (a): the version FROM_PHONE replaced was FROM_IPAD, and must be archived').toContain(
      FROM_IPAD,
    )
  })
})

// ---------------------------------------------------------------------------
// PROBE 4 — claim (b), the Clip store bound
// ---------------------------------------------------------------------------

describe('AUDIT-T080 probe 4 — the Clip store bound', () => {
  /**
   * `server/index.js`: `Number(env.CLIP_STORE_MAX_BYTES ?? DEFAULT)`. Nothing
   * validates the result, and `createClipStore` accepts it as given. A typo in
   * the env var ("300MB", "300_000_000", a trailing space in a Render dashboard
   * field) makes `maxBytes` NaN. Every comparison against NaN is false, so
   * `evictIfOverBudget` returns immediately, forever, with no error and no log:
   * the bound is silently off and `clips` grows until the 1 GB disk fills — at
   * which point the write that starts failing is `libraryStore.put`, the exact
   * failure the bound exists to prevent.
   */
  it('P4 — a non-numeric CLIP_STORE_MAX_BYTES silently disables the bound entirely', async () => {
    const pool = fakeClipPool()
    const maxBytes = Number('300MB') // NaN
    const clips = createClipStore(pool, { maxBytes })
    await clips.init()

    for (let i = 0; i < 400; i += 1) {
      await clips.put({ hash: `h${i}`, bytes: Buffer.alloc(30_000, 1), mime: 'audio/mpeg', durationMs: 1000, createdAt: i })
    }

    expect(await clips.totalBytes(), 'a store with an unparseable ceiling must not grow without limit').toBeLessThanOrEqual(12_000_000 * 0.95)
  })

  /**
   * The other half of the same unvalidated env var. `CLIP_STORE_MAX_BYTES` set
   * but empty (a blank field in the Render dashboard) is `''`, which is not
   * nullish, so the `??` default never applies and `Number('')` is 0. The store
   * then evicts itself to empty after every single put: the shared Clip cache
   * is permanently cold and every phrase is regenerated and re-billed forever.
   */
  it('P4b — an empty CLIP_STORE_MAX_BYTES makes the store evict itself to empty after every put', async () => {
    const pool = fakeClipPool()
    const clips = createClipStore(pool, { maxBytes: Number('') })
    await clips.init()

    for (let i = 0; i < 5; i += 1) {
      await clips.put({ hash: `h${i}`, bytes: Buffer.alloc(30_000, 1), mime: 'audio/mpeg', durationMs: 1000, createdAt: i })
    }

    expect(await clips.get('h4'), 'the clip just written must still be there').not.toBeNull()
  })

  /** HOLDS: with a numeric ceiling the sweep does bring the table back under it. */
  it('P4c — HOLDS: with a valid ceiling the store stays under it', async () => {
    const pool = fakeClipPool()
    const clips = createClipStore(pool, { maxBytes: 1_000_000, evictBatchSize: 10 })
    await clips.init()
    for (let i = 0; i < 200; i += 1) {
      await clips.put({ hash: `h${i}`, bytes: Buffer.alloc(30_000, 1), mime: 'audio/mpeg', durationMs: 1000, createdAt: i })
    }
    expect(await clips.totalBytes()).toBeLessThanOrEqual(1_000_000)
  })
})
