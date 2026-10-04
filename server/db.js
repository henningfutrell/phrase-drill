import { readFileSync } from 'node:fs'
import pg from 'pg'
import { createLogger } from './logger.js'

const { Pool } = pg

/**
 * The library half of the server-side persistence layer: one table, storing
 * the same JSON envelope `deckStore.exportAll()` already produces
 * device-side (`format`/`schemaVersion`/`exportedAt`/`decks`), keyed by the
 * session's user id (`sub`, T050) — previously the Keycloak subject, and
 * before that the device-generated 64-hex library key; both deleted along
 * with every caller of them. Identity lives in Supabase Auth, not in
 * this database.
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
   * state in the window. Everything the user typed after the first push of the hour
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
     * off-device copy of their library by forgetting a step.
     *
     * **One transaction, and the row is locked before it is read (T082).**
     * This used to be three autocommitted `pool.query` calls, and the comment
     * here claimed no code path could replace the only copy. That claim was
     * about a *crash* between the statements and it did not survive
     * *interleaving*: two requests both read the same `previous`, both
     * archived it, and the second overwrote the first — so one device's push
     * was in neither `libraries` nor `library_versions`. Both their phones sync
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
     * tell a client bug from their genuinely deleting a deck, and the device
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
/**
 * `logger` receives the one warning this store emits itself (a failed
 * last-used bump); `console` for a caller that has no structured logger —
 * a CLI script, a test. `now` is the clock the bump reads.
 */
