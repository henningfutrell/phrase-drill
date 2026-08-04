import type { IDBPDatabase } from 'idb'
import type { Deck, DeckId, DeckStore, Library } from '../../domain'
import { DECKS_STORE, MIXES_STORE, TOMBSTONES_STORE, openDatabase } from './database'
import { buildLibrary, migrateLibraryDecks, migrateLibraryMixes, migrateLibraryTombstones } from './library'
import { fromRecord, toRecord } from './mapping'
import type { DeckRecord, MixRecord, Tombstone } from './migrations'
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
 * state she never had.
 *
 * **Neither ever reads `settings`, and that is still the rule** — but the
 * reason has changed, so the old one is not left here to mislead. It used to
 * be that the `settings` store held the library key, and an export that
 * could not see it structurally could not carry a credential. There is no
 * credential in there any more: the device's identity is an opaque session
 * token held in `localStorage` by `session-auth.ts` (T050). What the rule
 * protects now is the shape of the envelope — what leaves this device is
 * ENUMERATED, field by field, rather than being whatever happens to be in a
 * store. The one settings field that does travel, the pinned voice (T067),
 * is joined on by name outside this adapter, in
 * `adapters/sync/synced-library.ts`. Anything else added to `settings` stays
 * on this phone until somebody names it too.
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

    /**
     * Deleting a Deck writes a Tombstone in the same transaction (T060).
     * One transaction because the two halves are one fact: a delete with no
     * Tombstone is a delete every other device undoes on the next sync, and
     * this is the only ordering under which that cannot happen — not even
     * if the tab is closed between the two writes.
     */
    async remove(id: DeckId): Promise<void> {
      const db = await getDatabase()
      const tx = db.transaction([DECKS_STORE, TOMBSTONES_STORE], 'readwrite')
      await tx.objectStore(DECKS_STORE).delete(id)
      await tx
        .objectStore(TOMBSTONES_STORE)
        .put({ id, kind: 'deck', deletedAt: Date.now() } satisfies Tombstone)
      await tx.done
    },

    async exportAll(): Promise<Library> {
      const db = await getDatabase()
      const decks = (await db.getAll(DECKS_STORE)) as DeckRecord[]
      const mixes = (await db.getAll(MIXES_STORE)) as MixRecord[]
      const tombstones = (await db.getAll(TOMBSTONES_STORE)) as Tombstone[]
      return buildLibrary(decks, mixes, tombstones, Date.now())
    },

    async importAll(library: Library): Promise<void> {
      const migratedDecks = migrateLibraryDecks(library)
      const migratedMixes = migrateLibraryMixes(library)
      const migratedTombstones = migrateLibraryTombstones(library)
      const db = await getDatabase()
      const tx = db.transaction([DECKS_STORE, MIXES_STORE, TOMBSTONES_STORE], 'readwrite')
      const deckStore = tx.objectStore(DECKS_STORE)
      const mixStore = tx.objectStore(MIXES_STORE)
      const tombstoneStore = tx.objectStore(TOMBSTONES_STORE)
      await deckStore.clear()
      await mixStore.clear()
      await tombstoneStore.clear()
      for (const record of migratedDecks) {
        await deckStore.put(record)
      }
      for (const record of migratedMixes) {
        await mixStore.put(record)
      }
      for (const record of migratedTombstones) {
        await tombstoneStore.put(record)
      }
      await tx.done
    },
  }
}
