// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  createLibraryStore,
  createClipStore,
  waitForDatabase,
  extractPassword,
  sslConfigFor,
  LIBRARY_VERSION_SNAPSHOT_INTERVAL_MS,
  LIBRARY_VERSION_MAX_COUNT,
  LIBRARY_VERSION_MAX_BYTES,
  LIBRARY_VERSION_RECENT_COUNT,
  DEFAULT_CLIP_STORE_MAX_BYTES,
  clipStoreMaxBytesFrom,
  createPool,
} from './db.js'
import { fakeLibraryPool as fakePool, fakeClipPool } from './pool.test-support.js'
import { createClipJobStore } from './clip-job-store.js'

describe('createLibraryStore (Postgres)', () => {
  it('creates its table idempotently, on init, before any read', async () => {
    const pool = fakePool()
    const store = createLibraryStore(pool)

    await store.init()
    await store.init() // a second boot against an existing schema must not throw

    // Two tables now: `libraries` and its version history (`library_versions`, T071).
    const creates = pool.queries.filter((q) => q.text.trim().startsWith('CREATE TABLE'))
    expect(creates.length).toBe(4)
    expect(creates.every((q) => q.text.includes('IF NOT EXISTS'))).toBe(true)
    expect(creates.some((q) => q.text.includes('library_versions'))).toBe(true)
  })

  it('returns null for a key with no stored library', async () => {
    const pool = fakePool()
    const store = createLibraryStore(pool)
    await store.init()

    expect(await store.get('nonexistent')).toBeNull()
  })

  it('round-trips a put through get', async () => {
    const pool = fakePool()
    const store = createLibraryStore(pool)
    await store.init()

    await store.put('sub-1', '{"format":"phrase-drill-library"}', 1000)
    const row = await store.get('sub-1')

    expect(row.data).toBe('{"format":"phrase-drill-library"}')
    expect(row.updatedAt).toBe(1000)
  })

  it('overwrites on a second put to the same key', async () => {
    const pool = fakePool()
    const store = createLibraryStore(pool)
    await store.init()

    await store.put('sub-1', '{"v":1}', 1000)
    await store.put('sub-1', '{"v":2}', 2000)
    const row = await store.get('sub-1')

    expect(row.data).toBe('{"v":2}')
    expect(row.updatedAt).toBe(2000)
  })

  it('keeps libraries for different keys independent — the cross-user isolation the whole design leans on', async () => {
    const pool = fakePool()
    const store = createLibraryStore(pool)
    await store.init()

    await store.put('sub-a', '{"v":"a"}', 1)
    await store.put('sub-b', '{"v":"b"}', 2)

    expect((await store.get('sub-a')).data).toBe('{"v":"a"}')
    expect((await store.get('sub-b')).data).toBe('{"v":"b"}')
  })

})

/**
 * T071, against AUDIT-T068 finding 10. `put` was an unconditional upsert, so
 * the row it replaced stopped existing anywhere. This is the recovery half of
 * the fix: the previous version is archived *by the store*, not by a route
 * that has to remember to, so there is no code path that overwrites the only
 * copy without keeping it.
 *
 * Retention is time-based on purpose. A content-aware trigger ("archive when
 * the push shrinks") sounds better and is worse: a repeated bad push then
 * archives its own shrunken states and prunes the good one out. A snapshot no
 * more often than once an hour cannot be accelerated by any push pattern, so
 * the worst case is bounded at "lose up to an hour of edits", whatever the
 * client does.
 */
