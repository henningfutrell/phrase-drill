// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  createLibraryStore,
  createAuthStore,
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
} from './db.js'
import { fakeLibraryPool as fakePool, fakeClipPool } from './pool.test-support.js'

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

  it('closes by ending the pool', async () => {
    const pool = fakePool()
    const end = vi.spyOn(pool, 'end')
    const store = createLibraryStore(pool)

    await store.close()

    expect(end).toHaveBeenCalledTimes(1)
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
    // 2 s) archived exactly one state — the oldest — and left everything she
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

  it('closes by ending the pool', async () => {
    const pool = fakeClipPool()
    const end = vi.spyOn(pool, 'end')

    await createClipStore(pool).close()

    expect(end).toHaveBeenCalledTimes(1)
  })
})

/**
 * T071, against AUDIT-T068 finding 12. `clips` had no eviction, no TTL and no
 * `DELETE` anywhere in the codebase, on the same 1 GB managed Postgres as
 * `libraries`. Audio is derived and regenerable; her phrases are not, so the
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
    const alters = pool.queries.filter((q) => q.text.includes('ALTER TABLE clips'))
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

  it('evicts oldest-first down to 90% of the ceiling once a put crosses it', async () => {
    const pool = fakeClipPool()
    const store = createClipStore(pool, { maxBytes: 1_000 })
    await store.init()

    for (let i = 0; i < 11; i += 1) await store.put(clip(`clip-${i}`, 100, i))

    expect(await store.totalBytes()).toBeLessThanOrEqual(900)
    // Oldest-first, on the `created_at` the table already carried. Least
    // recently *played* would be better policy and costs a write on every
    // cache hit plus a column; on the server a wrongly evicted clip is one
    // regeneration, not an offline drill that cannot start, so it does not
    // earn that. The device's own cache is the LRU one (docs/scale.md §6).
    expect(await store.get('clip-0')).toBeNull()
    expect(await store.get('clip-10')).not.toBeNull()
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

    // The one guarantee that matters: her phrases are in `libraries` and
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
 * T082, from the T080 audit. `CLIP_STORE_MAX_BYTES` reached `createClipStore`
 * through a bare `Number(...)`, which has two bad answers for a typo in a
 * deploy dashboard field:
 *
 *   `NaN`  — every comparison against it is false, so the store is unbounded.
 *            `clips` then fills the 1 GB instance and the write that starts
 *            failing is `libraryStore.put`: her phrases stop reaching the
 *            server while the sync line still reads "waiting".
 *   `''`   — `Number('')` is 0, so every put immediately evicts everything and
 *            the drill has no audio to play offline.
 *
 * Neither is refused at boot: this process holds the only off-device copy of
 * her library, and reads of it are exactly what she would need if a deploy
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

/**
 * A minimal stand-in for a `pg` `Pool` covering `users`/`sessions` — real
 * enough to exercise `createAuthStore`'s SQL (two idempotent `CREATE TABLE
 * IF NOT EXISTS`, a unique-username insert that raises Postgres's real
 * `23505` violation code on a duplicate, and keyed session CRUD) without a
 * live Postgres.
 */
