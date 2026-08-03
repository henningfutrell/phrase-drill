import pg from 'pg'

const { Pool } = pg

/**
 * The whole server-side persistence layer: one table, storing the same JSON
 * envelope `deckStore.exportAll()` already produces device-side
 * (`format`/`schemaVersion`/`exportedAt`/`decks`), keyed by the Keycloak
 * subject (`sub`, T043) — previously the device-generated 64-hex library
 * key, now deleted along with every caller of it.
 *
 * Postgres via `pg` (T043), replacing `node:sqlite`: Keycloak needs a real
 * database of its own to keep accounts across a restart, so Postgres is in
 * the stack regardless, and running SQLite beside it for the app's own data
 * would be two persistence models and two backup stories for one process.
 * One Postgres *instance*, two logical *databases* (`phrase_drill` for this
 * table, `keycloak` for Keycloak's own — `scripts/postgres/init-multi-db.sh`
 * creates both on the container's first boot) — not two schemas in one
 * database, because Keycloak's own migration tooling assumes it owns the
 * whole `public` schema of whatever database it's pointed at; sharing one
 * schema risks a migration collision neither side would expect. This
 * module only ever talks to `phrase_drill`.
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
