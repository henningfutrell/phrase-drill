/**
 * The clip job queue (S5): one table, `clip_jobs`, one row per Clip
 * content address that has been asked for and is not simply in the store.
 *
 * **Why a queue at all.** Generation used to happen inside the request: a
 * cache miss called ElevenLabs, and whatever went wrong was retried by the
 * server and then again by the device. Between 2026-09-02 and 2026-10-03
 * every miss failed AFTER ElevenLabs had billed a 200, and the retries turned
 * one phrase into up to nine charges with nothing stored. Two devices missing
 * the same clip at once also paid twice. A row per hash fixes both: a second
 * request for a hash joins the job already there (single flight), and the row
 * carries how many billed calls this hash has cost in the current window, so
 * the next such bug costs at most `BILLED_CALLS_PER_WINDOW` per phrase per day.
 *
 * **Why in Postgres, not a `Map`.** Production is one Render instance, but a
 * zero-downtime deploy runs the old and new instance side by side for a
 * moment. The billing count must survive the restart that a deploy is, and a
 * claim must not be taken by both instances — `FOR UPDATE SKIP LOCKED` does
 * that with the database this stack already runs.
 *
 * **It cannot reach anything else.** Every statement names `clip_jobs`
 * literally and no identifier is interpolated, so the set of tables this code
 * can touch is closed — `db.test.js` asserts it over every branch. Her phrases
 * (`libraries`, `library_versions`) share this instance; this table holds only
 * a copy of the five address fields, which are regenerable.
 *
 * Times are epoch ms in BIGINT, like `clips`. The policy that decides what a
 * request does to an existing row is `planRequest`, pure and shared with the
 * in-memory store the tests use.
 */

/** Billed provider calls one hash may cost per window. One generation, plus one regeneration of a clip later lost. */
export const BILLED_CALLS_PER_WINDOW = 2
/** The billing window, opened lazily by the first request after the last one closed — no cron. */
export const BILLING_WINDOW_MS = 24 * 60 * 60 * 1000
/**
 * How long a job may sit in `running` before it is presumed orphaned (its
 * instance died) and queued again. Well past the provider's 30 s timeout, so
 * during a deploy overlap the new instance does not take a job the old one is
 * still finishing — which would be a second billed call for one clip.
 */
export const STALE_RUNNING_MS = 120_000

const COLUMNS = `hash, provider, model_id AS "modelId", voice_id AS "voiceId", lang, text, state, attempts,
  billed_calls AS "billedCalls", window_started_at AS "windowStartedAt", next_attempt_at AS "nextAttemptAt",
  last_error_kind AS "lastErrorKind", created_at AS "createdAt", updated_at AS "updatedAt"`

