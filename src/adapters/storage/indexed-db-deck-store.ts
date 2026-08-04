import type { Deck, DeckId, DeckStore, Library } from '../../domain'
import {
  DECKS_STORE,
  MIXES_STORE,
  TOMBSTONES_STORE,
  createDatabaseConnection,
  runTransaction,
} from './database'
import { splitDuplicateIds } from './duplicate-ids'
import { buildLibrary, migrateLibraryDecks, migrateLibraryMixes, migrateLibraryTombstones } from './library'
import { sameLibraryContent } from './library-identity'
import { fromRecord, toRecord } from './mapping'
import type { DeckRecord, MixRecord, Tombstone } from './migrations'
import { requestPersistence } from './persistence'

/** The three object stores the whole `Library` envelope is written across. */
interface LibraryStores {
  readonly deckStore: { clear(): Promise<void>; put(value: DeckRecord): Promise<unknown> }
  readonly mixStore: { clear(): Promise<void>; put(value: MixRecord): Promise<unknown> }
  readonly tombstoneStore: { clear(): Promise<void>; put(value: Tombstone): Promise<unknown> }
}

/**
 * Replace the whole of her library — Decks, Mixes and Tombstones — on the
 * caller's transaction. Shared by `updateAll` and `importAll`, which write the
 * same three stores in the same order for the same reason: the envelope is one
 * fact, so a replacement that left the Mixes behind would leave her library in
 * a state she never had. The caller owns the transaction and, through
 * `runTransaction`, the rollback.
 *
 * **One `put` per record, into stores keyed `{ keyPath: 'id' }`** — so two
 * records under one id would collapse here, silently, and this is the exact
 * line at which T086's merge fix used to be undone (T090). Both callers hand
 * this `splitDuplicateIds` output for that reason; nothing arriving here may
 * hold an id twice.
 */
async function replaceAll(
  { deckStore, mixStore, tombstoneStore }: LibraryStores,
  decks: readonly DeckRecord[],
  mixes: readonly MixRecord[],
  tombstones: readonly Tombstone[],
): Promise<void> {
  await deckStore.clear()
  await mixStore.clear()
  await tombstoneStore.clear()
  for (const record of decks) await deckStore.put(record)
  for (const record of mixes) await mixStore.put(record)
  for (const record of tombstones) await tombstoneStore.put(record)
}

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

  /**
   * One connection per store instance, opened lazily and reused — not one per
   * call. Each `createIndexedDbDeckStore()` call (the composition root makes
   * exactly one) owns its own connection for its lifetime, and gives it up
   * both when an open is refused (T087) and when the browser closes it
   * underneath the app (T077). `createDatabaseConnection` owns why.
   *
   * What is at stake in this store is her work. Every write here is optimistic
   * (`App.tsx` `persistLocally`): the screen changes first and the store is
   * written after, so a store holding a handle it should have given up refuses
   * every write for the rest of the session while the screen keeps showing
   * them saved.
   */
  const getDatabase = createDatabaseConnection()

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
     * `apply` refusing aborts the transaction rather than writing a guess —
     * as does a refused write, which is `runTransaction`'s other half (T077).
     */
    async update(id: DeckId, apply: (stored: Deck | undefined) => Deck): Promise<Deck> {
      await ensurePersistenceRequested()
      const db = await getDatabase()
      const tx = db.transaction(DECKS_STORE, 'readwrite')
      const store = tx.objectStore(DECKS_STORE)

      return runTransaction(tx, async () => {
        const existing = (await store.get(id)) as DeckRecord | undefined
        const next = apply(existing ? fromRecord(existing) : undefined)
        const now = Date.now()
        await store.put(toRecord(next, { createdAt: existing?.createdAt ?? now, updatedAt: now }))
        return next
      })
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
      await runTransaction(tx, async () => {
        await tx.objectStore(DECKS_STORE).delete(id)
        await tx
          .objectStore(TOMBSTONES_STORE)
          .put({ id, kind: 'deck', deletedAt: Date.now() } satisfies Tombstone)
      })
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
     * the transaction rather than writing a guess, and so does a refused
     * write: `runTransaction` (T077) makes those the same path.
     */
    async updateAll(
      update: (stored: Library) => Library,
    ): Promise<{ library: Library; changed: boolean }> {
      const db = await getDatabase()
      const tx = db.transaction([DECKS_STORE, MIXES_STORE, TOMBSTONES_STORE], 'readwrite')
      const deckStore = tx.objectStore(DECKS_STORE)
      const mixStore = tx.objectStore(MIXES_STORE)
      const tombstoneStore = tx.objectStore(TOMBSTONES_STORE)

      return runTransaction(tx, async () => {
        const stored = buildLibrary(
          (await deckStore.getAll()) as DeckRecord[],
          (await mixStore.getAll()) as MixRecord[],
          (await tombstoneStore.getAll()) as Tombstone[],
          Date.now(),
        )

        // Split before anything else looks at it (T090): what is compared,
        // what is written, and what is RETURNED must all be the same library,
        // because the sync engine pushes what is returned and writes it into
        // the Sync Baseline. Splitting only on the way to disk would leave the
        // server handing the duplicate back forever and the baseline
        // describing a device that does not exist.
        const next = splitDuplicateIds(update(stored))
        const migratedDecks = migrateLibraryDecks(next)
        const migratedMixes = migrateLibraryMixes(next)
        const migratedTombstones = migrateLibraryTombstones(next)

        if (sameLibraryContent(stored, next)) {
          return { library: next, changed: false }
        }

        await replaceAll({ deckStore, mixStore, tombstoneStore }, migratedDecks, migratedMixes, migratedTombstones)
        return { library: next, changed: true }
      })
    },

    async importAll(incoming: Library): Promise<void> {
      // A backup file she hand-edited is the one thing that mints a duplicated
      // id, and a restore is the one path that clears all three stores first
      // (T090). Split rather than refuse: the file is often the only copy of
      // her phrases left, so she gets both Decks and one tap of tidying.
      const library = splitDuplicateIds(incoming)
      const migratedDecks = migrateLibraryDecks(library)
      const migratedMixes = migrateLibraryMixes(library)
      const migratedTombstones = migrateLibraryTombstones(library)
      const db = await getDatabase()
      const tx = db.transaction([DECKS_STORE, MIXES_STORE, TOMBSTONES_STORE], 'readwrite')
      const stores = {
        deckStore: tx.objectStore(DECKS_STORE),
        mixStore: tx.objectStore(MIXES_STORE),
        tombstoneStore: tx.objectStore(TOMBSTONES_STORE),
      }

      await runTransaction(tx, () =>
        replaceAll(stores, migratedDecks, migratedMixes, migratedTombstones),
      )
    },
  }
}