describe('createLibraryStore — version history (T071)', () => {
  const KEY = 'sub-1'

  async function newStore() {
    const pool = fakePool()
    const store = createLibraryStore(pool)
    await store.init()
    return { pool, store }
  }

  it('archives nothing on the first put — there is no previous version to keep', async () => {
    const { store } = await newStore()
    await store.put(KEY, '{"v":1}', 1, { now: 0 })

    expect(await store.versions(KEY)).toEqual([])
  })

  it('archives the replaced version, newest first, with when it was archived', async () => {
    const { store } = await newStore()
    await store.put(KEY, '{"v":1}', 1, { now: 0 })
    await store.put(KEY, '{"v":2}', 2, { now: 10_000 })

    const versions = await store.versions(KEY)
    expect(versions.length).toBe(1)
    expect(versions[0].data).toBe('{"v":1}')
    expect(versions[0].updatedAt).toBe(1)
    expect(versions[0].archivedAt).toBe(10_000)
    expect(typeof versions[0].id).toBe('number')
  })

  it('a flood of pushes cannot flush the history — an interval collapses to the state it started in (T082)', async () => {
    // T071's property, and it still holds. What moved is where the throttle
    // is applied: every replaced version is archived, and RETENTION thins the
    // aged rows to one per interval. Before T082 the throttle was on the
    // write, which meant an hour of ordinary editing (the client debounces at
    // 2 s) archived exactly one state — the oldest — and left everything the user
    // typed afterwards recoverable from nowhere.
    const { store } = await newStore()
    await store.put(KEY, '{"v":0}', 0, { now: 0 })
    for (let i = 1; i <= 200; i += 1) {
      await store.put(KEY, `{"v":${i}}`, i, { now: i })
    }
    // One more, an interval later, so the flood is fully aged.
    await store.put(KEY, '{"v":999}', 999, { now: LIBRARY_VERSION_SNAPSHOT_INTERVAL_MS * 2 })

    const versions = await store.versions(KEY)
    // The state before the flood started — the thing worth recovering — survives.
    expect(versions.map((v) => v.data)).toContain('{"v":0}')
    // And the flood did not consume the retention window.
    expect(versions.length).toBeLessThan(LIBRARY_VERSION_RECENT_COUNT + 5)
  })

  it('keeps the newest LIBRARY_VERSION_RECENT_COUNT replaced versions however fast the pushes come (T082)', async () => {
    const { store } = await newStore()
    await store.put(KEY, '{"v":0}', 0, { now: 0 })
    for (let i = 1; i <= 200; i += 1) {
      await store.put(KEY, `{"v":${i}}`, i, { now: i })
    }

    const kept = (await store.versions(KEY)).map((v) => v.data)
    for (let i = 200 - LIBRARY_VERSION_RECENT_COUNT; i < 200; i += 1) {
      expect(kept).toContain(`{"v":${i}}`)
    }
  })

  it('takes a fresh snapshot once the interval has passed', async () => {
    const { store } = await newStore()
    await store.put(KEY, '{"v":0}', 0, { now: 0 })
    await store.put(KEY, '{"v":1}', 1, { now: 1 })
    await store.put(KEY, '{"v":2}', 2, { now: LIBRARY_VERSION_SNAPSHOT_INTERVAL_MS + 1 })

    expect((await store.versions(KEY)).map((v) => v.data)).toEqual(['{"v":1}', '{"v":0}'])
  })

  it('archives nothing when the pushed bytes are identical to what is stored', async () => {
    const { store } = await newStore()
    await store.put(KEY, '{"v":1}', 1, { now: 0 })
    await store.put(KEY, '{"v":1}', 2, { now: LIBRARY_VERSION_SNAPSHOT_INTERVAL_MS * 5 })

    expect(await store.versions(KEY)).toEqual([])
  })

  it('prunes to the newest LIBRARY_VERSION_MAX_COUNT versions', async () => {
    const { store } = await newStore()
    const total = LIBRARY_VERSION_MAX_COUNT + 5
    for (let i = 0; i <= total; i += 1) {
      await store.put(KEY, `{"v":${i}}`, i, { now: i * LIBRARY_VERSION_SNAPSHOT_INTERVAL_MS })
    }

    const versions = await store.versions(KEY)
    expect(versions.length).toBe(LIBRARY_VERSION_MAX_COUNT)
    expect(versions[0].data).toBe(`{"v":${total - 1}}`)
  })

  it('prunes on total archived bytes too, so a large library cannot fill the disk this table shares with clips', async () => {
    const pool = fakePool()
    const store = createLibraryStore(pool, { versionMaxBytes: 400 })
    await store.init()

    const big = (i) => `{"v":${i},"pad":"${'x'.repeat(100)}"}`
    for (let i = 0; i <= 12; i += 1) {
      await store.put(KEY, big(i), i, { now: i * LIBRARY_VERSION_SNAPSHOT_INTERVAL_MS })
    }

    const versions = await store.versions(KEY)
    const bytes = versions.reduce((sum, v) => sum + Buffer.byteLength(v.data), 0)
    expect(bytes).toBeLessThanOrEqual(400)
    expect(versions.length).toBeGreaterThan(0)
    // Byte budget bit before the count cap did.
    expect(versions.length).toBeLessThan(LIBRARY_VERSION_MAX_COUNT)
  })

  it('never prunes the only archived version, however large it is', async () => {
    const pool = fakePool()
    const store = createLibraryStore(pool, { versionMaxBytes: 10 })
    await store.init()

    await store.put(KEY, `{"pad":"${'x'.repeat(1_000)}"}`, 1, { now: 0 })
    await store.put(KEY, '{"v":2}', 2, { now: LIBRARY_VERSION_SNAPSHOT_INTERVAL_MS })

    expect((await store.versions(KEY)).length).toBe(1)
  })

  it('defaults the per-key history budget well under the database plan’s disk', async () => {
    // 1 GB of Postgres storage on `basic-256mb` (render.yaml), shared with
    // `clips`. 32 MB of history is ~26 copies of the largest library
    // docs/scale.md models (1.2 MB at 10,000 Phrases) and ~250 copies of a
    // 1,000-Phrase one — recovery depth that costs 3% of the disk.
    expect(LIBRARY_VERSION_MAX_BYTES).toBe(32 * 1024 * 1024)
    expect(LIBRARY_VERSION_MAX_COUNT).toBe(72)
    expect(LIBRARY_VERSION_SNAPSHOT_INTERVAL_MS).toBe(60 * 60 * 1000)
    // T082: the newest N are exempt from interval thinning, so the version a
    // wipe replaced is always still there even mid-interval.
    expect(LIBRARY_VERSION_RECENT_COUNT).toBe(8)
  })

  it('keeps each key’s history to itself', async () => {
    const { store } = await newStore()
    await store.put('sub-a', '{"a":1}', 1, { now: 0 })
    await store.put('sub-a', '{"a":2}', 2, { now: 10 })
    await store.put('sub-b', '{"b":1}', 1, { now: 0 })

    expect((await store.versions('sub-a')).map((v) => v.data)).toEqual(['{"a":1}'])
    expect(await store.versions('sub-b')).toEqual([])
  })

  it('archives before it overwrites, so a crash between the two keeps the old copy rather than losing both', async () => {
    const { pool, store } = await newStore()
    await store.put(KEY, '{"v":1}', 1, { now: 0 })
    pool.queries.length = 0
    await store.put(KEY, '{"v":2}', 2, { now: 10_000 })

    const archive = pool.queries.findIndex((q) => q.text.includes('INSERT INTO library_versions'))
    const overwrite = pool.queries.findIndex((q) => q.text.includes('INSERT INTO libraries'))
    expect(archive).toBeGreaterThanOrEqual(0)
    expect(archive).toBeLessThan(overwrite)
  })
})

