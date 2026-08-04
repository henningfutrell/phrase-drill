/**
 * In-memory stand-ins for a `pg` `Pool`, shared by `server/db.test.js` and
 * `server/app.test.js` (T071).
 *
 * They used to be two hand-written copies, one per test file, and the copies
 * had already drifted — `db.test.js`'s recorded its queries, `app.test.js`'s
 * did not, and each modelled a slightly different subset of the SQL. A fake
 * that models the schema *differently* from the fake the other suite uses is
 * two claims about one database, and the weaker one is the one that stays
 * green. One implementation, imported by both.
 *
 * These are still fakes: they model the statements `server/db.js` actually
 * issues, not Postgres. A real driver, a real Postgres and this SQL agreeing
 * is what the live `docker compose` verification proves — see `db.js`.
 */

/** Which table a statement touches, from the one clause that names it. */
function tableOf(sql) {
  return /(?:FROM|INTO|UPDATE|TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_]+)/i.exec(sql)?.[1] ?? null
}

/** Collapses whitespace so a multi-line template literal matches like one line. */
function flatten(text) {
  return text.trim().replace(/\s+/g, ' ')
}

/**
 * `libraries` plus its version history (`library_versions`, T071). Modelled
 * closely enough that retention — the hourly snapshot throttle and the
 * count/byte prune — is exercised against real ordering, not stubbed out.
 */
export function fakeLibraryPool() {
  const created = new Set()
  const libraries = new Map()
  const versions = []
  const queries = []
  let nextId = 1
  let failPattern = null

  // T082. `put` now runs archive-and-overwrite inside one transaction that
  // takes `SELECT … FOR UPDATE` on the row first, so this fake has to model a
  // transaction or the concurrency test would prove nothing.
  //
  // It serializes at `BEGIN` rather than at the `FOR UPDATE`, which is
  // COARSER than Postgres — the real lock is per row, this one is per pool.
  // For a single library key the observable outcome is the same, and a fake
  // that let two transactions interleave would be modelling a database that
  // does not exist. What it cannot show is that Postgres accepts this SQL;
  // `db.postgres.test.js` is the only thing that can.
  let transactionGate = Promise.resolve()

  const pool = {
    queries,
    leased: 0,
    /** Arms the next query matching `pattern` to reject, for the rollback path. */
    failNext(pattern) {
      failPattern = pattern
    },

    async query(text, params = []) {
      return run(text, params)
    },

    async connect() {
      pool.leased += 1
      let release = null
      let released = false
      return {
        async query(text, params = []) {
          const sql = flatten(text)
          if (sql === 'BEGIN') {
            queries.push({ text, params })
            const held = transactionGate
            let open
            transactionGate = new Promise((resolve) => {
              open = resolve
            })
            release = open
            await held
            return { rows: [] }
          }
          if (sql === 'COMMIT' || sql === 'ROLLBACK') {
            queries.push({ text, params })
            release?.()
            release = null
            return { rows: [] }
          }
          return run(text, params)
        },
        release() {
          if (released) return
          released = true
          // A client released mid-transaction must not wedge every later
          // writer — `pg` discards such a connection; this reopens the gate.
          release?.()
          release = null
          pool.leased -= 1
        },
      }
    },

    async end() {},
  }

  return pool

  async function run(text, params = []) {
    queries.push({ text, params })
    const sql = flatten(text)

    if (failPattern && failPattern.test(sql)) {
      failPattern = null
      throw new Error(`fakeLibraryPool: forced failure for: ${sql}`)
    }

    return dispatch(sql, params)
  }

  async function dispatch(sql, params) {
    if (sql.startsWith('CREATE TABLE')) {
      created.add(tableOf(sql))
      return { rows: [] }
    }
    if (sql.startsWith('CREATE INDEX')) return { rows: [] }

    const table = tableOf(sql)
    if (!created.has(table)) throw new Error(`relation "${table}" does not exist`)

    if (table === 'libraries') {
      if (sql.startsWith('SELECT')) {
        const row = libraries.get(params[0])
        return { rows: row ? [{ data: row.data, updatedAt: row.updatedAt }] : [] }
      }
      if (sql.startsWith('INSERT')) {
        const [key, data, updatedAt] = params
        libraries.set(key, { data, updatedAt })
        return { rows: [] }
      }
    }

    if (table === 'library_versions') {
      if (sql.startsWith('INSERT')) {
        const [key, data, updatedAt, archivedAt] = params
        versions.push({ id: nextId++, libraryKey: key, data, updatedAt, archivedAt })
        return { rows: [] }
      }
      if (sql.startsWith('DELETE')) {
        const doomed = new Set(params[0])
        for (let i = versions.length - 1; i >= 0; i -= 1) if (doomed.has(versions[i].id)) versions.splice(i, 1)
        return { rows: [] }
      }
      if (sql.startsWith('SELECT')) {
        const mine = versions.filter((v) => v.libraryKey === params[0]).sort((a, b) => b.id - a.id)
        // `pg` hands `bigint` back as a string; `db.js` is what converts.
        if (sql.includes('LIMIT 1')) return { rows: mine.slice(0, 1).map((v) => ({ archivedAt: String(v.archivedAt) })) }
        if (sql.includes('octet_length')) {
          // T082: retention thins by interval, so the prune needs each row's
          // `archived_at` as well as its size.
          return {
            rows: mine.map((v) => ({ id: String(v.id), bytes: String(Buffer.byteLength(v.data)), archivedAt: String(v.archivedAt) })),
          }
        }
        return { rows: mine.map((v) => ({ id: String(v.id), data: v.data, updatedAt: String(v.updatedAt), archivedAt: String(v.archivedAt) })) }
      }
    }

    throw new Error(`fakeLibraryPool: unrecognized query: ${sql}`)
  }
}

