import { openDB, type IDBPDatabase } from 'idb'
import type { Deck, DeckId, DeckStore, Library } from '../../domain'
import { buildLibrary, migrateLibraryDecks } from './library'
import { fromRecord, toRecord } from './mapping'
import { CURRENT_SCHEMA_VERSION, migrateDeckRecord, type DeckRecord } from './migrations'
import { requestPersistence } from './persistence'

const DB_NAME = 'phrase-drill'
const DECKS_STORE = 'decks'
const SETTINGS_STORE = 'settings'

/**
 * Opens the one IndexedDB database this app uses. Both stores are declared
 * here, in the single upgrade path, even though this module only exposes
 * DeckStore: `decks` and `settings` share one database and one version
 * number (T002 §4), so they share one place that defines the schema.
 * Nothing outside `adapters/storage` opens this database.
 */
function openDatabase(): Promise<IDBPDatabase> {
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

/**
 * The IndexedDB implementation of `DeckStore`, via `idb`. Every write is a
 * whole-aggregate put to the `decks` store; no operation here ever opens a
 * transaction spanning more than one store. `exportAll` reads only the
 * `decks` store, so it structurally cannot carry anything from `settings`
 * (the API key) — there is nothing to redact because nothing is read.
 */
export function createIndexedDbDeckStore(): DeckStore {
  let persistenceRequested = false
  let dbPromise: Promise<IDBPDatabase> | undefined

  // One connection per store instance, opened lazily and reused — not one
  // per call. Each `createIndexedDbDeckStore()` call (the composition root
  // makes exactly one) owns its own connection for its lifetime.
  function getDatabase(): Promise<IDBPDatabase> {
    dbPromise ??= openDatabase()
    return dbPromise
  }

  async function ensurePersistenceRequested(): Promise<void> {
    if (persistenceRequested) return
    persistenceRequested = true
    await requestPersistence()
  }

  return {
    async loadAll(): Promise<Deck[]> {
      const db = await getDatabase()
      const records = (await db.getAll(DECKS_STORE)) as DeckRecord[]
      return records.map(fromRecord)
    },

    async get(id: DeckId): Promise<Deck | undefined> {
      const db = await getDatabase()
      const record = (await db.get(DECKS_STORE, id)) as DeckRecord | undefined
      return record ? fromRecord(record) : undefined
    },

    async save(deck: Deck): Promise<void> {
      await ensurePersistenceRequested()
      const db = await getDatabase()
      const existing = (await db.get(DECKS_STORE, deck.id)) as DeckRecord | undefined
      const now = Date.now()
      const record = toRecord(deck, {
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
      await db.put(DECKS_STORE, record)
    },

    async remove(id: DeckId): Promise<void> {
      const db = await getDatabase()
      await db.delete(DECKS_STORE, id)
    },

    async exportAll(): Promise<Library> {
      const db = await getDatabase()
      const records = (await db.getAll(DECKS_STORE)) as DeckRecord[]
      return buildLibrary(records, Date.now())
    },

    async importAll(library: Library): Promise<void> {
      const migrated = migrateLibraryDecks(library)
      const db = await getDatabase()
      const tx = db.transaction(DECKS_STORE, 'readwrite')
      await tx.store.clear()
      for (const record of migrated) {
        await tx.store.put(record)
      }
      await tx.done
    },
  }
}