describe('createClipStore (Postgres, T063)', () => {
  const BYTES = Buffer.from([0xff, 0xfb, 0x90, 0x00])

  it('creates its table idempotently, on init, before any read', async () => {
    const pool = fakeClipPool()
    const store = createClipStore(pool)

    await store.init()
    await store.init() // a second boot against an existing schema must not throw

    const creates = pool.queries.filter((q) => q.text.trim().startsWith('CREATE TABLE'))
    expect(creates.length).toBe(2)
    expect(creates[0].text).toContain('IF NOT EXISTS')
    // bytea, not text/base64: the bytes are stored as bytes (T063).
    expect(creates[0].text).toContain('BYTEA')
  })

  it('returns null for a hash it has never stored', async () => {
    const store = createClipStore(fakeClipPool())
    await store.init()

    expect(await store.get('deadbeef')).toBeNull()
  })

  it('round-trips the bytes, mime and duration under a content hash', async () => {
    const store = createClipStore(fakeClipPool())
    await store.init()

    await store.put({ hash: 'abc123', bytes: BYTES, mime: 'audio/mpeg', durationMs: 250, createdAt: 1_700_000_000_000 })

    const clip = await store.get('abc123')
    expect(Buffer.from(clip.bytes).equals(BYTES)).toBe(true)
    expect(clip.mime).toBe('audio/mpeg')
    expect(clip.durationMs).toBe(250)
  })

  // Regenerate (R1): the one way a stored Clip leaves except eviction. The
  // next put for the hash must then land — `put` is ON CONFLICT DO NOTHING,
  // so a delete that missed would leave the broken bytes served forever.
  it('deletes one clip by hash, leaving the rest, so the next put for it lands', async () => {
    const pool = fakeClipPool()
    const store = createClipStore(pool)
    await store.init()
    await store.put({ hash: 'broken', bytes: BYTES, mime: 'audio/mpeg', durationMs: 250, createdAt: 1 })
    await store.put({ hash: 'other', bytes: BYTES, mime: 'audio/mpeg', durationMs: 250, createdAt: 1 })

    expect(await store.delete('broken'), 'it says whether there was one').toBe(true)
    expect(await store.delete('never-stored'), 'absent is not an error').toBe(false)

    expect(await store.get('broken')).toBeNull()
    expect(await store.get('other')).not.toBeNull()
    await store.put({ hash: 'broken', bytes: BYTES, mime: 'audio/mpeg', durationMs: 999, createdAt: 2 })
    expect((await store.get('broken')).durationMs).toBe(999)
  })

  it('does not throw or overwrite when the same hash is written twice', async () => {
    const pool = fakeClipPool()
    const store = createClipStore(pool)
    await store.init()

    await store.put({ hash: 'abc123', bytes: BYTES, mime: 'audio/mpeg', durationMs: 250, createdAt: 1 })
    await store.put({ hash: 'abc123', bytes: BYTES, mime: 'audio/mpeg', durationMs: 250, createdAt: 2 })

    // Content-addressed: a second write for a hash is the same audio by
    // definition, so a concurrent double-miss must be a no-op, never an error.
    expect(pool.queries.some((q) => q.text.includes('ON CONFLICT (hash) DO NOTHING'))).toBe(true)
    expect((await store.get('abc123')).durationMs).toBe(250)
  })

})