/**
 * `clips` (T063), including the `byte_size` column and the eviction sweep
 * T071 added. The real driver maps `bytea` to a `Buffer` in both
 * directions, which is what this stores and returns.
 */
export function fakeClipPool() {
  const created = new Set()
  const rows = new Map()
  const queries = []

  return {
    queries,
    async query(text, params = []) {
      queries.push({ text, params })
      const sql = flatten(text)

      if (sql.startsWith('CREATE TABLE')) {
        created.add(tableOf(sql))
        return { rows: [] }
      }
      if (!created.has('clips')) throw new Error('relation "clips" does not exist')

      // `ADD COLUMN IF NOT EXISTS` against a table this fake creates with the
      // column already present: a no-op, exactly as in Postgres.
      if (sql.startsWith('ALTER TABLE')) return { rows: [] }

      if (sql.startsWith('UPDATE clips SET byte_size')) {
        for (const row of rows.values()) if (row.byteSize === null || row.byteSize === undefined) row.byteSize = row.bytes.byteLength
        return { rows: [] }
      }

      if (sql.startsWith('SELECT COALESCE(SUM(byte_size)')) {
        let total = 0
        for (const row of rows.values()) total += row.byteSize ?? 0
        return { rows: [{ total: String(total) }] }
      }

      if (sql.startsWith('SELECT hash, byte_size')) {
        const ordered = [...rows.values()].sort((a, b) => a.createdAt - b.createdAt || (a.hash < b.hash ? -1 : 1))
        return { rows: ordered.slice(0, params[0]).map((r) => ({ hash: r.hash, byteSize: String(r.byteSize) })) }
      }

      if (sql.startsWith('SELECT')) {
        const row = rows.get(params[0])
        return { rows: row ? [{ bytes: row.bytes, mime: row.mime, durationMs: row.durationMs }] : [] }
      }

      if (sql.startsWith('INSERT')) {
        const [hash, bytes, mime, durationMs, createdAt, byteSize] = params
        // Mirrors `ON CONFLICT (hash) DO NOTHING`: the first write for a
        // content address wins and later ones are silently no-ops.
        if (!rows.has(hash)) rows.set(hash, { hash, bytes, mime, durationMs, createdAt, byteSize })
        return { rows: [] }
      }

      if (sql.startsWith('DELETE')) {
        for (const hash of params[0]) rows.delete(hash)
        return { rows: [] }
      }

      throw new Error(`fakeClipPool: unrecognized query: ${sql}`)
    },
    async end() {},
  }
}
