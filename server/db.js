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
 * test with no live database — see `db.test.js`'s `fakePool`.
 *
 * A fake proves this code calls the SQL it means to. It cannot prove Postgres
 * accepts that SQL, and `app.test.js` cannot either — it uses the same fake,
 * so citing it here was circular. `db.postgres.test.js` is the one that runs
 * against a live server, opt-in via `SMOKE_DATABASE_URL`, and it is where the
 * dialect (`ANY($1::bigint[])`, `octet_length`, the `byte_size` backfill) is
 * actually verified.
 */
export function createLibraryStore(pool, { snapshotIntervalMs, versionMaxCount, versionMaxBytes } = {}) {
  const intervalMs = snapshotIntervalMs ?? LIBRARY_VERSION_SNAPSHOT_INTERVAL_MS
  const maxCount = versionMaxCount ?? LIBRARY_VERSION_MAX_COUNT
  const maxBytes = versionMaxBytes ?? LIBRARY_VERSION_MAX_BYTES

  async function get(key) {
    const { rows } = await pool.query('SELECT data, updated_at AS "updatedAt" FROM libraries WHERE library_key = $1', [key])
    if (rows.length === 0) return null
    return { data: rows[0].data, updatedAt: Number(rows[0].updatedAt) }
  }

  /** Milliseconds since the newest archived version for this key, or `null` if there is none. */
  async function lastArchivedAt(key) {
    const { rows } = await pool.query('SELECT archived_at AS "archivedAt" FROM library_versions WHERE library_key = $1 ORDER BY id DESC LIMIT 1', [
      key,
    ])
    return rows.length === 0 ? null : Number(rows[0].archivedAt)
  }

  /**
   * Drops the oldest archived versions for one key until both budgets hold.
   * The arithmetic is here rather than in a window function so that what is
   * kept is readable, testable and obviously bounded — at a few dozen rows
   * the round trip costs nothing, and it only runs on the puts that archived.
   *
   * The newest version is never a candidate, however large it is: a budget
   * that can delete the last copy is the defect this table exists to fix.
   */
  async function pruneVersions(key) {
    const { rows } = await pool.query('SELECT id, octet_length(data) AS bytes FROM library_versions WHERE library_key = $1 ORDER BY id DESC', [key])
    const doomed = []
    let running = 0
    rows.forEach((row, index) => {
      running += Number(row.bytes)
      if (index === 0) return
      if (index >= maxCount || running > maxBytes) doomed.push(Number(row.id))
    })
    if (doomed.length > 0) await pool.query('DELETE FROM library_versions WHERE id = ANY($1::bigint[])', [doomed])
  }

  return {
    /** Idempotent: safe to call on every boot, including against a database that already has the tables. */
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS libraries (
          library_key TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          updated_at BIGINT NOT NULL
        )
      `)
      // T071. Same `CREATE TABLE IF NOT EXISTS` rule as every other table
      // here, so the already-deployed database gets it on its next restart
      // with no manual step and no existing row touched.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS library_versions (
          id BIGSERIAL PRIMARY KEY,
          library_key TEXT NOT NULL,
          data TEXT NOT NULL,
          updated_at BIGINT NOT NULL,
          archived_at BIGINT NOT NULL
        )
      `)
      await pool.query('CREATE INDEX IF NOT EXISTS library_versions_key_idx ON library_versions (library_key, id DESC)')
    },

    get,

    /**
     * Writes the new library, keeping the one it replaces (T071).
     *
     * **Archiving is not the caller's job.** It happens inside `put`, before
     * the overwrite, so there is no route or script that can replace the only
     * off-device copy of her library by forgetting a step. A crash between
     * the two statements leaves the previous version archived and the new one
     * unwritten — a duplicate at worst, never a loss, which is why they are
     * in this order and why they do not need a transaction.
     *
     * **What this deliberately does not do is refuse.** The server cannot
     * tell a client bug from her genuinely deleting a deck, and the device
     * treats every status it does not recognise as `network` and retries it
     * forever — so a refusal invented here would present as a sync that says
     * "waiting" and never finishes, which is a worse failure than the one it
     * guards. Accept the push; keep what it replaced.
     *
     * **Snapshots are throttled by time, not by content.** A content-aware
     * trigger ("archive when the push shrinks") is the tempting version and
     * is worse: a bad push repeated then archives its own shrunken states and
     * prunes the good one out of the window. At most one snapshot per
     * `snapshotIntervalMs` cannot be accelerated by any push pattern, so the
     * worst case is bounded at "lose up to an hour of edits" whatever the
     * client does.
     */
    async put(key, data, updatedAt, { now = Date.now() } = {}) {
      const previous = await get(key)
      if (previous && previous.data !== data) {
        const archivedAt = await lastArchivedAt(key)
        if (archivedAt === null || now - archivedAt >= intervalMs) {
          await pool.query('INSERT INTO library_versions (library_key, data, updated_at, archived_at) VALUES ($1, $2, $3, $4)', [
            key,
            previous.data,
            previous.updatedAt,
            now,
          ])
          await pruneVersions(key)
        }
      }

      await pool.query(
        `INSERT INTO libraries (library_key, data, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (library_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
        [key, data, updatedAt],
      )
    },

    /**
     * Every retained prior version for one key, newest first — the recovery
     * path. Scoped to the key throughout: one user's history is never
     * reachable from another's session. See docs/server.md "Recovering a
     * library a bad push destroyed" for the operator procedure.
     */
    async versions(key) {
      const { rows } = await pool.query(
        'SELECT id, data, updated_at AS "updatedAt", archived_at AS "archivedAt" FROM library_versions WHERE library_key = $1 ORDER BY id DESC',
        [key],
      )
      return rows.map((row) => ({ id: Number(row.id), data: row.data, updatedAt: Number(row.updatedAt), archivedAt: Number(row.archivedAt) }))
    },

    async close() {
      await pool.end()
    },
  }
}

/**
 * How often a prior version is snapshotted, at most (T071). One hour: the
 * worst case a bad push can cost is an hour of edits, and no burst of pushes
 * can consume the retention window faster than the clock.
 */
export const LIBRARY_VERSION_SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000
/** Retained snapshots per key — 72 hourly snapshots is three days of history. */
export const LIBRARY_VERSION_MAX_COUNT = 72
/**
 * Retained bytes per key. 32 MB of the deployed plan's 1 GB (render.yaml,
 * `basic-256mb`) — ~26 copies of the largest library docs/scale.md models
 * (1.2 MB at 10,000 Phrases), ~250 copies of a 1,000-Phrase one. Whichever
 * of the two budgets binds first wins, so a big library trades depth for
 * size automatically instead of quietly filling the disk `clips` shares.
 */
export const LIBRARY_VERSION_MAX_BYTES = 32 * 1024 * 1024

/**
 * The shared Clip store (T063): generated audio, keyed by the content
 * address `server/clip-hash.js` derives — the same address the device
 * computes for its own IndexedDB cache. One table, `clips`.
 *
 * **Why it exists.** Before this, `/api/tts` proxied straight through to
 * ElevenLabs, so the same phrase in the same voice was generated and paid
 * for again on every device and after every reinstall. The device's cache
 * was the only copy there was. It still exists and still makes the drill
 * work offline — it is now a local copy of a shared store, not the only one.
 *
 * **Why `bytea` and not an object store.** One user, a few thousand clips at
 * ~10-30 KB each: tens of megabytes, in a Postgres this stack already runs.
 * An object store is a second service to run, a second credential to rotate,
 * and a second thing to be down, for no gain at this size.
 *
 * **Not keyed by user, deliberately.** The address is a hash of the exact
 * provider, model, voice, language and text; identical inputs are identical
 * audio, so a per-user copy would be the same bytes stored twice. Reaching a
 * stored clip requires already knowing all five fields, so sharing the row
 * discloses nothing a caller did not already have.
 */
export function createClipStore(pool, { maxBytes = DEFAULT_CLIP_STORE_MAX_BYTES, evictBatchSize = CLIP_EVICT_BATCH_SIZE } = {}) {
  const evictTo = Math.floor(maxBytes * CLIP_EVICT_TO_FRACTION)

  async function totalBytes() {
    const { rows } = await pool.query('SELECT COALESCE(SUM(byte_size), 0)::bigint AS total FROM clips')
    return Number(rows[0].total)
  }

  /**
   * Brings `clips` back under the ceiling by deleting the oldest rows (T071).
   *
   * **Why a bound at all.** docs/scale.md §1 models ~89 KB of audio per
   * Phrase. A 5,000-Phrase library is ~425 MB, a 10,000-Phrase one ~848 MB,
   * and every re-pinned voice, corrected phrase or model change orphans the
   * whole previous set at a new content address forever. The deployed plan
   * (`render.yaml`, `basic-256mb`) has 1 GB. When it fills, the write that
   * starts failing is `libraryStore.put` — her phrases stop reaching the
   * server while the sync line still says "waiting". Audio is derived and
   * regenerable; the phrases are not, so the growth has to be cut here.
   *
   * **Oldest-first, on the `created_at` the table already has.** Least
   * recently *played* is better policy and would cost a column plus a write
   * on every cache hit. On the server a wrongly evicted clip is one
   * regeneration; on the device it is a drill that cannot start offline,
   * which is why the device's cache is the LRU one (docs/scale.md §6) and
   * this one is not.
   *
   * **It cannot reach `libraries`.** Every statement here names `clips`
   * literally and no identifier is ever interpolated, so the set of tables
   * this code can touch is closed — `db.test.js` asserts it over every query
   * the store issues.
   */
  async function evictIfOverBudget() {
    if ((await totalBytes()) <= maxBytes) return
    let remaining = (await totalBytes()) - evictTo
    while (remaining > 0) {
      const { rows } = await pool.query('SELECT hash, byte_size AS "byteSize" FROM clips ORDER BY created_at ASC, hash ASC LIMIT $1', [evictBatchSize])
      if (rows.length === 0) return
      const doomed = []
      for (const row of rows) {
        if (remaining <= 0) break
        doomed.push(row.hash)
        remaining -= Number(row.byteSize)
      }
      await pool.query('DELETE FROM clips WHERE hash = ANY($1::text[])', [doomed])
    }
  }

  return {
    /**
     * Idempotent: safe on every boot, including against a database that
     * already has the table — the same `CREATE TABLE IF NOT EXISTS` rule the
     * two stores around it follow (docs/server.md "Schema: creation and
     * change"). Adding this table needs no migration runner and no manual
     * step: a running deployment gets it on its next restart, and it touches
     * no existing row.
     *
     * `byte_size` (T071) is the one column added after the table shipped, so
     * it follows the documented shape for that: `ADD COLUMN IF NOT EXISTS`
     * plus a backfill whose `WHERE` matches nothing once it has run. Summing
     * a narrow integer column is a cheap scan of the heap tuples; summing
     * `octet_length(bytes)` would detoast every clip on every cache miss,
     * and `pg_total_relation_size` does not shrink after a DELETE until
     * VACUUM, which would make the eviction loop empty the table.
     */
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS clips (
          hash TEXT PRIMARY KEY,
          bytes BYTEA NOT NULL,
          mime TEXT NOT NULL,
          duration_ms BIGINT NOT NULL,
          created_at BIGINT NOT NULL,
          byte_size BIGINT
        )
      `)
      await pool.query('ALTER TABLE clips ADD COLUMN IF NOT EXISTS byte_size BIGINT')
      await pool.query('UPDATE clips SET byte_size = octet_length(bytes) WHERE byte_size IS NULL')
    },

    async get(hash) {
      const { rows } = await pool.query('SELECT bytes, mime, duration_ms AS "durationMs" FROM clips WHERE hash = $1', [hash])
      if (rows.length === 0) return null
      return { bytes: rows[0].bytes, mime: rows[0].mime, durationMs: Number(rows[0].durationMs) }
    },

    /**
     * `DO NOTHING`, not `DO UPDATE`: the address is derived from the content,
     * so a row already at this hash holds the same audio by definition. Two
     * requests that miss concurrently both generate and both write, and the
     * second write must be a no-op rather than an error or a rewrite.
     */
    async put({ hash, bytes, mime, durationMs, createdAt }) {
      await pool.query(
        `INSERT INTO clips (hash, bytes, mime, duration_ms, created_at, byte_size) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (hash) DO NOTHING`,
        [hash, bytes, mime, durationMs, createdAt, bytes.byteLength],
      )
      await evictIfOverBudget()
    },

    /** Live size of the store, for the eviction loop and for anyone asking how close the ceiling is. */
    totalBytes,

    async close() {
      await pool.end()
    },
  }
}

/**
 * The ceiling on the shared Clip store (T071). 300 MB of the deployed plan's
 * 1 GB (`render.yaml`, `basic-256mb`): ~3,400 Phrases of audio at the ~89
 * KB/Phrase docs/scale.md §1 models — more than either device's own 200 MB
 * cache can hold (T036) — and it leaves ~65% of the disk for `libraries`,
 * `library_versions`, WAL and Postgres's own overhead. Override with
 * `CLIP_STORE_MAX_BYTES` if the plan changes.
 */
export const DEFAULT_CLIP_STORE_MAX_BYTES = 300 * 1024 * 1024
/** Evict past the ceiling, not to it — the same 90% hysteresis the device's cache uses (docs/scale.md §6), so one sweep is not one delete per put. */
const CLIP_EVICT_TO_FRACTION = 0.9
/** Rows read per eviction sweep: bounded so a badly over-budget table is drained in passes rather than one unbounded result set. */
const CLIP_EVICT_BATCH_SIZE = 200

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