/**
 * T071, against AUDIT-T068 finding 12. `clips` had no eviction, no TTL and no
 * `DELETE` anywhere in the codebase, on the same 1 GB managed Postgres as
 * `libraries`. Audio is derived and regenerable; their phrases are not, so the
 * table that can grow must be the one that gets cut — and it must be provably
 * unable to cut the other one.
 */
describe('createClipStore — the growth bound (T071)', () => {
  const clip = (hash, size, createdAt) => ({
    hash,
    bytes: Buffer.alloc(size, 1),
    mime: 'audio/mpeg',
    durationMs: 250,
    createdAt,
  })

  it('adds byte_size idempotently and backfills rows written before it existed', async () => {
    const pool = fakeClipPool()
    const store = createClipStore(pool)

    await store.init()
    await store.init()

    // The deployed database already has `clips` (T063) with no `byte_size`.
    // The change has to reach it on a redeploy with no manual step, which is
    // `ADD COLUMN IF NOT EXISTS` plus a backfill that matches nothing the
    // second time — docs/server.md "Schema: creation and change".
    const alters = pool.queries.filter((q) => q.text.includes('ALTER TABLE clips') && q.text.includes('byte_size'))
    expect(alters.length).toBe(2)
    expect(alters[0].text).toContain('ADD COLUMN IF NOT EXISTS')
    expect(pool.queries.some((q) => q.text.includes('SET byte_size = octet_length(bytes)'))).toBe(true)
  })

  it('stores nothing extra and evicts nothing while under the ceiling', async () => {
    const pool = fakeClipPool()
    const store = createClipStore(pool, { maxBytes: 1_000 })
    await store.init()

    await store.put(clip('a', 100, 1))
    await store.put(clip('b', 100, 2))

    expect(await store.get('a')).not.toBeNull()
    expect(await store.get('b')).not.toBeNull()
    expect(pool.queries.some((q) => q.text.trim().startsWith('DELETE'))).toBe(false)
  })

  it('evicts least-recently-used down to 90% of the ceiling once a put crosses it', async () => {
    const pool = fakeClipPool()
    const store = createClipStore(pool, { maxBytes: 1_000 })
    await store.init()

    for (let i = 0; i < 11; i += 1) await store.put(clip(`clip-${i}`, 100, i))

    expect(await store.totalBytes()).toBeLessThanOrEqual(900)
    // Never asked for since it was written: last used when it was stored.
    expect(await store.get('clip-0')).toBeNull()
    expect(await store.get('clip-10')).not.toBeNull()
  })

  /**
   * S8b. Oldest-first evicted the Clips the user has drilled longest — the first
   * Decks the user built, the ones the user still plays — and kept a deck the user tried
   * once yesterday. Each wrong eviction is a paid regeneration. A hit
   * records the day it was used; eviction takes the least recently used.
   */
  describe('last used (S8b)', () => {
    const DAY = 24 * 60 * 60 * 1000

    function storeAt(options) {
      const clock = { now: 1_000 }
      const pool = fakeClipPool()
      const logger = { warnings: [], warn: (msg, fields) => logger.warnings.push({ msg, fields }) }
      const store = createClipStore(pool, { maxBytes: 1_000, now: () => clock.now, logger, ...options })
      return { clock, pool, logger, store }
    }

    it('adds last_used_at idempotently and backfills it from created_at', async () => {
      const { pool, store } = storeAt()
      await store.init()
      await store.init()

      const alters = pool.queries.filter((q) => q.text.includes('ALTER TABLE clips') && q.text.includes('last_used_at'))
      expect(alters.length).toBe(2)
      expect(alters[0].text).toContain('ADD COLUMN IF NOT EXISTS last_used_at BIGINT')
      expect(pool.queries.some((q) => q.text.includes('SET last_used_at = created_at WHERE last_used_at IS NULL'))).toBe(true)
    })

    it('stamps a new clip as used when it is stored', async () => {
      const { pool, store } = storeAt()
      await store.init()
      await store.put(clip('a', 100, 77))

      expect(pool.rows.get('a').lastUsedAt).toBe(77)
    })

    it('keeps a clip that is played, and evicts the one written after it that nobody asked for', async () => {
      const { clock, store } = storeAt()
      await store.init()
      for (let i = 0; i < 9; i += 1) await store.put(clip(`clip-${i}`, 100, i))

      clock.now = 2 * DAY
      expect(await store.get('clip-0')).not.toBeNull() // the user drills it
      await new Promise((resolve) => setTimeout(resolve, 0))
      await store.put(clip('clip-9', 100, 2 * DAY))
      await store.put(clip('clip-10', 100, 2 * DAY))

      expect(await store.get('clip-0'), 'the oldest, but used today').not.toBeNull()
      expect(await store.get('clip-1'), 'never used since it was stored').toBeNull()
    })

    // One write a day per Clip, not one per hit: a drill replays the same
    // Clips over and over, and a row version per play is churn for nothing.
    it('bumps at most once per day', async () => {
      const { clock, pool, store } = storeAt()
      await store.init()
      await store.put(clip('a', 100, 0))

      clock.now = DAY - 1
      await store.get('a')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(pool.rows.get('a').lastUsedAt, 'less than a day since it was last stamped').toBe(0)

      clock.now = DAY
      await store.get('a')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(pool.rows.get('a').lastUsedAt, 'exactly a day: not yet more than one').toBe(0)

      clock.now = DAY + 1
      await store.get('a')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(pool.rows.get('a').lastUsedAt).toBe(DAY + 1)

      const bump = pool.queries.findLast((q) => q.text.includes('SET last_used_at = $2'))
      expect(bump.params).toEqual(['a', DAY + 1, 1])
    })

    it('serves the hit without waiting for the bump', async () => {
      const { pool, store } = storeAt()
      await store.init()
      await store.put(clip('a', 100, 0))
      pool.holdBump = true

      const served = await Promise.race([store.get('a'), new Promise((resolve) => setTimeout(() => resolve('waited'), 50))])

      expect(served).not.toBe('waited')
      expect(served).not.toBeNull()
    })

    it('never fails a hit because the bump failed, and says so in a warning', async () => {
      const { clock, pool, logger, store } = storeAt()
      await store.init()
      await store.put(clip('a', 100, 0))
      pool.failBump = true
      clock.now = DAY

      expect(await store.get('a')).not.toBeNull()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(logger.warnings).toHaveLength(1)
      expect(logger.warnings[0].msg).toMatch(/last.used/i)
      expect(JSON.stringify(logger.warnings[0]), 'never the hash').not.toContain('"a"')
    })
  })

  it('keeps evicting across more rows than one sweep reads', async () => {
    const pool = fakeClipPool()
    const store = createClipStore(pool, { maxBytes: 1_000, evictBatchSize: 3 })
    await store.init()

    for (let i = 0; i < 10; i += 1) await store.put(clip(`clip-${i}`, 100, i))
    // One clip that puts the store far enough over that no single sweep of
    // three rows can bring it back — the drain has to keep going.
    await store.put(clip('big', 900, 100))

    expect(await store.totalBytes()).toBeLessThanOrEqual(900)
    expect(await store.get('big')).not.toBeNull()
    expect(await store.get('clip-0')).toBeNull()
    expect(pool.queries.filter((q) => q.text.trim().startsWith('DELETE')).length).toBeGreaterThan(1)
  })

  it('never issues a statement naming any table but clips', async () => {
    const pool = fakeClipPool()
    const store = createClipStore(pool, { maxBytes: 200 })
    await store.init()
    for (let i = 0; i < 10; i += 1) await store.put(clip(`clip-${i}`, 100, i))
    await store.get('clip-9')
    await store.delete('clip-9')

    // The one guarantee that matters: their phrases are in `libraries` and
    // `library_versions` on this same instance, and nothing this store can be
    // driven to do reaches them. No identifier here is ever interpolated, so
    // the set of tables it can name is closed and this assertion is total.
    for (const { text } of pool.queries) {
      expect(text).not.toMatch(/librar/i)
      expect(text).not.toMatch(/\busers\b|\bsessions\b/i)
    }
    expect(pool.queries.some((q) => q.text.trim().startsWith('DELETE FROM clips'))).toBe(true)
  })

  it('defaults the ceiling to a number that leaves the library room on the deployed plan', async () => {
    // `basic-256mb` (render.yaml) is 1 GB of storage. docs/scale.md §1 models
    // ~89 KB per Phrase (2 Clips), so 300 MB is ~3,400 Phrases of audio —
    // more than either device can hold (200 MB ceiling, T036) — and leaves
    // ~65% of the disk for `libraries`, `library_versions`, WAL and overhead.
    expect(DEFAULT_CLIP_STORE_MAX_BYTES).toBe(300 * 1024 * 1024)
  })
})

