import { openDB, type IDBPDatabase } from 'idb'
import { CURRENT_SCHEMA_VERSION, migrateDeckRecord } from './migrations'

export const DB_NAME = 'phrase-drill'
export const DECKS_STORE = 'decks'
export const SETTINGS_STORE = 'settings'
/**
 * Content-addressed cache of synthesized audio (T019 §5.2). Keyed by a
 * SHA-256 hash of `provider|modelId|voiceId|lang|text` — see `clip-cache.ts`.
 * Derived, regenerable cache, not user data: never read by `exportAll`.
 */
export const CLIPS_STORE = 'clips'
/**
 * Bounded ring buffer of captured errors (T039 diagnostics — `error-log.ts`
 * owns the cap/trim logic; this store just holds whatever it decides to
 * keep). Keyed by an incrementing numeric `id` so entries can be listed
 * oldest-to-newest and the oldest trimmed first.
 */
export const ERRORS_STORE = 'errors'

/**
 * Opens the one IndexedDB database this app uses. All stores are declared
 * here, in the single upgrade path, even though `decks`, `settings`, and
 * `clips` are each exposed through their own adapter
 * (`indexed-db-deck-store.ts`, `settings-store.ts`, `clip-cache.ts`): they
 * share one database and one version number (T002 §4), so they share one
 * place that defines the schema. Nothing outside `adapters/storage` opens
 * this database.
 */
export function openDatabase(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, CURRENT_SCHEMA_VERSION, {
    async upgrade(db, oldVersion, _newVersion, transaction) {
      if (!db.objectStoreNames.contains(DECKS_STORE)) {
        db.createObjectStore(DECKS_STORE, { keyPath: 'id' })
      } else if (oldVersion < CURRENT_SCHEMA_VERSION) {
        // A schema bump lands its migration here, running the same pure
        // migrateDeckRecord that importAll runs — one migration codebase
        // for both paths. Awaited (not fire-and-forget) so the versionchange
        // transaction genuinely waits for every record to be rewritten
        // before it can auto-commit.
        const store = transaction.objectStore(DECKS_STORE)
        const records = (await store.getAll()) as unknown[]
        for (const record of records) {
          await store.put(migrateDeckRecord(record, oldVersion))
        }
      }
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE)
      }
      if (!db.objectStoreNames.contains(CLIPS_STORE)) {
        // v1 -> v2, additive: existing decks/settings pass through
        // untouched (see the branches above); this store is new.
        db.createObjectStore(CLIPS_STORE, { keyPath: 'hash' })
      }
      if (!db.objectStoreNames.contains(ERRORS_STORE)) {
        // v2 -> v3, additive: every other store passes through untouched.
        db.createObjectStore(ERRORS_STORE, { keyPath: 'id' })
      }
    },
  })
}
