// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClipStore, createLibraryStore, createPool } from './db.js'

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
    await pool.query('DROP TABLE IF EXISTS clips, library_versions, libraries')
  })

  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS clips, library_versions, libraries')
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
})