/**
 * S5. `clip_jobs` lives on the same 1 GB instance as their phrases, and the
 * runner drives it on a timer with no request in sight. The same closure the
 * clip store has: every statement names `clip_jobs` literally, so the set of
 * tables it can reach is closed — and this asserts it over every branch the
 * store has (fresh insert, cap, requeue, claim, each outcome, reap, counts).
 * The SQL itself is exercised against a real Postgres in `db.postgres.test.js`.
 */
describe('createClipJobStore — the tables it can reach (S5)', () => {
  function recordingPool(row) {
    const queries = []
    const query = async (text) => {
      queries.push(text)
      // INSERT … ON CONFLICT DO NOTHING finds the row already there, so the
      // locked read-and-plan path runs too.
      if (/ON CONFLICT/i.test(text)) return { rows: [], rowCount: 0 }
      return { rows: [row], rowCount: 1 }
    }
    return { queries, query, connect: async () => ({ query, release() {} }) }
  }

  const row = (overrides) => ({
    hash: 'h',
    provider: 'elevenlabs',
    modelId: 'm',
    voiceId: 'v',
    lang: 'fr-FR',
    text: 'bonjour',
    state: 'done',
    attempts: 0,
    billedCalls: '0',
    windowStartedAt: '1',
    nextAttemptAt: '1',
    lastErrorKind: null,
    createdAt: '1',
    updatedAt: '1',
    ...overrides,
  })

  it('never issues a statement naming any table but clip_jobs', async () => {
    const fields = { hash: 'h', provider: 'elevenlabs', modelId: 'm', voiceId: 'v', lang: 'fr-FR', text: 'bonjour' }
    const capped = recordingPool(row({ billedCalls: '2' }))
    const requeued = recordingPool(row())

    const cappedStore = createClipJobStore(capped)
    await cappedStore.init()
    expect(await cappedStore.request(fields, 10)).toEqual({ capped: true })

    const store = createClipJobStore(requeued)
    expect((await store.request(fields, 10)).capped).toBe(false)
    await store.claim(10)
    await store.complete('h', 10)
    await store.retryLater('h', { nextAttemptAt: 20, kind: 'network' }, 10)
    await store.fail('h', 'quota', 10, { billed: false })
    await store.fail('h', 'unreadable', 10, { billed: true })
    await store.reapStale(10)
    await store.counts()
    await store.get('h')
    await store.delete('h')

    const statements = [...capped.queries, ...requeued.queries].filter((text) => !/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(text))
    expect(statements.length).toBeGreaterThan(8)
    for (const text of statements) {
      expect(text).toMatch(/\bclip_jobs\b/)
      expect(text).not.toMatch(/librar/i)
      expect(text).not.toMatch(/\busers\b|\bsessions\b/i)
      expect(text, 'the queue never writes the clip store; the runner does, through its own store').not.toMatch(/\bclips\b/)
    }
  })
})

