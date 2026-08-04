import type { IDBPDatabase } from 'idb'
import type { Deck, DeckId, DeckStore, Library } from '../../domain'
import { DECKS_STORE, MIXES_STORE, TOMBSTONES_STORE, openDatabase } from './database'
import { buildLibrary, migrateLibraryDecks, migrateLibraryMixes, migrateLibraryTombstones } from './library'
import { sameLibraryContent } from './library-identity'
import { fromRecord, toRecord } from './mapping'
import type { DeckRecord, MixRecord, Tombstone } from './migrations'
import { requestPersistence } from './persistence'

/**
 * The IndexedDB implementation of `DeckStore`, via `idb`. Every Deck write is
 * a whole-aggregate put to the `decks` store: `save` for a Deck that does not
 * exist yet, `update` — read and put in one transaction — for one that does
 * (T075).
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

  /**
   * One connection per store instance, opened lazily and reused — not one per
   * call. Each `createIndexedDbDeckStore()` call (the composition root makes
   * exactly one) owns its own connection for its lifetime. **A failed open is
   * forgotten again (T087, the clip cache's T085 rule applied here.)**
   *
   * A rejected promise is still a settled promise, so a plain `??=` remembers
   * a refusal as firmly as it remembers a handle: one transient failure — iOS
   * closing the connection under memory pressure, a `versionchange` from
   * another surface — was replayed by every later call, and nothing ever tried
   * again. This is the store her Phrases are written to and every write here
   * is optimistic (`App.tsx` `persistLocally`), so that was a session in which
   * nothing she typed could be saved while the screen kept showing it saved.
   *
   * Forgetting the slot is a retry, not a loop: nothing here opens on its own.
   * The next call the app makes opens again, and a database that is
   * persistently refusing rejects once per call, exactly as it does now —
   * still reaching `persistLocally` and the T069 notice, or the T083 launch
   * screen. One refusal costs one re-open; it does not buy silence.
   */
  function getDatabase(): Promise<IDBPDatabase> {
    dbPromise ??= openDatabase().catch((error: unknown) => {
      dbPromise = undefined
      throw error
    })
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
     * The read and the write in one transaction (T075) — see the port. Same
     * shape as `updateAll` below and for the same reason, one Deck rather than
     * the whole library: every step between the `get` and the `put` is
     * synchronous, so nothing can land in between. A merge writing this Deck
     * either commits before this transaction reads it (and `apply` sees the
     * Phrase it brought) or after this one writes (and re-reads what she
     * saved). There is no third outcome.
     *
     * `apply` refusing aborts the transaction rather than writing a guess.
     */
    async update(id: DeckId, apply: (stored: Deck | undefined) => Deck): Promise<Deck> {
      await ensurePersistenceRequested()
      const db = await getDatabase()
      const tx = db.transaction(DECKS_STORE, 'readwrite')
      const store = tx.objectStore(DECKS_STORE)
      const existing = (await store.get(id)) as DeckRecord | undefined

      let next: Deck
      let record: DeckRecord
      try {
        next = apply(existing ? fromRecord(existing) : undefined)
        const now = Date.now()
        record = toRecord(next, { createdAt: existing?.createdAt ?? now, updatedAt: now })
      } catch (error) {
        // `done` rejects on an abort; nothing awaits it on this path, so it is
        // read here rather than left to surface as an unhandled rejection.
        void tx.done.catch(() => {})
        tx.abort()
        throw error
      }

      await store.put(record)
      await tx.done
      return next
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

    /**
     * The read and the write in one transaction (T074) — see the port. Every
     * step between them is synchronous or an IndexedDB operation on this same
     * transaction, which is what makes it indivisible: her `save` is its own
     * transaction, so it either commits before this one reads (and the update
     * sees it) or after this one writes (and it stands). There is no third
     * outcome, and no snapshot old enough to compute her work away.
     *
     * A refusal from `update` — an envelope this build cannot read — aborts
     * the transaction rather than writing a guess.
     */
    async updateAll(
      update: (stored: Library) => Library,
    ): Promise<{ library: Library; changed: boolean }> {
      const db = await getDatabase()
      const tx = db.transaction([DECKS_STORE, MIXES_STORE, TOMBSTONES_STORE], 'readwrite')
      const deckStore = tx.objectStore(DECKS_STORE)
      const mixStore = tx.objectStore(MIXES_STORE)
      const tombstoneStore = tx.objectStore(TOMBSTONES_STORE)

      const stored = buildLibrary(
        (await deckStore.getAll()) as DeckRecord[],
        (await mixStore.getAll()) as MixRecord[],
        (await tombstoneStore.getAll()) as Tombstone[],
        Date.now(),
      )

      let next: Library
      let migratedDecks: DeckRecord[]
      let migratedMixes: MixRecord[]
      let migratedTombstones: Tombstone[]
      try {
        next = update(stored)
        migratedDecks = migrateLibraryDecks(next)
        migratedMixes = migrateLibraryMixes(next)
        migratedTombstones = migrateLibraryTombstones(next)
      } catch (error) {
        // `done` rejects on an abort; nothing awaits it on this path, so it is
        // read here rather than left to surface as an unhandled rejection.
        void tx.done.catch(() => {})
        tx.abort()
        throw error
      }

      if (sameLibraryContent(stored, next)) {
        await tx.done
        return { library: next, changed: false }
      }

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
      return { library: next, changed: true }
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