function fakeAuthPool() {
  let tablesCreated = false
  const users = new Map() // username -> row
  const sessions = new Map() // token_hash -> row
  const queries = []

  return {
    queries,
    async query(text, params = []) {
      queries.push({ text, params })
      const sql = text.trim()

      if (sql.startsWith('CREATE TABLE')) {
        tablesCreated = true
        return { rows: [] }
      }

      if (sql.startsWith('SELECT') && sql.includes('FROM users')) {
        if (!tablesCreated) throw new Error('relation "users" does not exist')
        const [username] = params
        const row = users.get(username)
        // Column aliases (`AS "passwordHash"` etc.) are applied by Postgres
        // itself, so a real query already comes back camelCase — this fake
        // shapes its rows the same way `createAuthStore`'s SQL asks for.
        return { rows: row ? [{ id: row.id, username: row.username, passwordHash: row.password_hash, createdAt: row.created_at }] : [] }
      }

      if (sql.startsWith('INSERT INTO users')) {
        if (!tablesCreated) throw new Error('relation "users" does not exist')
        const [id, username, passwordHash, createdAt] = params
        if (users.has(username)) {
          const err = new Error('duplicate key value violates unique constraint "users_username_key"')
          err.code = '23505'
          throw err
        }
        users.set(username, { id, username, password_hash: passwordHash, created_at: createdAt })
        return { rows: [] }
      }

      if (sql.startsWith('SELECT') && sql.includes('FROM sessions')) {
        if (!tablesCreated) throw new Error('relation "sessions" does not exist')
        const [tokenHash] = params
        const row = sessions.get(tokenHash)
        return { rows: row ? [{ userId: row.user_id, expiresAt: row.expires_at }] : [] }
      }

      if (sql.startsWith('INSERT INTO sessions')) {
        if (!tablesCreated) throw new Error('relation "sessions" does not exist')
        const [tokenHash, userId, createdAt, expiresAt] = params
        sessions.set(tokenHash, { token_hash: tokenHash, user_id: userId, created_at: createdAt, expires_at: expiresAt })
        return { rows: [] }
      }

      if (sql.startsWith('DELETE FROM sessions')) {
        if (!tablesCreated) throw new Error('relation "sessions" does not exist')
        const [tokenHash] = params
        sessions.delete(tokenHash)
        return { rows: [] }
      }

      throw new Error(`fakeAuthPool: unrecognized query: ${sql}`)
    },
    async end() {},
  }
}

describe('createAuthStore (Postgres) — users', () => {
  it('creates both tables idempotently, on init', async () => {
    const pool = fakeAuthPool()
    const store = createAuthStore(pool)

    await store.init()
    await store.init()

    const createCalls = pool.queries.filter((q) => q.text.trim().startsWith('CREATE TABLE'))
    expect(createCalls.length).toBe(4) // users + sessions, twice
    for (const call of createCalls) expect(call.text).toContain('IF NOT EXISTS')
  })

  it('creates a user, retrievable by username, with the password hash and nothing else guessable', async () => {
    const store = createAuthStore(fakeAuthPool())
    await store.init()

    await store.users.create({ id: 'user-1', username: 'her', passwordHash: 'scrypt:...', createdAt: 1000 })
    const row = await store.users.getByUsername('her')

    expect(row).toEqual({ id: 'user-1', username: 'her', passwordHash: 'scrypt:...', createdAt: 1000 })
  })

  it('returns null for an unknown username', async () => {
    const store = createAuthStore(fakeAuthPool())
    await store.init()

    expect(await store.users.getByUsername('nobody')).toBeNull()
  })

  it('refuses to create a second user with an existing username, rather than silently overwriting', async () => {
    const store = createAuthStore(fakeAuthPool())
    await store.init()

    await store.users.create({ id: 'user-1', username: 'her', passwordHash: 'hash-1', createdAt: 1000 })
    await expect(store.users.create({ id: 'user-2', username: 'her', passwordHash: 'hash-2', createdAt: 2000 })).rejects.toThrow()

    const row = await store.users.getByUsername('her')
    expect(row.id).toBe('user-1') // untouched by the rejected attempt
  })
})

describe('createAuthStore (Postgres) — sessions', () => {
  it('round-trips a created session through get, keyed by token hash', async () => {
    const store = createAuthStore(fakeAuthPool())
    await store.init()

    await store.sessions.create('hash-abc', 'user-1', 1000, 999_000)
    const row = await store.sessions.get('hash-abc')

    expect(row).toEqual({ userId: 'user-1', expiresAt: 999_000 })
  })

  it('returns null for an unknown token hash', async () => {
    const store = createAuthStore(fakeAuthPool())
    await store.init()

    expect(await store.sessions.get('nonexistent')).toBeNull()
  })

  it('deletes a session so it no longer resolves', async () => {
    const store = createAuthStore(fakeAuthPool())
    await store.init()

    await store.sessions.create('hash-abc', 'user-1', 1000, 999_000)
    await store.sessions.delete('hash-abc')

    expect(await store.sessions.get('hash-abc')).toBeNull()
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