/**
 * T082, from the T080 audit. `CLIP_STORE_MAX_BYTES` reached `createClipStore`
 * through a bare `Number(...)`, which has two bad answers for a typo in a
 * deploy dashboard field:
 *
 *   `NaN`  — every comparison against it is false, so the store is unbounded.
 *            `clips` then fills the 1 GB instance and the write that starts
 *            failing is `libraryStore.put`: their phrases stop reaching the
 *            server while the sync line still reads "waiting".
 *   `''`   — `Number('')` is 0, so every put immediately evicts everything and
 *            the drill has no audio to play offline.
 *
 * Neither is refused at boot: this process holds the only off-device copy of
 * their library, and reads of it are exactly what the user would need if a deploy
 * were misconfigured. Fall back to the documented default, loudly.
 */
describe('clipStoreMaxBytesFrom (T082)', () => {
  function recordingLogger() {
    const errors = []
    return { errors, info() {}, warn() {}, error: (message, fields) => errors.push({ message, fields }) }
  }

  it('takes a well-formed override', () => {
    const logger = recordingLogger()
    expect(clipStoreMaxBytesFrom('52428800', logger)).toBe(52_428_800)
    expect(logger.errors).toEqual([])
  })

  it('defaults when the variable is unset', () => {
    const logger = recordingLogger()
    expect(clipStoreMaxBytesFrom(undefined, logger)).toBe(DEFAULT_CLIP_STORE_MAX_BYTES)
    expect(logger.errors).toEqual([])
  })

  it.each([
    ['a typo', '300MB'],
    ['empty', ''],
    ['whitespace', '   '],
    ['zero', '0'],
    ['negative', '-1'],
    ['a fraction', '1.5'],
    ['Infinity', 'Infinity'],
    ['far below one clip', '100'],
  ])('falls back to the default, loudly, for %s', (_name, raw) => {
    const logger = recordingLogger()
    expect(clipStoreMaxBytesFrom(raw, logger)).toBe(DEFAULT_CLIP_STORE_MAX_BYTES)
    expect(logger.errors.length).toBe(1)
    expect(logger.errors[0].message).toMatch(/CLIP_STORE_MAX_BYTES/)
  })

  it('never returns a value the store cannot bound itself with', () => {
    const logger = recordingLogger()
    for (const raw of [undefined, '', 'abc', '0', '-5', 'NaN', 'Infinity', '1e999']) {
      const value = clipStoreMaxBytesFrom(raw, logger)
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThan(0)
    }
  })
})

