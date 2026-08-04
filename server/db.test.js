// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createLibraryStore, createAuthStore, createClipStore, waitForDatabase, extractPassword, sslConfigFor } from './db.js'

/**
 * A minimal stand-in for a `pg` `Pool`: real enough to exercise
 * `createLibraryStore`'s SQL (an idempotent `CREATE TABLE IF NOT EXISTS`, a
 * keyed `SELECT`, an upsert `INSERT ... ON CONFLICT`) without a live
 * Postgres. `server/app.test.js` and the live `docker compose` verification
 * are what prove the real driver and a real database agree with this
 * fake's behaviour.
 */
function fakePool() {
  let tableCreated = false
  const rows = new Map()
  const queries = []

  return {
    queries,
    async query(text, params = []) {
      queries.push({ text, params })
      const sql = text.trim()

      if (sql.startsWith('CREATE TABLE')) {
        tableCreated = true
        return { rows: [] }
      }

      if (sql.startsWith('SELECT')) {
        if (!tableCreated) throw new Error('relation "libraries" does not exist')
        const [key] = params
        const row = rows.get(key)
        return { rows: row ? [{ data: row.data, updatedAt: row.updatedAt }] : [] }
      }

      if (sql.startsWith('INSERT')) {
        if (!tableCreated) throw new Error('relation "libraries" does not exist')
        const [key, data, updatedAt] = params
        rows.set(key, { data, updatedAt })
        return { rows: [] }
      }

      throw new Error(`fakePool: unrecognized query: ${sql}`)
    },
    async end() {},
  }
}

describe('createLibraryStore (Postgres)', () => {
  it('creates its table idempotently, on init, before any read', async () => {
    const pool = fakePool()
    const store = createLibraryStore(pool)

    await store.init()
    await store.init() // a second boot against an existing schema must not throw

    expect(pool.queries.filter((q) => q.text.trim().startsWith('CREATE TABLE')).length).toBe(2)
    expect(pool.queries[0].text).toContain('IF NOT EXISTS')
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
 * A minimal stand-in for a `pg` `Pool` covering `clips` (T063) — enough to
 * exercise `createClipStore`'s SQL without a live Postgres. The real driver
 * maps `bytea` to a `Buffer` in both directions, which is what this fake
 * stores and returns.
 */
function fakeClipPool() {
  let tableCreated = false
  const rows = new Map()
  const queries = []

  return {
    queries,
    async query(text, params = []) {
      queries.push({ text, params })
      const sql = text.trim()

      if (sql.startsWith('CREATE TABLE')) {
        tableCreated = true
        return { rows: [] }
      }
      if (!tableCreated) throw new Error('relation "clips" does not exist')

      if (sql.startsWith('SELECT')) {
        const row = rows.get(params[0])
        return { rows: row ? [{ bytes: row.bytes, mime: row.mime, durationMs: row.durationMs }] : [] }
      }

      if (sql.startsWith('INSERT')) {
        const [hash, bytes, mime, durationMs, createdAt] = params
        // Mirrors `ON CONFLICT (hash) DO NOTHING`: the first write for a
        // content address wins and later ones are silently no-ops.
        if (!rows.has(hash)) rows.set(hash, { bytes, mime, durationMs, createdAt })
        return { rows: [] }
      }

      throw new Error(`fakeClipPool: unrecognized query: ${sql}`)
    },
    async end() {},
  }
}

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
