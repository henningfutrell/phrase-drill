import pg from 'pg'
import { createLogger } from './logger.js'

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
 *
 * T082 added the part a fake is least able to speak for: `put` runs in a
 * transaction and takes `SELECT … FOR UPDATE` on the row before it reads. The
 * fake serializes at `BEGIN`, in one process, which is coarser than a row
 * lock and cannot show that Postgres blocks the second writer at all.
 * `db.postgres.test.js` checks the lock semantics directly and drives two
 * genuinely concurrent `put`s over pre-warmed pooled connections — pre-warmed
 * because `pool.connect()` latency on a cold pool is enough to make two
 * "concurrent" puts run one after another by accident, and a race test that
 * passes because nothing raced is worse than no test.
 */
export function createLibraryStore(pool, { snapshotIntervalMs, versionMaxCount, versionMaxBytes, versionRecentCount } = {}) {
  const intervalMs = snapshotIntervalMs ?? LIBRARY_VERSION_SNAPSHOT_INTERVAL_MS
  const maxCount = versionMaxCount ?? LIBRARY_VERSION_MAX_COUNT
  const maxBytes = versionMaxBytes ?? LIBRARY_VERSION_MAX_BYTES
  const recentCount = versionRecentCount ?? LIBRARY_VERSION_RECENT_COUNT

  /**
   * `db` is anything with `pg`'s `query` — the pool for a plain read, or a
   * single checked-out client when the caller is inside a transaction (T082).
   * A statement that runs on the pool inside a transaction silently runs
   * OUTSIDE it, on a different connection, so every helper `put` calls takes
   * its connection as an argument rather than closing over `pool`.
   */
  async function readLibrary(db, key, { forUpdate = false } = {}) {
    const { rows } = await db.query(
      `SELECT data, updated_at AS "updatedAt" FROM libraries WHERE library_key = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [key],
    )
    if (rows.length === 0) return null
    return { data: rows[0].data, updatedAt: Number(rows[0].updatedAt) }
  }

  async function get(key) {
    return readLibrary(pool, key)
  }

  /**
   * Brings one key's archived versions back inside the retention policy
   * (T071, reshaped by T082). Two rules, applied in order:
   *
   * **1. Thinning.** The newest `recentCount` rows are kept whatever the push
   * rate. Everything older collapses to the OLDEST row per `intervalMs`
   * bucket. This is where the snapshot throttle now lives.
   *
   * *Why it moved off the write.* T071 put the throttle on `put`: at most one
   * archive per hour. Its reasoning was right and is kept — a content-aware
   * trigger ("archive when the push shrinks") lets a bad push repeated archive
   * its own shrunken states and prune the good one out of the window, and an
   * interval nothing can accelerate is immune to that. What was wrong was the
   * *place*. The client debounces at 2 s and pushes per edit, so an hour of
   * ordinary editing is ~1,800 pushes and exactly one archive — of the OLDEST
   * state in the window. Everything she typed after the first push of the hour
   * was in the live row and nowhere else, and a wipe inside the window took
   * the lot, with two 204s and no log line. Archiving every replaced version
   * and thinning on retention gives both properties at once: nothing a wipe
   * replaces is unarchived, and a flood still cannot flush the aged history,
   * because the aged rows are one per interval however many arrived.
   *
   * *Oldest per bucket, not newest.* The row worth keeping from a burst is the
   * state it started from — what the burst has not yet touched.
   *
   * **2. The budgets.** Count and bytes, oldest first. They apply to the
   * thinned set including the recent rows, so `recentCount` buys exemption
   * from thinning and never from the disk ceiling. The newest version is never
   * a candidate however large it is: a budget that can delete the last copy is
   * the defect this table exists to fix.
   *
   * The arithmetic is here rather than in a window function so that what is
   * kept is readable, testable and obviously bounded — at a few dozen rows the
   * round trip costs nothing.
   */
  async function pruneVersions(db, key) {
    const { rows } = await db.query(
      'SELECT id, archived_at AS "archivedAt", octet_length(data) AS bytes FROM library_versions WHERE library_key = $1 ORDER BY id DESC',
      [key],
    )
    const doomed = []

    // Oldest first, so the survivor of a bucket is the state the burst began from.
    const oldestFirst = [...rows].reverse()
    // A non-positive interval means "do not thin" rather than a division by
    // zero — `snapshotIntervalMs: 0` is how a test asks for every version.
    const agedCount = intervalMs > 0 ? Math.max(0, rows.length - recentCount) : 0
    const seenBuckets = new Set()
    const kept = []
    oldestFirst.forEach((row, index) => {
      if (index >= agedCount) {
        kept.push(row)
        return
      }
      const bucket = Math.floor(Number(row.archivedAt) / intervalMs)
      if (seenBuckets.has(bucket)) {
        doomed.push(Number(row.id))
        return
      }
      seenBuckets.add(bucket)
      kept.push(row)
    })

    kept.reverse()
    let running = 0
    kept.forEach((row, index) => {
      running += Number(row.bytes)
      if (index === 0) return
      if (index >= maxCount || running > maxBytes) doomed.push(Number(row.id))
    })

    if (doomed.length > 0) await db.query('DELETE FROM library_versions WHERE id = ANY($1::bigint[])', [doomed])
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
     * off-device copy of her library by forgetting a step.
     *
     * **One transaction, and the row is locked before it is read (T082).**
     * This used to be three autocommitted `pool.query` calls, and the comment
     * here claimed no code path could replace the only copy. That claim was
     * about a *crash* between the statements and it did not survive
     * *interleaving*: two requests both read the same `previous`, both
     * archived it, and the second overwrote the first — so one device's push
     * was in neither `libraries` nor `library_versions`. Both her phones sync
     * on the same triggers (launch, reconnect, the phone being locked), so
     * that is the ordinary case, not the exotic one. `SELECT … FOR UPDATE`
     * makes the second request read what the first wrote, and archive it.
     *
     * The statement ORDER still matters and is unchanged — archive, then
     * overwrite — so a crash or a rollback anywhere in here leaves the
     * previous version in place, never both gone.
     *
     * *Residual, bounded:* `FOR UPDATE` locks a row that exists. Two
     * concurrent puts for a key with no row yet both see nothing to archive
     * and one insert wins. Nothing is lost that the server ever held, and it
     * is reachable only on the first-ever write for an account.
     *
     * **What this deliberately does not do is refuse.** The server cannot
     * tell a client bug from her genuinely deleting a deck, and the device
     * treats every status it does not recognise as `network` and retries it
     * forever — so a refusal invented here would present as a sync that says
     * "waiting" and never finishes, which is a worse failure than the one it
     * guards. Accept the push; keep what it replaced.
     *
     * **Every replaced version is archived; the interval throttle lives in
     * retention now.** See `pruneVersions` for why it moved and what T071's
     * reasoning it keeps. A push whose bytes are identical to what is stored
     * still archives nothing — there is nothing to keep.
     */
    async put(key, data, updatedAt, { now = Date.now() } = {}) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const previous = await readLibrary(client, key, { forUpdate: true })
        if (previous && previous.data !== data) {
          await client.query('INSERT INTO library_versions (library_key, data, updated_at, archived_at) VALUES ($1, $2, $3, $4)', [
            key,
            previous.data,
            previous.updatedAt,
            now,
          ])
          await pruneVersions(client, key)
        }

        await client.query(
          `INSERT INTO libraries (library_key, data, updated_at) VALUES ($1, $2, $3)
           ON CONFLICT (library_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
          [key, data, updatedAt],
        )

        await client.query('COMMIT')
      } catch (err) {
        // A rollback that itself fails must not replace the real error: the
        // caller needs to know the push did not land, and 500 is what makes
        // the device retry it.
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
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
  }
}

/**
 * The interval the AGED history is thinned to, at most one row each (T071,
 * moved from the write path to retention by T082). One hour, so no burst of
 * pushes can consume the retention window faster than the clock.
 */
export const LIBRARY_VERSION_SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000
/**
 * How many of the newest archived versions are exempt from interval thinning
 * (T082). Eight, at the client's 2 s debounce, is the last ~16 seconds of
 * editing kept at full resolution — enough that the version a wipe replaced
 * is always still there, and small enough that a flood cannot use it to push
 * older history out (the aged rows below it are one per interval regardless).
 */
export const LIBRARY_VERSION_RECENT_COUNT = 8
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
/**
 * Reads `CLIP_STORE_MAX_BYTES` into a ceiling `createClipStore` can actually
 * hold itself to (T082). It used to reach the store through a bare
 * `Number(...)`, which has two bad answers for a typo in a deploy dashboard
 * field — the only way this value is ever set:
 *
 * - `NaN` (`'300MB'`, `'abc'`) — every comparison against it is false, so the
 *   store is UNBOUNDED. `clips` then fills the 1 GB instance and the write
 *   that starts failing is `libraryStore.put`: her phrases stop reaching the
 *   server while the sync line still reads "waiting".
 * - `0` (`''`, `'0'`) — every put evicts everything, so the drill has no
 *   audio to play offline.
 *
 * **It falls back rather than refusing to boot.** This process holds the only
 * off-device copy of her library, and serving `GET /api/library` is exactly
 * what she needs most if a deploy is misconfigured; a typo that takes the app
 * down is a worse outcome than a typo that runs on the documented default.
 * The fallback is logged at error level, once, at boot.
 *
 * The floor is one clip: a ceiling below that would evict every clip on the
 * put that wrote it, which is the `0` failure wearing a plausible number.
 */
export function clipStoreMaxBytesFrom(raw, logger) {
  if (raw === undefined || raw === null) return DEFAULT_CLIP_STORE_MAX_BYTES
  const value = Number(raw)
  if (Number.isInteger(value) && value >= MIN_CLIP_STORE_MAX_BYTES) return value
  logger.error('CLIP_STORE_MAX_BYTES is not a whole number of bytes above the floor — using the default', {
    provided: String(raw),
    using: DEFAULT_CLIP_STORE_MAX_BYTES,
    floor: MIN_CLIP_STORE_MAX_BYTES,
  })
  return DEFAULT_CLIP_STORE_MAX_BYTES
}

/** One clip, generously (docs/scale.md §1 models ~45 KB each). Below this the ceiling is the `0` failure with a plausible number on it. */
const MIN_CLIP_STORE_MAX_BYTES = 128 * 1024
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
 * **Its lifetime belongs to whoever built it (T088).** The three stores in
 * this module are HANDED a pool and share it; none of them ends it. Each used
 * to expose a `close()` that called `pool.end()` on that one shared pool, so
 * closing any one store silently ended the connections the other two still
 * held — and in the server nothing ever called it, so the pool was never
 * closed at all. One owner now: `server/index.js` builds it and
 * `server/shutdown.js` ends it, once, on the way out.
 *
 * `connectionTimeoutMillis` is not optional (T055). Without it, `pg` inherits
 * the OS TCP connect timeout, so a host that silently drops packets — a wrong
 * hostname, a firewall, the wrong network — hangs for over a minute per
 * attempt with no output. Combined with `waitForDatabase`'s retry loop that
 * turns a misconfiguration into an apparently frozen process, which is
 * exactly how `scripts/useradd.mjs` was reported. Fail fast; the retry loop
 * above is what provides the patience.
 *
 * **The `error` listener is not optional either (T088).** `pg` attaches an
 * idle listener to every pooled client and re-emits its failures on the POOL
 * (`pg-pool/index.js` `makeIdleListener`), so a Postgres failover, a restart,
 * or a middlebox resetting an idle connection surfaces here. Node rethrows an
 * `'error'` event that has no listener, which ENDS THE PROCESS — so before
 * this, a routine database blip took the app down, possibly while she was
 * mid-push. This process holds the only off-device copy of her library.
 *
 * **Logging is all the handler does, and that is the whole fix.** `pg` has
 * already destroyed the bad client and removed it from the pool by the time
 * this fires (`_remove` runs before the `emit`), and the next `query`/`connect`
 * opens a fresh connection. Reconnection machinery added here would duplicate
 * what the pool does and would be the second thing to get wrong.
 *
 * The message and the driver's SQLSTATE go through the redacting logger, never
 * `console.error`, because a driver error can quote the connection string —
 * docs/server.md "Provable: no key can leak". A caller with no logger of its
 * own (`scripts/useradd.mjs`, `scripts/restore-drill.mjs`) gets one that
 * redacts this connection string's password, so the safe path is the default
 * rather than something each script has to remember.
 */
export function createPool(connectionString, { connectionTimeoutMillis = 5000, logger, write } = {}) {
  const ssl = sslConfigFor(connectionString)
  const pool = new Pool(ssl ? { connectionString, ssl, connectionTimeoutMillis } : { connectionString, connectionTimeoutMillis })
  const log = logger ?? createLogger({ secrets: [extractPassword(connectionString)], write })
  pool.on('error', (err) => {
    log.error('database pool error — the client was discarded, the pool continues', {
      error: err instanceof Error ? err.message : String(err),
      code: typeof err?.code === 'string' ? err.code : null,
    })
  })
  return pool
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