describe('waitForDatabase', () => {
  it('resolves immediately once the pool answers a query', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    await expect(waitForDatabase(pool, { retries: 3, delayMs: 0 })).resolves.toBeUndefined()
    expect(pool.query).toHaveBeenCalledTimes(1)
  })

  it('retries with a delay while the database is not yet accepting connections, then succeeds', async () => {
    let attempts = 0
    const pool = {
      query: vi.fn().mockImplementation(() => {
        attempts += 1
        if (attempts < 3) return Promise.reject(new Error('ECONNREFUSED'))
        return Promise.resolve({ rows: [] })
      }),
    }
    const sleep = vi.fn().mockResolvedValue(undefined)

    await waitForDatabase(pool, { retries: 5, delayMs: 25, sleep })

    expect(attempts).toBe(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(25)
  })

  it('gives up and rethrows once retries are exhausted, rather than hanging forever', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) }
    const sleep = vi.fn().mockResolvedValue(undefined)

    await expect(waitForDatabase(pool, { retries: 3, delayMs: 10, sleep })).rejects.toThrow('ECONNREFUSED')
    expect(pool.query).toHaveBeenCalledTimes(3)
  })
})

describe('extractPassword', () => {
  it('pulls the password out of a postgres connection string, for redaction', () => {
    expect(extractPassword('postgres://app:hunter2@postgres:5432/phrase_drill')).toBe('hunter2')
  })

  it('returns null when there is no password segment', () => {
    expect(extractPassword('postgres://postgres:5432/phrase_drill')).toBeNull()
  })

  it('returns null for an unparsable string rather than throwing', () => {
    expect(extractPassword('not-a-url')).toBeNull()
  })

  it('returns null for a missing/undefined connection string', () => {
    expect(extractPassword(undefined)).toBeNull()
  })
})

