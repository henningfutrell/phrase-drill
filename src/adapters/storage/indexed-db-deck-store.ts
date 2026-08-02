import type { IDBPDatabase } from 'idb'
import type { Deck, DeckId, DeckStore, Library } from '../../domain'
import { DECKS_STORE, openDatabase } from './database'
import { buildLibrary, migrateLibraryDecks } from './library'
import { fromRecord, toRecord } from './mapping'
import type { DeckRecord } from './migrations'
import { requestPersistence } from './persistence'

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
