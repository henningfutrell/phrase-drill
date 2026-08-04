import pg from 'pg'

const { Pool } = pg

/**
 * The library half of the server-side persistence layer: one table, storing
 * the same JSON envelope `deckStore.exportAll()` already produces
 * device-side (`format`/`schemaVersion`/`exportedAt`/`decks`), keyed by the
 * session's user id (`sub`, T050) — previously the Keycloak subject, and
 * before that the device-generated 64-hex library key; both deleted along
 * with every caller of them. `createAuthStore` below is the other half
 * (`users`/`sessions`, T050) — same one Postgres instance, one database
 * (`phrase_drill`), no second logical database for a vendor identity
 * provider's own schema any more.
 *
 * `createLibraryStore` takes an already-constructed pool (or, in tests, a
 * fake with the same `query`/`end` shape) rather than a connection string,
 * so the SQL and its mapping to `{data, updatedAt}` can be pinned in a unit
 * test with no live database — see `db.test.js`'s `fakePool`. The real
 * driver, a real Postgres, and this SQL agreeing is what `server/app.test.js`
 * plus the live `docker compose` verification prove.
 */
export function createLibraryStore(pool) {
  return {
    /** Idempotent: safe to call on every boot, including against a database that already has the table. */
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS libraries (
          library_key TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          updated_at BIGINT NOT NULL
        )
      `)
    },

    async get(key) {
      const { rows } = await pool.query('SELECT data, updated_at AS "updatedAt" FROM libraries WHERE library_key = $1', [key])
      if (rows.length === 0) return null
      return { data: rows[0].data, updatedAt: Number(rows[0].updatedAt) }
    },

    async put(key, data, updatedAt) {
      await pool.query(
        `INSERT INTO libraries (library_key, data, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (library_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
        [key, data, updatedAt],
      )
    },

    async close() {
      await pool.end()
    },
  }
}

/**
 * Identity storage for T050 (replacing Keycloak + the JWT it issued): two
 * tables, `users` (one row per account, created only by `scripts/useradd.mjs`
 * — there is no signup endpoint) and `sessions` (one row per issued token,
 * looked up by the token's SHA-256 hash — never the token itself, so a
 * database leak yields nothing usable). `server/session-auth.js` is the only
 * caller; it owns hashing and expiry logic, this module is SQL only, same
 * split as `createLibraryStore` above.
 */
export function createAuthStore(pool) {
  return {
    /** Idempotent: safe on every boot, including against a database that already has both tables. */
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          created_at BIGINT NOT NULL
        )
      `)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          expires_at BIGINT NOT NULL
        )
      `)
    },

    async getUserByUsername(username) {
      const { rows } = await pool.query('SELECT id, username, password_hash AS "passwordHash", created_at AS "createdAt" FROM users WHERE username = $1', [
        username,
      ])
      if (rows.length === 0) return null
      return { id: rows[0].id, username: rows[0].username, passwordHash: rows[0].passwordHash, createdAt: Number(rows[0].createdAt) }
    },

    /** Throws (Postgres's own unique-violation, code `23505`) on a duplicate username — an existing account is an error, never a silent overwrite. */
    async createUser({ id, username, passwordHash, createdAt }) {
      await pool.query('INSERT INTO users (id, username, password_hash, created_at) VALUES ($1, $2, $3, $4)', [id, username, passwordHash, createdAt])
    },

    async createSession(tokenHash, userId, createdAt, expiresAt) {
      await pool.query('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)', [
        tokenHash,
        userId,
        createdAt,
        expiresAt,
      ])
    },

    async getSession(tokenHash) {
      const { rows } = await pool.query('SELECT user_id AS "userId", expires_at AS "expiresAt" FROM sessions WHERE token_hash = $1', [tokenHash])
      if (rows.length === 0) return null
      return { userId: rows[0].userId, expiresAt: Number(rows[0].expiresAt) }
    },

    async deleteSession(tokenHash) {
      await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash])
    },

    async close() {
      await pool.end()
    },
  }
}

/** Constructs the real `pg` pool used in production; tests inject their own fake instead. */
export function createPool(connectionString) {
  return new Pool({ connectionString })
}

/**
 * Blocks until `pool` answers a trivial query, retrying with a fixed delay —
 * the fix for Docker Compose starting every service concurrently: Postgres
 * may not yet be accepting connections the instant this process boots.
 * A `healthcheck` on the `postgres` service plus `depends_on: condition:
 * service_healthy` (docker-compose.yml) already delays *starting* this
 * container until Postgres reports healthy; this loop is the second,
 * in-process line of defense for the same race (e.g. a plain `docker run`
 * with no compose healthchecks at all) — retry, never a blind `sleep`.
 */
export async function waitForDatabase(pool, { retries = 30, delayMs = 1000, sleep = defaultSleep } = {}) {
  let lastErr
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query('SELECT 1')
      return
    } catch (err) {
      lastErr = err
      if (attempt < retries) await sleep(delayMs)
    }
  }
  throw lastErr
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Pulls the password out of a `postgres://user:pass@host:port/db` connection
 * string, for the logger's `secrets` list (T043 "extend the redacting logger
 * to also redact the database URL's password") — never throws, since a
 * malformed/absent string just means nothing to redact, not a boot failure.
 */
export function extractPassword(connectionString) {
  if (typeof connectionString !== 'string' || connectionString.length === 0) return null
  try {
    const { password } = new URL(connectionString)
    return password.length > 0 ? password : null
  } catch {
    return null
  }
}
