// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createClipStore, createLibraryStore, createPool } from './db.js'
import { createClipJobStore } from './clip-job-store.js'
import { clipJobStoreContract, jobFields } from './clip-job-store.test-support.js'
import { deleteClips } from '../scripts/clip-delete.mjs'

/**
 * The only tests here that touch a real Postgres.
 *
 * Every other server test runs against `fakePool` — which proves the code
 * calls the SQL it means to, and proves nothing at all about whether Postgres
 * accepts it. That gap is not theoretical: `ANY($1::bigint[])`,
 * `octet_length`, `ADD COLUMN IF NOT EXISTS` and the `byte_size` backfill are
 * all dialect, and a fake will happily accept SQL no database would run.
 *
 * Opt-in, because it needs a live server: set `SMOKE_DATABASE_URL` to a
 * database this may freely DROP tables in — never the real one.
 *
 *   docker compose up -d postgres
 *   SMOKE_DATABASE_URL=postgres://user:pass@host:5432/scratch npm test
 *
 * Skipped, not failed, when unset: an unavailable database is a missing
 * environment, not a broken change.
 */
const url = process.env.SMOKE_DATABASE_URL

describe.skipIf(!url)('server SQL against a real Postgres', () => {
  let pool

  beforeAll(async () => {
    pool = createPool(url)
    await pool.query('DROP TABLE IF EXISTS clip_jobs, clips, library_versions, libraries')
  })

  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS clip_jobs, clips, library_versions, libraries')
    await pool.end()
  })

  it('upgrades a clips table that shipped before byte_size existed', async () => {
    // The schema actually deployed today: no byte_size, and rows in it.
    await pool.query(`
      CREATE TABLE clips (
        hash TEXT PRIMARY KEY, bytes BYTEA NOT NULL, mime TEXT NOT NULL,
        duration_ms BIGINT NOT NULL, created_at BIGINT NOT NULL
      )`)
    await pool.query('INSERT INTO clips (hash, bytes, mime, duration_ms, created_at) VALUES ($1,$2,$3,$4,$5)', [
      'legacy',
      Buffer.alloc(5000, 7),
      'audio/mpeg',
      1000,
      1,
    ])

    const clips = createClipStore(pool, { maxBytes: 20_000, evictBatchSize: 2 })
    await clips.init()

    const { rows } = await pool.query('SELECT byte_size FROM clips WHERE hash = $1', ['legacy'])
    expect(Number(rows[0].byte_size), 'the backfill must size rows written before the column existed').toBe(5000)

    // Second boot changes nothing — the restart path, run on every deploy.
    await clips.init()
    const { rows: nulls } = await pool.query('SELECT count(*) c FROM clips WHERE byte_size IS NULL')
    expect(nulls[0].c).toBe('0')
    expect(await clips.totalBytes()).toBe(5000)
  })

  it('upgrades a clips table that shipped before last_used_at existed, backfilling from created_at', async () => {
    // The shape deployed before S8b: byte_size present, no last_used_at.
    await pool.query('DROP TABLE IF EXISTS clips')
    await pool.query(`
      CREATE TABLE clips (
        hash TEXT PRIMARY KEY, bytes BYTEA NOT NULL, mime TEXT NOT NULL,
        duration_ms BIGINT NOT NULL, created_at BIGINT NOT NULL, byte_size BIGINT
      )`)
    await pool.query('INSERT INTO clips (hash, bytes, mime, duration_ms, created_at, byte_size) VALUES ($1,$2,$3,$4,$5,$6)', [
      'legacy',
      Buffer.alloc(5000, 7),
      'audio/mpeg',
      1000,
      1,
      5000,
    ])

    const clips = createClipStore(pool, { maxBytes: 20_000, evictBatchSize: 2 })
    await clips.init()
    const { rows } = await pool.query('SELECT last_used_at FROM clips WHERE hash = $1', ['legacy'])
    expect(Number(rows[0].last_used_at), 'last used when it was made — the most a row written before the column can say').toBe(1)

    await clips.init() // every boot
    const { rows: nulls } = await pool.query('SELECT count(*) c FROM clips WHERE last_used_at IS NULL')
    expect(nulls[0].c).toBe('0')
  })

  it('bumps last_used_at on a hit at most once a day, without the hit waiting on it', async () => {
    const DAY = 24 * 60 * 60 * 1000
    const clock = { now: 0 }
    const clips = createClipStore(pool, { maxBytes: 1_000_000, now: () => clock.now, logger: { warn() {} } })
    await clips.init()
    await clips.put({ hash: 'played', bytes: Buffer.alloc(100, 1), mime: 'audio/mpeg', durationMs: 1, createdAt: 100 })
    const lastUsed = async () => Number((await pool.query('SELECT last_used_at FROM clips WHERE hash = $1', ['played'])).rows[0].last_used_at)
    expect(await lastUsed()).toBe(100)

    clock.now = 100 + DAY - 1
    await clips.get('played')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await lastUsed(), 'under a day: no write').toBe(100)

    clock.now = 100 + DAY
    await clips.get('played')
    await vi.waitFor(async () => expect(await lastUsed()).toBe(100 + DAY))
  })

  it('evicts least-recently-used, so a played old clip outlives an unplayed newer one', async () => {
    const DAY = 24 * 60 * 60 * 1000
    const clock = { now: 0 }
    await pool.query('DELETE FROM clips')
    const clips = createClipStore(pool, { maxBytes: 20_000, evictBatchSize: 2, now: () => clock.now, logger: { warn() {} } })
    await clips.init()
    await clips.put({ hash: 'old-played', bytes: Buffer.alloc(9000, 1), mime: 'audio/mpeg', durationMs: 1, createdAt: 1 })
    await clips.put({ hash: 'newer-unplayed', bytes: Buffer.alloc(9000, 2), mime: 'audio/mpeg', durationMs: 1, createdAt: 2 })
    clock.now = 2 * DAY
    await clips.get('old-played')
    await vi.waitFor(async () =>
      expect(Number((await pool.query("SELECT last_used_at FROM clips WHERE hash = 'old-played'")).rows[0].last_used_at)).toBe(2 * DAY),
    )

    await clips.put({ hash: 'newest', bytes: Buffer.alloc(9000, 3), mime: 'audio/mpeg', durationMs: 1, createdAt: 2 * DAY })

    const { rows } = await pool.query('SELECT hash FROM clips ORDER BY hash')
    expect(rows.map((r) => r.hash)).toEqual(['newest', 'old-played'])
  })

  it('evicts oldest-first to hold the ceiling', async () => {
    const clips = createClipStore(pool, { maxBytes: 20_000, evictBatchSize: 2 })
    await clips.init()
    await clips.put({ hash: 'new1', bytes: Buffer.alloc(9000, 1), mime: 'audio/mpeg', durationMs: 1, createdAt: 3 })
    await clips.put({ hash: 'new2', bytes: Buffer.alloc(9000, 2), mime: 'audio/mpeg', durationMs: 1, createdAt: 4 })

    expect(await clips.totalBytes()).toBeLessThanOrEqual(20_000)
    const { rows } = await pool.query('SELECT hash FROM clips ORDER BY created_at')
    expect(
      rows.some((r) => r.hash === 'legacy'),
      'the oldest row goes first',
    ).toBe(false)
  })

  it('deletes exactly one clip by hash, and a regenerated put for it lands', async () => {
    const clips = createClipStore(pool, { maxBytes: 1_000_000 })
    await clips.init()
    await clips.put({ hash: 'regen', bytes: Buffer.alloc(100, 1), mime: 'audio/mpeg', durationMs: 1, createdAt: 10 })
    await clips.put({ hash: 'keep', bytes: Buffer.alloc(100, 2), mime: 'audio/mpeg', durationMs: 1, createdAt: 10 })

    expect(await clips.delete('regen')).toBe(true)
    expect(await clips.delete('absent')).toBe(false)

    expect(await clips.get('regen')).toBeNull()
    expect(await clips.get('keep')).not.toBeNull()
    await clips.put({ hash: 'regen', bytes: Buffer.alloc(100, 3), mime: 'audio/mpeg', durationMs: 2, createdAt: 11 })
    expect((await clips.get('regen')).bytes[0], 'the new bytes, not the deleted ones').toBe(3)
  })

  it('prunes archived versions by count, and by bytes, never to zero', async () => {
    const lib = createLibraryStore(pool, { snapshotIntervalMs: 0, versionMaxCount: 3, versionMaxBytes: 1024 * 1024 })
    await lib.init()
    await lib.init() // idempotent, as every boot re-runs it

    const envelope = (n) => JSON.stringify({ format: 'phrase-drill-library', schemaVersion: 6, decks: [{ n }] })
    for (let i = 0; i <= 5; i++) await lib.put('k1', envelope(i), 100 + i, { now: 1000 + i * 10 })

    // Exercises ANY($1::bigint[]) and octet_length on real TEXT columns.
    const { rows } = await pool.query('SELECT id, octet_length(data) AS bytes FROM library_versions WHERE library_key = $1', ['k1'])
    expect(rows.length, 'versionMaxCount must bind').toBe(3)
    expect(rows.every((r) => Number(r.bytes) > 0)).toBe(true)
    expect((await lib.get('k1')).data, 'the current row is the newest push').toBe(envelope(5))

    const capped = createLibraryStore(pool, { snapshotIntervalMs: 0, versionMaxCount: 100, versionMaxBytes: 2000 })
    for (let i = 0; i < 5; i++) await capped.put('k2', 'y'.repeat(1500) + i, 2 + i, { now: 10 + i })
    const { rows: sized } = await pool.query(
      'SELECT COALESCE(SUM(octet_length(data)), 0) s, count(*) c FROM library_versions WHERE library_key = $1',
      ['k2'],
    )
    expect(Number(sized[0].s), 'the byte cap must bind').toBeLessThanOrEqual(2000)
    expect(Number(sized[0].c), 'but never prune the last version away').toBeGreaterThanOrEqual(1)
  })

  /**
   * T082's SQL, which the fake cannot speak for: `BEGIN`/`COMMIT`/`ROLLBACK`
   * on a checked-out client, `SELECT … FOR UPDATE`, and a prune that now also
   * selects `archived_at`. The fake serializes at `BEGIN` on one process; only
   * a real server can show what the row lock buys.
   *
   * **This test drives `libraryStore.put` (T094).** It used to issue its own
   * `SELECT … FOR UPDATE` on two raw pooled clients and never touch the store
   * at all, which made it a test of Postgres rather than of this codebase:
   * deleting `FOR UPDATE` from `readLibrary` left it green. What `FOR UPDATE`
   * actually buys is stated below, and deleting it turns this red.
   */
  it('put re-reads under the row lock, so a version committed while it waited is archived instead of overwritten', async () => {
    const lib = createLibraryStore(pool, { snapshotIntervalMs: 3_600_000 })
    await lib.init()
    await lib.put('lock', 'v1', 1, { now: 0 })

    // Another writer holds the row: it has replaced `v1` with `v2` and has not
    // committed. This is one half of the interleaving T082 closed, made
    // deterministic — a real second `put` would race and prove nothing on the
    // runs where it happened to serialize by itself.
    const holder = await pool.connect()
    // Warm the connection `put` will check out. `pool.connect()` latency on a
    // cold pool is enough for the assertion below to pass because nothing
    // raced, which is worse than no assertion.
    ;(await pool.connect()).release()
    try {
      await holder.query('BEGIN')
      await holder.query('UPDATE libraries SET data = $1, updated_at = $2 WHERE library_key = $3', ['v2', 2, 'lock'])

      let settled = false
      const put = lib.put('lock', 'v3', 3, { now: 10 }).then(() => {
        settled = true
      })

      // Genuine contention, not an accident of scheduling: without it the
      // assertion after the commit would be about two writes that never
      // overlapped.
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(settled, 'the second writer must block on the row lock, not read past it').toBe(false)

      await holder.query('COMMIT')
      await put
    } finally {
      holder.release()
    }

    // The load-bearing assertion. Without `FOR UPDATE` on `put`'s read, `put`
    // reads `v1` from its own snapshot, archives THAT, and then overwrites —
    // so `v2` exists in neither table and one device's push is simply gone.
    expect((await lib.get('lock')).data).toBe('v3')
    expect(
      (await lib.versions('lock')).map((v) => v.data),
      'the version committed while put waited must be the one it archived',
    ).toContain('v2')
  })

  it('serializes two concurrent puts on the row lock, archiving the loser instead of dropping it', async () => {
    const lib = createLibraryStore(pool, { snapshotIntervalMs: 3_600_000 })
    await lib.init()
    const envelope = (mark) => JSON.stringify({ format: 'phrase-drill-library', schemaVersion: 6, decks: [{ mark }] })

    await lib.put('race', envelope('p0'), 1, { now: 0 })

    // Warm two pooled connections, for the reason above: without this the two
    // puts below serialize by accident and the test proves nothing.
    const warm = await Promise.all([pool.connect(), pool.connect()])
    warm.forEach((client) => client.release())

    await Promise.all([lib.put('race', envelope('pA'), 2, { now: 1_000 }), lib.put('race', envelope('pB'), 3, { now: 1_001 })])

    const live = (await lib.get('race')).data
    const history = (await lib.versions('race')).map((v) => v.data)
    const everywhere = [live, ...history].join('|')
    expect(everywhere, 'neither push may be dropped without being archived').toContain('pA')
    expect(everywhere).toContain('pB')
  })

  it('archives every replaced version inside one interval, so a wipe cannot take the session with it', async () => {
    const lib = createLibraryStore(pool, { snapshotIntervalMs: 3_600_000 })
    await lib.init()
    const envelope = (mark) => JSON.stringify({ format: 'phrase-drill-library', schemaVersion: 6, decks: [{ mark }] })

    await lib.put('burst', envelope('week-old'), 1, { now: 0 })
    for (let i = 1; i <= 30; i++) await lib.put('burst', envelope(`edit-${i}`), i + 1, { now: 604_800_000 + i * 2_000 })
    await lib.put('burst', JSON.stringify({ format: 'phrase-drill-library', schemaVersion: 6, decks: [] }), 999, { now: 604_800_000 + 61_000 })

    const history = (await lib.versions('burst')).map((v) => v.data).join('|')
    expect(history, 'the state the wipe replaced must still exist').toContain('edit-30')
  })

  it('rolls the whole put back when the overwrite fails, leaving neither table half-written', async () => {
    const lib = createLibraryStore(pool, { snapshotIntervalMs: 3_600_000 })
    await lib.init()
    await lib.put('rb', 'first', 1, { now: 0 })

    const before = (await lib.versions('rb')).length
    // A `data` value Postgres will refuse: TEXT rejects a NUL byte.
    await expect(lib.put('rb', 'second bad', 2, { now: 10 })).rejects.toThrow()

    expect((await lib.get('rb')).data, 'the previous library must survive a failed put').toBe('first')
    expect((await lib.versions('rb')).length, 'and no orphan archive row may be left behind').toBe(before)

    // The pool is usable afterwards — a failed put must not leak a client.
    await lib.put('rb', 'third', 3, { now: 20 })
    expect((await lib.get('rb')).data).toBe('third')
  })

  /**
   * `scripts/clip-delete.mjs` (R2) on the real schema: both rows for the
   * named hash go, and nothing else on the instance moves — not another
   * hash, and above all not their library.
   */
  it('clip-delete removes the clip and job rows for a hash and touches no other row or table', async () => {
    const clipStore = createClipStore(pool, { maxBytes: 1_000_000 })
    await clipStore.init()
    const clipJobStore = createClipJobStore(pool)
    await clipJobStore.init()
    const lib = createLibraryStore(pool, { snapshotIntervalMs: 0 })
    await lib.init()
    await lib.put('the-user', 'library-bytes', 1, { now: 0 })
    const doomed = 'd'.repeat(64)
    const kept = 'e'.repeat(64)
    for (const hash of [doomed, kept]) {
      await clipStore.put({ hash, bytes: Buffer.alloc(10, 1), mime: 'audio/mpeg', durationMs: 1, createdAt: 1 })
      await clipJobStore.request(jobFields({ hash }), 1)
    }

    expect(await deleteClips({ clipStore, clipJobStore }, [doomed, 'f'.repeat(64)])).toEqual([
      { hash: doomed, clip: true, job: true },
      { hash: 'f'.repeat(64), clip: false, job: false },
    ])
    expect(await clipStore.get(doomed)).toBeNull()
    expect(await clipJobStore.get(doomed)).toBeNull()
    expect(await clipStore.get(kept)).not.toBeNull()
    expect(await clipJobStore.get(kept)).not.toBeNull()
    expect((await lib.get('the-user')).data).toBe('library-bytes')
  })

  /**
   * `clip_jobs` (S5): the generation queue. The contract is the same one the
   * in-memory fake passes on every `npm test`; here it runs against the SQL.
   * The two tests after it are what no fake can speak for — `FOR UPDATE SKIP
   * LOCKED` under a held lock, and the insert race on a hash's first request.
   */
  describe('clip_jobs', () => {
    async function freshJobStore() {
      await pool.query('DROP TABLE IF EXISTS clip_jobs')
      const store = createClipJobStore(pool)
      await store.init()
      await store.init() // idempotent, as every boot re-runs it
      return store
    }

    clipJobStoreContract(freshJobStore)

    it('claims past a job another instance holds locked, instead of waiting for it', async () => {
      const store = await freshJobStore()
      await store.request(jobFields({ hash: 'held' }), 1)
      await store.request(jobFields({ hash: 'free' }), 2)

      // The deploy overlap: the old instance is mid-claim on `held`.
      const other = await pool.connect()
      try {
        await other.query('BEGIN')
        await other.query("SELECT hash FROM clip_jobs WHERE hash = 'held' FOR UPDATE")
        const claimed = await store.claim(10)
        expect(claimed?.hash, 'SKIP LOCKED: the locked row is passed over, not waited on').toBe('free')
        await other.query('ROLLBACK')
      } finally {
        other.release()
      }
    })

    it('never hands one job to two concurrent claims', async () => {
      const store = await freshJobStore()
      for (const hash of ['a', 'b', 'c']) await store.request(jobFields({ hash }), 1)
      const warm = await Promise.all([pool.connect(), pool.connect(), pool.connect()])
      warm.forEach((client) => client.release())

      const claimed = await Promise.all([store.claim(10), store.claim(10), store.claim(10), store.claim(10)])
      const hashes = claimed.filter(Boolean).map((job) => job.hash)

      expect(hashes.sort()).toEqual(['a', 'b', 'c'])
    })

    it('makes one row of concurrent first requests for a hash', async () => {
      const store = await freshJobStore()
      const results = await Promise.all(Array.from({ length: 5 }, (_, i) => store.request(jobFields(), 100 + i)))

      expect(results.every((r) => r.capped === false && r.job.state === 'queued')).toBe(true)
      const { rows } = await pool.query('SELECT count(*) c FROM clip_jobs')
      expect(rows[0].c).toBe('1')
    })
  })
})
