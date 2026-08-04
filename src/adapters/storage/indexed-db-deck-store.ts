import type { IDBPDatabase } from 'idb'
import type { Deck, DeckId, DeckStore, Library } from '../../domain'
import { DECKS_STORE, MIXES_STORE, openDatabase } from './database'
import { buildLibrary, migrateLibraryDecks, migrateLibraryMixes } from './library'
import { fromRecord, toRecord } from './mapping'
import type { DeckRecord, MixRecord } from './migrations'
import { requestPersistence } from './persistence'

/**
 * The IndexedDB implementation of `DeckStore`, via `idb`. Every Deck write
 * is a whole-aggregate put to the `decks` store.
 *
 * `exportAll`/`importAll` are the exception, and deliberately so: the
 * `Library` envelope is the whole of her data, which since T059 means
 * Decks *and* saved Mixes. They read and write both stores — `importAll`
 * inside one transaction spanning the two, because a restore that replaced
 * the Decks and then failed before the Mixes would leave her library in a
 * state she never had. Neither ever reads `settings`, so an export
 * structurally cannot carry a credential; there is nothing to redact
 * because nothing is read.
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
      const decks = (await db.getAll(DECKS_STORE)) as DeckRecord[]
      const mixes = (await db.getAll(MIXES_STORE)) as MixRecord[]
      return buildLibrary(decks, mixes, Date.now())
    },

    async importAll(library: Library): Promise<void> {
      const migratedDecks = migrateLibraryDecks(library)
      const migratedMixes = migrateLibraryMixes(library)
      const db = await getDatabase()
      const tx = db.transaction([DECKS_STORE, MIXES_STORE], 'readwrite')
      const deckStore = tx.objectStore(DECKS_STORE)
      const mixStore = tx.objectStore(MIXES_STORE)
      await deckStore.clear()
      await mixStore.clear()
      for (const record of migratedDecks) {
        await deckStore.put(record)
      }
      for (const record of migratedMixes) {
        await mixStore.put(record)
      }
      await tx.done
    },
  }
}
