// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createLibraryStore, waitForDatabase, extractPassword } from './db.js'

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
