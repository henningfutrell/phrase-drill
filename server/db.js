import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * The whole server-side persistence layer: one table, keyed by library key,
 * storing the same JSON envelope `deckStore.exportAll()` already produces
 * device-side (`format`/`schemaVersion`/`exportedAt`/`decks`). Standard SQL
 * via Node's built-in `node:sqlite` — no ORM, no separate database
 * container, nothing to run `npm install` for (T041 "boring and portable").
 * `:memory:` in tests; a file under the named Docker volume in production.
 */
export function createLibraryStore(dbPath) {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true })
  }
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS libraries (
      library_key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  const getStmt = db.prepare('SELECT data, updated_at AS updatedAt FROM libraries WHERE library_key = ?')
  const putStmt = db.prepare(`
    INSERT INTO libraries (library_key, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(library_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `)

  return {
    get(key) {
      const row = getStmt.get(key)
      return row ? { data: row.data, updatedAt: Number(row.updatedAt) } : null
    },
    put(key, data, updatedAt) {
      putStmt.run(key, data, updatedAt)
    },
    close() {
      db.close()
    },
  }
}
