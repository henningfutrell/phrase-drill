import { openDB, type IDBPDatabase } from 'idb'
import { CURRENT_SCHEMA_VERSION, migrateDeckRecord } from './migrations'

export const DB_NAME = 'phrase-drill'
export const DECKS_STORE = 'decks'
export const SETTINGS_STORE = 'settings'

/**
 * Opens the one IndexedDB database this app uses. Both stores are declared
 * here, in the single upgrade path, even though `decks` and `settings` are
 * each exposed through their own adapter (`indexed-db-deck-store.ts`,
 * `settings-store.ts`): they share one database and one version number
 * (T002 §4), so they share one place that defines the schema. Nothing
 * outside `adapters/storage` opens this database.
 */
export function openDatabase(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, CURRENT_SCHEMA_VERSION, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      if (!db.objectStoreNames.contains(DECKS_STORE)) {
        db.createObjectStore(DECKS_STORE, { keyPath: 'id' })
      } else if (oldVersion < CURRENT_SCHEMA_VERSION) {
        // A future schema bump lands its migration here, running the same
        // pure migrateDeckRecord that importAll runs — one migration
        // codebase for both paths.
        const store = transaction.objectStore(DECKS_STORE)
        void store.getAll().then((records: unknown[]) => {
          for (const record of records) {
            void store.put(migrateDeckRecord(record, oldVersion))
          }
        })
      }
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE)
      }
    },
  })
}