export function createClipStore(
  pool,
  { storage, maxBytes = DEFAULT_CLIP_STORE_MAX_BYTES, evictBatchSize = CLIP_EVICT_BATCH_SIZE, logger = console, now = Date.now } = {},
) {
  if (!storage) throw new Error('createClipStore needs a `storage` (supabase.storage.from(bucket)): the bytes live there, not in the table')
  const evictTo = Math.floor(maxBytes * CLIP_EVICT_TO_FRACTION)

  /**
   * Takes objects out of Storage after their rows are gone. A failure leaves
   * an orphan object — storage spent, no wrong answer possible, since nothing
   * points at it — so it is logged and never fails the request. Batches of at
   * most `STORAGE_REMOVE_BATCH_SIZE` keep each call small.
   */
  async function removeObjects(paths) {
    for (let i = 0; i < paths.length; i += STORAGE_REMOVE_BATCH_SIZE) {
      const batch = paths.slice(i, i + STORAGE_REMOVE_BATCH_SIZE)
      try {
        const { error } = await storage.remove(batch)
        if (error) throw error
      } catch (err) {
        logger.error('could not remove clip objects from storage — they are orphaned', {
          count: batch.length,
          message: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  async function totalBytes() {
    const { rows } = await pool.query('SELECT COALESCE(SUM(byte_size), 0)::bigint AS total FROM clips')
    return Number(rows[0].total)
  }

  /**
   * Brings `clips` back under the ceiling by deleting the least recently
   * used rows (T071, S8b).
   *
   * **Why a bound at all.** docs/scale.md §1 models ~89 KB of audio per
   * Phrase. A 5,000-Phrase library is ~425 MB, a 10,000-Phrase one ~848 MB,
   * and every re-pinned voice, corrected phrase or model change orphans the
   * whole previous set at a new content address forever. The deployed plan
   * (`render.yaml`, `basic-256mb`) has 1 GB. When it fills, the write that
   * starts failing is `libraryStore.put` — their phrases stop reaching the
   * server while the sync line still says "waiting". Audio is derived and
   * regenerable; the phrases are not, so the growth has to be cut here.
   *
   * **Least recently used, on `last_used_at` (S8b).** T071 chose
   * oldest-first on `created_at` because LRU "would cost a column plus a
   * write on every cache hit" and a wrongly evicted clip is "one
   * regeneration". Both premises changed. Since S5 a regeneration is a
   * *billed* call counted against a two-a-day cap, and oldest-first evicts
   * exactly the Clips the user has drilled longest — the first Decks the user built,
   * which a new device sweeps first — while keeping a Deck tried once
   * yesterday. And the write is not per hit: `get` bumps `last_used_at` at
   * most once a day per Clip, off the request path. A day is the right
   * grain for a ceiling that takes weeks to reach.
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
      const { rows } = await pool.query('SELECT hash, byte_size AS "byteSize" FROM clips ORDER BY last_used_at ASC, hash ASC LIMIT $1', [evictBatchSize])
      if (rows.length === 0) return
      const doomed = []
      for (const row of rows) {
        if (remaining <= 0) break
        doomed.push(row.hash)
        remaining -= Number(row.byteSize)
      }
      const { rows: deleted } = await pool.query('DELETE FROM clips WHERE hash = ANY($1::text[]) RETURNING storage_path AS "storagePath"', [doomed])
      await removeObjects(deleted.map((row) => row.storagePath))
    }
  }

  /**
   * Records a hit as a use, at most once a day per Clip: the `WHERE` matches
   * only a row last stamped more than a day ago, so a drill replaying the same
   * Clips writes nothing after the first hit of the day.
   *
   * Fire-and-forget, deliberately. A hit is audio the user is waiting for; the
   * bump is bookkeeping for a ceiling weeks away. Awaiting it would put a
   * write on the read path, and failing on it would turn a stored Clip into
   * an error. A failed bump is a warning — no hash, which is phrase-derived —
   * and the cost is one Clip evicted a little early.
   */
  function bumpLastUsed(hash) {
    const at = now()
    pool
      .query('UPDATE clips SET last_used_at = $2 WHERE hash = $1 AND last_used_at < $3', [hash, at, at - LAST_USED_GRAIN_MS])
      .catch((err) => logger.warn('could not record a clip as last used', { message: err instanceof Error ? err.message : String(err) }))
  }

  return {
    /**
     * Idempotent: safe on every boot, including against a database that
     * already has the table — the same `CREATE TABLE IF NOT EXISTS` rule the
     * two stores around it follow (docs/server.md "Schema: creation and
     * change").
     *
     * The row is metadata only. The audio is the object at `storage_path`
     * (the content hash) in the `clips` bucket, which is what keeps the 500 MB
     * database quota for their library. `byte_size` stays on the row so the
     * eviction ceiling sums a narrow integer column instead of listing the
     * bucket.
     */
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS clips (
          hash TEXT PRIMARY KEY,
          storage_path TEXT NOT NULL,
          mime TEXT NOT NULL,
          duration_ms BIGINT NOT NULL,
          created_at BIGINT NOT NULL,
          byte_size BIGINT NOT NULL,
          last_used_at BIGINT NOT NULL
        )
      `)
    },

    /**
     * A row whose object is gone is a miss, not a failure: the row is deleted
     * so the request regenerates the Clip. That regeneration is a billed
     * provider call, so it is logged at error level — it means the bucket and
     * the table disagree. Any other download failure throws; the row is kept.
     */
    async get(hash) {
      const { rows } = await pool.query('SELECT storage_path AS "storagePath", mime, duration_ms AS "durationMs" FROM clips WHERE hash = $1', [hash])
      if (rows.length === 0) return null
      const { data, error } = await storage.download(rows[0].storagePath)
      if (error) {
        if (!isObjectNotFound(error)) throw error
        logger.error('a clip row points at a missing storage object — dropping the row so it regenerates', { message: error.message })
        await pool.query('DELETE FROM clips WHERE hash = $1 RETURNING storage_path AS "storagePath"', [hash])
        return null
      }
      bumpLastUsed(hash)
      return { bytes: Buffer.from(await data.arrayBuffer()), mime: rows[0].mime, durationMs: Number(rows[0].durationMs) }
    },

    /**
     * Which of `hashes` the store holds, as a Set — the row alone, no
     * download and no last-used bump: being asked about is not being played.
     * Detect existing audio (#4): it is how a device finds audio already made
     * in a voice other than the one it has pinned, or with none pinned.
     */
    async held(hashes) {
      if (hashes.length === 0) return new Set()
      const { rows } = await pool.query('SELECT hash FROM clips WHERE hash = ANY($1::text[])', [hashes])
      return new Set(rows.map((row) => row.hash))
    },

    /**
     * `DO NOTHING`, not `DO UPDATE`: the address is derived from the content,
     * so a row already at this hash holds the same audio by definition. Two
     * requests that miss concurrently both generate and both write, and the
     * second write must be a no-op rather than an error or a rewrite.
     */
    async put({ hash, bytes, mime, durationMs, createdAt }) {
      // Object first, then row: a row never points at an object that does not
      // exist. The object key is the hash; "already exists" is a put that
      // died after the upload, or a concurrent double-miss — the same bytes.
      const { error } = await storage.upload(hash, bytes, { contentType: mime, upsert: false })
      if (error && !isObjectExists(error)) throw error
      await pool.query(
        `INSERT INTO clips (hash, storage_path, mime, duration_ms, created_at, byte_size, last_used_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (hash) DO NOTHING`,
        [hash, hash, mime, durationMs, createdAt, bytes.byteLength, createdAt],
      )
      await evictIfOverBudget()
    },

    /**
     * Takes one Clip out of the store on purpose — the server half of
     * **Regenerate** (R1, `app.js` `handleTtsRegenerate`). The only other
     * way a row leaves is eviction. Absent is not an error: the caller wants
     * the hash empty, and it is. Resolves `true` when a row was there —
     * `scripts/clip-delete.mjs` reports it to the operator.
     */
    async delete(hash) {
      const { rows } = await pool.query('DELETE FROM clips WHERE hash = $1 RETURNING storage_path AS "storagePath"', [hash])
      await removeObjects(rows.map((row) => row.storagePath))
      return rows.length > 0
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
 *   that starts failing is `libraryStore.put`: their phrases stop reaching the
 *   server while the sync line still reads "waiting".
 * - `0` (`''`, `'0'`) — every put evicts everything, so the drill has no
 *   audio to play offline.
 *
 * **It falls back rather than refusing to boot.** This process holds the only
 * off-device copy of their library, and serving `GET /api/library` is exactly
 * what the user needs most if a deploy is misconfigured; a typo that takes the app
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
/** How stale `last_used_at` may get before a hit writes it again: one day (S8b). */
const LAST_USED_GRAIN_MS = 24 * 60 * 60 * 1000
/** Objects per `storage.remove` call. */
const STORAGE_REMOVE_BATCH_SIZE = 200
/** Storage answers a missing object with `statusCode: '404'` (its `status` is 400). */
const isObjectNotFound = (error) => error.statusCode === '404' || error.status === 404
/** ...and a second upload of one key with `statusCode: '409'`. */
const isObjectExists = (error) => error.statusCode === '409' || error.status === 409
/** Rows read per eviction sweep: bounded so a badly over-budget table is drained in passes rather than one unbounded result set. */
const CLIP_EVICT_BATCH_SIZE = 200

/**
 * Decides the `ssl` option `pg` needs, from `DATABASE_URL` alone — no extra
 * env var. Every remote host must have a named trust rule; there is no
 * "connect unverified" fallback.
 *
 * - Supabase (`*.pooler.supabase.com`, `*.supabase.co`): verify the server
 *   certificate against the pinned Supabase root CA
 *   (`certs/supabase-prod-ca.crt`, see `certs/README.md`). `pg` verifies the
 *   hostname too, so this is verify-full.
 * - A host with no dot (`localhost`, a docker-compose service name such as
 *   `postgres`) or a loopback address: no SSL, a private link.
 * - Anything else: throws. A new remote host is a trust decision, and it is
 *   made here, in code, not by silently skipping verification.
 * - An unparsable or missing URL: `undefined`; `pg` reports its own error.
 *
 * **Keep `sslmode=` out of the app's `DATABASE_URL`.** `pg` lets the URL's
 * `sslmode` replace this `ssl` option, which would drop the pinned CA.
 * (`pg_dump` and `psql` in `scripts/` want `sslmode=require`; they ignore this.)
 */
const SUPABASE_CA_PATH = new URL('./certs/supabase-prod-ca.crt', import.meta.url)

export function sslConfigFor(connectionString) {
  if (typeof connectionString !== 'string' || connectionString.length === 0) return undefined
  let hostname
  try {
    ;({ hostname } = new URL(connectionString))
  } catch {
    return undefined
  }
  if (hostname.endsWith('.pooler.supabase.com') || hostname.endsWith('.supabase.co')) {
    return { ca: readFileSync(SUPABASE_CA_PATH, 'utf8') }
  }
  if (!hostname.includes('.') || hostname === '127.0.0.1' || hostname === '[::1]') return undefined
  throw new Error(`database host "${hostname}" has no TLS trust rule — add one to sslConfigFor in server/db.js`)
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
 * exactly how an operator script was reported. Fail fast; the retry loop
 * above is what provides the patience.
 *
 * **The `error` listener is not optional either (T088).** `pg` attaches an
 * idle listener to every pooled client and re-emits its failures on the POOL
 * (`pg-pool/index.js` `makeIdleListener`), so a Postgres failover, a restart,
 * or a middlebox resetting an idle connection surfaces here. Node rethrows an
 * `'error'` event that has no listener, which ENDS THE PROCESS — so before
 * this, a routine database blip took the app down, possibly while the user was
 * mid-push. This process holds the only off-device copy of their library.
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
 * own (`scripts/restore-drill.mjs`) gets one that
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
