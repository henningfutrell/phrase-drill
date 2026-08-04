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
 *
 * Returns `{ init, users: { getByUsername, create }, sessions: { create,
 * get, delete }, close }` — nested to match `createSessionAuth`'s seam
 * (`userStore.getByUsername`, `sessionStore.create`/`get`/`delete`) name for
 * name (T052). `server/index.js` wires `authStore.users` and
 * `authStore.sessions` in directly; `server/auth-store-contract.test.js`
 * pins that the names actually line up, which nothing did before.
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

    users: {
      async getByUsername(username) {
        const { rows } = await pool.query(
          'SELECT id, username, password_hash AS "passwordHash", created_at AS "createdAt" FROM users WHERE username = $1',
          [username],
        )
        if (rows.length === 0) return null
        return { id: rows[0].id, username: rows[0].username, passwordHash: rows[0].passwordHash, createdAt: Number(rows[0].createdAt) }
      },

      /** Throws (Postgres's own unique-violation, code `23505`) on a duplicate username — an existing account is an error, never a silent overwrite. */
      async create({ id, username, passwordHash, createdAt }) {
        await pool.query('INSERT INTO users (id, username, password_hash, created_at) VALUES ($1, $2, $3, $4)', [id, username, passwordHash, createdAt])
      },
    },

    sessions: {
      async create(tokenHash, userId, createdAt, expiresAt) {
        await pool.query('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)', [
          tokenHash,
          userId,
          createdAt,
          expiresAt,
        ])
      },

      async get(tokenHash) {
        const { rows } = await pool.query('SELECT user_id AS "userId", expires_at AS "expiresAt" FROM sessions WHERE token_hash = $1', [tokenHash])
        if (rows.length === 0) return null
        return { userId: rows[0].userId, expiresAt: Number(rows[0].expiresAt) }
      },

      async delete(tokenHash) {
        await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash])
      },
    },

    async close() {
      await pool.end()
    },
  }
}

/**
 * Decides the `ssl` option `pg` needs, from `DATABASE_URL` alone — no new
 * env var (T053, deploying to Render). Render's managed Postgres exposes
 * two hostnames for the same database: an *internal* one (`dpg-xxxx-a`, no
 * domain suffix — reachable only on Render's private network) and an
 * *external* one (`dpg-xxxx-a.<region>-postgres.render.com` — reachable
 * from anywhere, TLS required). `render.yaml` wires `DATABASE_URL` from the
 * database's `connectionString` property, which resolves to the *internal*
 * URL when the web service and the database share a region — exactly what
 * this Blueprint sets up — so the common case needs no SSL at all, same as
 * the local `docker-compose.yml` Postgres.
 *
 * The external hostname is the one case that needs an `ssl` option:
 * Render's certificate chain is not present in Node's default CA trust
 * store, so a plain `ssl: true` fails with `SELF_SIGNED_CERT_IN_CHAIN`
 * (github.com/brianc/node-postgres#2375; community.render.com/t/…/37079).
 * `rejectUnauthorized: false` is scoped to *this hostname pattern only* —
 * never a blanket default for every connection — because it's the one
 * documented, verified case where Render's own chain, not an attacker's, is
 * what's being accepted. Anyone connecting from off-platform (a one-off
 * `psql`/migration from a laptop against the External Database URL) hits
 * this same hostname and gets the same treatment, which is correct there
 * too: it's still Render's self-signed chain, not a new trust decision.
 */
export function sslConfigFor(connectionString) {
  if (typeof connectionString !== 'string' || connectionString.length === 0) return undefined
  let hostname
  try {
    ;({ hostname } = new URL(connectionString))
  } catch {
    return undefined
  }
  if (hostname.endsWith('.render.com')) return { rejectUnauthorized: false }
  return undefined
}

/**
 * Constructs the real `pg` pool used in production; tests inject their own
 * fake instead.
 *
 * `connectionTimeoutMillis` is not optional (T055). Without it, `pg` inherits
 * the OS TCP connect timeout, so a host that silently drops packets — a wrong
 * hostname, a firewall, the wrong network — hangs for over a minute per
 * attempt with no output. Combined with `waitForDatabase`'s retry loop that
 * turns a misconfiguration into an apparently frozen process, which is
 * exactly how `scripts/useradd.mjs` was reported. Fail fast; the retry loop
 * above is what provides the patience.
 */
export function createPool(connectionString, { connectionTimeoutMillis = 5000 } = {}) {
  const ssl = sslConfigFor(connectionString)
  return new Pool(ssl ? { connectionString, ssl, connectionTimeoutMillis } : { connectionString, connectionTimeoutMillis })
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
