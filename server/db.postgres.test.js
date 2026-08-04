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
})