/** A job as first queued: due now, nothing spent, its billing window opened now. */
export function newClipJob({ hash, provider, modelId, voiceId, lang, text }, now) {
  return {
    hash,
    provider,
    modelId,
    voiceId,
    lang,
    text,
    state: 'queued',
    attempts: 0,
    billedCalls: 0,
    windowStartedAt: now,
    nextAttemptAt: now,
    lastErrorKind: null,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * What a request for a hash does to the row already there.
 *
 * - `queued`/`running`: nothing. The caller joins the job; a re-poll must not
 *   reset its attempts or its backoff.
 * - `done`/`failed`: a new run, unless this window's billed calls are spent —
 *   then the row is left `failed` with `billing-capped` and nothing is queued.
 *   A `done` row being asked for again means the clip left the store (evicted,
 *   or its write failed); that regeneration is billed, so it counts too.
 *
 * Returns `{ capped, next }`; `next` is the row to write, or null for none.
 */
export function planRequest(row, now) {
  if (row.state === 'queued' || row.state === 'running') return { capped: false, next: null }
  const windowOver = now - row.windowStartedAt >= BILLING_WINDOW_MS
  const billedCalls = windowOver ? 0 : row.billedCalls
  const windowStartedAt = windowOver ? now : row.windowStartedAt
  if (billedCalls >= BILLED_CALLS_PER_WINDOW) {
    return { capped: true, next: { ...row, billedCalls, windowStartedAt, state: 'failed', lastErrorKind: 'billing-capped', updatedAt: now } }
  }
  return {
    capped: false,
    next: { ...row, billedCalls, windowStartedAt, state: 'queued', attempts: 0, nextAttemptAt: now, lastErrorKind: null, updatedAt: now },
  }
}

/** BIGINT columns arrive from `pg` as strings; a job is numbers. */
function toJob(row) {
  return {
    ...row,
    attempts: Number(row.attempts),
    billedCalls: Number(row.billedCalls),
    windowStartedAt: Number(row.windowStartedAt),
    nextAttemptAt: Number(row.nextAttemptAt),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  }
}

export function createClipJobStore(pool) {
  /**
   * Insert-or-plan under the row lock. The INSERT settles the first-request
   * race (concurrent first requests make one row); `FOR UPDATE` serializes a
   * re-request against the runner finishing the same job, so the plan is made
   * from the row as it is, not as it was a moment ago.
   */
  async function request(fields, now) {
    const job = newClipJob(fields, now)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const inserted = await client.query(
        `INSERT INTO clip_jobs (hash, provider, model_id, voice_id, lang, text, state, attempts, billed_calls,
           window_started_at, next_attempt_at, last_error_kind, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'queued', 0, 0, $7, $7, NULL, $7, $7)
         ON CONFLICT (hash) DO NOTHING
         RETURNING ${COLUMNS}`,
        [job.hash, job.provider, job.modelId, job.voiceId, job.lang, job.text, now],
      )
      if (inserted.rows.length > 0) {
        await client.query('COMMIT')
        return { capped: false, job: toJob(inserted.rows[0]) }
      }

      const { rows } = await client.query(`SELECT ${COLUMNS} FROM clip_jobs WHERE hash = $1 FOR UPDATE`, [job.hash])
      if (rows.length === 0) {
        // Pruned between the INSERT and the read: start again, and the INSERT wins.
        await client.query('COMMIT')
        return request(fields, now)
      }
      const plan = planRequest(toJob(rows[0]), now)
      if (plan.next) {
        const n = plan.next
        await client.query(
          `UPDATE clip_jobs SET state = $2, attempts = $3, billed_calls = $4, window_started_at = $5,
             next_attempt_at = $6, last_error_kind = $7, updated_at = $8
           WHERE hash = $1`,
          [n.hash, n.state, n.attempts, n.billedCalls, n.windowStartedAt, n.nextAttemptAt, n.lastErrorKind, n.updatedAt],
        )
      }
      await client.query('COMMIT')
      return plan.capped ? { capped: true } : { capped: false, job: plan.next ?? toJob(rows[0]) }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  return {
    /** Idempotent: `CREATE TABLE IF NOT EXISTS`, the rule every store here follows (docs/server.md "Schema: creation and change"). */
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS clip_jobs (
          hash TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          model_id TEXT NOT NULL,
          voice_id TEXT NOT NULL,
          lang TEXT NOT NULL,
          text TEXT NOT NULL,
          state TEXT NOT NULL,
          attempts INTEGER NOT NULL,
          billed_calls INTEGER NOT NULL,
          window_started_at BIGINT NOT NULL,
          next_attempt_at BIGINT NOT NULL,
          last_error_kind TEXT,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        )
      `)
    },

    request,

    /**
     * The row for `hash` as it is, or null — a read, not a request: nothing
     * is queued, planned or written. Regenerate (R1) needs to know whether a
     * job is in flight, and whether the hash is capped, BEFORE it deletes the
     * stored Clip; `request()` decides and writes in one step, too late.
     */
    async get(hash) {
      const { rows } = await pool.query(`SELECT ${COLUMNS} FROM clip_jobs WHERE hash = $1`, [hash])
      return rows.length > 0 ? toJob(rows[0]) : null
    },

    /**
     * Removes the row for `hash`, and with it the hash's billing count —
     * resolves `true` if there was one. Only the operator does this
     * (`scripts/clip-delete.mjs`): it is what lets a capped or failed hash be
     * generated again today, deliberately.
     */
    async delete(hash) {
      const { rowCount } = await pool.query('DELETE FROM clip_jobs WHERE hash = $1', [hash])
      return rowCount > 0
    },

    /**
     * The oldest due job, now `running`, or null. `SKIP LOCKED` so that two
     * instances overlapping during a deploy each take a different job rather
     * than one waiting on — and then repeating — the other's.
     */
    async claim(now) {
      const { rows } = await pool.query(
        `UPDATE clip_jobs SET state = 'running', updated_at = $1
         WHERE hash = (
           SELECT hash FROM clip_jobs WHERE state = 'queued' AND next_attempt_at <= $1
           ORDER BY created_at, hash FOR UPDATE SKIP LOCKED LIMIT 1
         )
         RETURNING ${COLUMNS}`,
        [now],
      )
      return rows.length > 0 ? toJob(rows[0]) : null
    },

    /** Stored. Every completion was a billed 2xx, so it counts against the window. */
    async complete(hash, now) {
      await pool.query(
        `UPDATE clip_jobs SET state = 'done', billed_calls = billed_calls + 1, last_error_kind = NULL, updated_at = $2 WHERE hash = $1`,
        [hash, now],
      )
    },

    /** A failure ElevenLabs did not bill, to be tried again at `nextAttemptAt`. */
    async retryLater(hash, { nextAttemptAt, kind }, now) {
      await pool.query(
        `UPDATE clip_jobs SET state = 'queued', attempts = attempts + 1, next_attempt_at = $2, last_error_kind = $3, updated_at = $4 WHERE hash = $1`,
        [hash, nextAttemptAt, kind, now],
      )
    },

    /** Terminal for this run. `billed` when the provider charged for the call that failed. */
    async fail(hash, kind, now, { billed = false } = {}) {
      await pool.query(
        `UPDATE clip_jobs SET state = 'failed', billed_calls = billed_calls + $2, last_error_kind = $3, updated_at = $4 WHERE hash = $1`,
        [hash, billed ? 1 : 0, kind, now],
      )
    },

    /**
     * Requeues orphaned `running` jobs and prunes finished ones. A finished row
     * is kept until its billing window is over, not deleted on completion: its
     * `billed_calls` is the cap, and a row pruned early is a cap forgotten.
     * That bounds the table at the hashes asked for in the last day.
     */
    async reapStale(now) {
      await pool.query(
        `UPDATE clip_jobs SET state = 'queued', next_attempt_at = $1, updated_at = $1
         WHERE state = 'running' AND updated_at <= $2`,
        [now, now - STALE_RUNNING_MS],
      )
      await pool.query(`DELETE FROM clip_jobs WHERE state IN ('done', 'failed') AND window_started_at <= $1`, [now - BILLING_WINDOW_MS])
    },

    /** For `/api/status`: how much is waiting, in flight, and given up on. */
    async counts() {
      const { rows } = await pool.query(
        `SELECT state, count(*)::int AS n FROM clip_jobs WHERE state IN ('queued', 'running', 'failed') GROUP BY state`,
      )
      const counts = { queued: 0, running: 0, failed: 0 }
      for (const row of rows) if (row.state in counts) counts[row.state] = Number(row.n)
      return counts
    },
  }
}