describe('sslConfigFor (T053: Render deploy)', () => {
  it('requires no SSL for the local docker-compose hostname', () => {
    expect(sslConfigFor('postgres://phrase_drill:phrase_drill@postgres:5432/phrase_drill')).toBeUndefined()
  })

  it('requires no SSL for localhost', () => {
    expect(sslConfigFor('postgres://phrase_drill:phrase_drill@localhost:5432/phrase_drill')).toBeUndefined()
  })

  it('requires no SSL for a Render internal hostname (private network, no domain suffix)', () => {
    expect(sslConfigFor('postgres://user:pw@dpg-abc123-a:5432/phrase_drill')).toBeUndefined()
  })

  it('relaxes certificate verification, scoped to the connection, for a Render external hostname', () => {
    expect(sslConfigFor('postgres://user:pw@dpg-abc123-a.oregon-postgres.render.com:5432/phrase_drill')).toEqual({
      rejectUnauthorized: false,
    })
  })

  it('returns undefined for an unparsable connection string, rather than throwing', () => {
    expect(sslConfigFor('not-a-url')).toBeUndefined()
  })

  it('returns undefined for a missing/undefined connection string', () => {
    expect(sslConfigFor(undefined)).toBeUndefined()
  })
})

/**
 * T088. `pg` emits `error` on the POOL when an idle client's connection dies —
 * a Postgres failover, a restart, an idle-connection reset by a middlebox. In
 * Node an `'error'` event with no listener is rethrown and terminates the
 * process, so before this the routine case took the whole app down, possibly
 * while the user was mid-push. This process holds the only off-device copy of them
 * library; staying up through a database blip is the whole point.
 */
describe('createPool — a dead idle connection must not kill the process (T088)', () => {
  const URL_WITH_PASSWORD = 'postgres://phrase_drill:s3cr3t-pw@db.example:5432/phrase_drill'

  it('handles the pool error event instead of letting Node rethrow it', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const pool = createPool(URL_WITH_PASSWORD, { logger })

    expect(pool.listenerCount('error')).toBe(1)
    // With no listener this line throws and, in production, ends the process.
    expect(() => pool.emit('error', Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }))).not.toThrow()

    expect(logger.error).toHaveBeenCalledWith('database pool error — the client was discarded, the pool continues', {
      error: 'terminating connection due to administrator command',
      code: '57P01',
    })

    await pool.end()
  })

  it('logs a pool error with no code without inventing one', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const pool = createPool(URL_WITH_PASSWORD, { logger })

    pool.emit('error', new Error('read ECONNRESET'))

    expect(logger.error).toHaveBeenCalledWith('database pool error — the client was discarded, the pool continues', {
      error: 'read ECONNRESET',
      code: null,
    })

    await pool.end()
  })

  it('redacts the database password even when the caller passes no logger', async () => {
    // docs/server.md "Provable: no key can leak". A pool built by a script
    // (scripts/useradd.mjs, scripts/restore-drill.mjs) has no configured
    // logger, and a driver error message can carry the connection string.
    const written = []
    const pool = createPool(URL_WITH_PASSWORD, { write: (line) => written.push(line) })

    pool.emit('error', new Error(`connection to ${URL_WITH_PASSWORD} failed`))

    expect(written.length).toBe(1)
    expect(written[0]).not.toContain('s3cr3t-pw')
    expect(written[0]).toContain('[REDACTED]')

    await pool.end()
  })
})
