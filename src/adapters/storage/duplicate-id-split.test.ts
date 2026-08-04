import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeckRecord, Library, MixRecord, Tombstone } from '../../domain'
import { LIBRARY_FORMAT, mergeLibraries } from '../../domain'
import { resetFakeIdb } from './idb.test-support'
import { createIndexedDbDeckStore } from './indexed-db-deck-store'
import { createIndexedDbMixStore } from './indexed-db-mix-store'
import { CURRENT_SCHEMA_VERSION } from './migrations'

/**
 * Two records under one id, at the STORE (T090).
 *
 * T086 fixed the merge: `mergeLibraries` takes the union of both sides under a
 * duplicated id instead of folding them into one, so a hand-edited backup file
 * can no longer cost her a whole Deck in the domain. It was half a fix. Both
 * ends of this adapter collapse duplicates before the merge's answer can ever
 * be observed, because `decks` and `mixes` are keyed `{ keyPath: 'id' }` and
 * `replaceAll` writes one `put` per record:
 *
 * - **`importAll`** is the restore path. Two Decks under one id in the file →
 *   the second `put` overwrites the first → a whole Deck, with every Phrase in
 *   it, gone from disk, silently, before the merge is ever asked anything.
 * - **`updateAll`** is the write-back of the merged library, which is worse:
 *   the merge's now-correct output is collapsed to one Deck the instant it is
 *   persisted, so T086 is presently unobservable end to end.
 *
 * The answer is to SPLIT rather than to refuse: the later record keeps its
 * content and takes a fresh id derived from the one it duplicated. She sees two
 * Decks she can merge or delete herself; the alternative is handwriting that
 * exists nowhere else. See `duplicate-ids.ts` for why refusing at parse time
 * was rejected.
 */

function phrase(id: string, french: string, english: string) {
  return { id, french, english }
}

function deckRecord(id: string, name: string, phrases = [phrase(`p-${name}`, 'Bonjour', 'Hello')]): DeckRecord {
  return { id, name, phrases, createdAt: 1_000, updatedAt: 2_000 }
}

function mixRecord(id: string, name: string, deckIds: string[] = ['d1']): MixRecord {
  return { id, name, deckIds, createdAt: 1_000, updatedAt: 2_000 }
}

function library(parts: { decks?: DeckRecord[]; mixes?: MixRecord[]; tombstones?: Tombstone[] }): Library {
  return {
    format: LIBRARY_FORMAT,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: 5_000,
    decks: parts.decks ?? [],
    mixes: parts.mixes ?? [],
    tombstones: parts.tombstones ?? [],
  }
}

describe('two records under one id survive the store (T090)', () => {
  beforeEach(() => {
    resetFakeIdb()
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(true) } })
  })

  describe('importAll — a hand-edited backup file', () => {
    it('keeps both Decks, with every Phrase, rather than letting the second put overwrite the first', async () => {
      const store = createIndexedDbDeckStore()

      await store.importAll(
        library({
          decks: [
            deckRecord('d1', 'Home', [phrase('p1', 'Bonjour', 'Hello')]),
            deckRecord('d1', 'Work', [phrase('p2', 'Merci', 'Thank you')]),
          ],
        }),
      )

      const stored = await store.loadAll()
      expect(stored.map((deck) => deck.name)).toEqual(['Home', 'Work'])
      expect(stored.flatMap((deck) => deck.phrases.map((p) => p.french))).toEqual(['Bonjour', 'Merci'])
    })

    it('gives the later Deck an id derived from the one it duplicated — recognisably the same id, split', async () => {
      const store = createIndexedDbDeckStore()

      await store.importAll(
        library({ decks: [deckRecord('d1', 'Home'), deckRecord('d1', 'Work'), deckRecord('d1', 'Formal')] }),
      )

      expect((await store.loadAll()).map((deck) => deck.id)).toEqual(['d1', 'd1-2', 'd1-3'])
    })

    it('never lands a split id on one the library already holds', async () => {
      const store = createIndexedDbDeckStore()

      await store.importAll(
        library({
          decks: [deckRecord('d1', 'Home'), deckRecord('d1', 'Work'), deckRecord('d1-2', 'Climbing')],
        }),
      )

      // `loadAll` reads the store in KEY order, not the order of the file.
      const stored = await store.loadAll()
      expect(stored.map((deck) => `${deck.id}:${deck.name}`)).toEqual(['d1:Home', 'd1-2:Climbing', 'd1-3:Work'])
    })

    it('converges: re-importing what was stored moves nothing', async () => {
      const store = createIndexedDbDeckStore()
      await store.importAll(library({ decks: [deckRecord('d1', 'Home'), deckRecord('d1', 'Work')] }))
      const once = await store.exportAll()

      await store.importAll(once)

      expect((await store.exportAll()).decks).toEqual(once.decks)
    })

    it('leaves a library with no duplicated id exactly as it was', async () => {
      const store = createIndexedDbDeckStore()

      await store.importAll(library({ decks: [deckRecord('d1', 'Home'), deckRecord('d2', 'Work')] }))

      expect((await store.loadAll()).map((deck) => deck.id)).toEqual(['d1', 'd2'])
    })

    it('keeps both Mixes under one id, for the same reason', async () => {
      const deckStore = createIndexedDbDeckStore()
      const mixStore = createIndexedDbMixStore()

      await deckStore.importAll(
        library({ decks: [deckRecord('d1', 'Home')], mixes: [mixRecord('m1', 'Morning'), mixRecord('m1', 'Evening')] }),
      )

      const stored = await mixStore.loadAll()
      expect(stored.map((mix) => mix.name)).toEqual(['Morning', 'Evening'])
      expect(stored.map((mix) => mix.id)).toEqual(['m1', 'm1-2'])
    })
  })

  describe('updateAll — the write-back of the merged library', () => {
    it('persists both Decks the merge kept, instead of collapsing them again on the way to disk', async () => {
      const store = createIndexedDbDeckStore()
      await store.importAll(library({ decks: [deckRecord('d1', 'Home', [phrase('p1', 'Bonjour', 'Hello')])] }))

      // What `mergeLibraries` returns when the server copy holds the id twice.
      await store.updateAll(() =>
        library({
          decks: [
            deckRecord('d1', 'Home', [phrase('p1', 'Bonjour', 'Hello')]),
            deckRecord('d1', 'Work', [phrase('p2', 'Merci', 'Thank you')]),
          ],
        }),
      )

      const stored = await store.loadAll()
      expect(stored.map((deck) => deck.name)).toEqual(['Home', 'Work'])
      expect(stored.flatMap((deck) => deck.phrases.map((p) => p.french))).toEqual(['Bonjour', 'Merci'])
    })

    /**
     * The returned library is what the sync engine PUSHES and what it writes
     * into the Sync Baseline (`sync-engine.ts` — `outgoing = written.library`).
     * If it still carried the duplicate while the disk carried the split, the
     * server would keep handing the duplicate back forever and the baseline
     * would describe a device that does not exist. Returning what was really
     * stored is what repairs the server copy on the first round-trip.
     */
    it('returns the library it really stored, so the push and the baseline carry the split', async () => {
      const store = createIndexedDbDeckStore()

      const result = await store.updateAll(() =>
        library({ decks: [deckRecord('d1', 'Home'), deckRecord('d1', 'Work')] }),
      )

      expect(result.library.decks.map((deck) => deck.id)).toEqual(['d1', 'd1-2'])
      expect(result.library.decks.map((deck) => deck.name)).toEqual(['Home', 'Work'])
      expect(result.changed).toBe(true)
      expect((await store.exportAll()).decks).toEqual(result.library.decks)
    })

    it('splits duplicated Mix ids on the write-back too', async () => {
      const deckStore = createIndexedDbDeckStore()
      const mixStore = createIndexedDbMixStore()

      const result = await deckStore.updateAll(() =>
        library({ decks: [deckRecord('d1', 'Home')], mixes: [mixRecord('m1', 'Morning'), mixRecord('m1', 'Evening')] }),
      )

      expect(result.library.mixes?.map((mix) => mix.id)).toEqual(['m1', 'm1-2'])
      expect((await mixStore.loadAll()).map((mix) => mix.name)).toEqual(['Morning', 'Evening'])
    })

    it('still reports no change when the update returns what is already stored', async () => {
      const store = createIndexedDbDeckStore()
      await store.importAll(library({ decks: [deckRecord('d1', 'Home')] }))

      const result = await store.updateAll((stored) => stored)

      expect(result.changed).toBe(false)
      expect((await store.loadAll()).map((deck) => deck.id)).toEqual(['d1'])
    })
  })
})

/**
 * The split must not land on an id a Tombstone claims (T093).
 *
 * T090's split skips a candidate the library's own Decks or Mixes already
 * hold. It does not look at the Tombstones — and it runs AFTER
 * `mergeLibraries` has filtered them against the surviving ids, so a Tombstone
 * for `${id}-2` is still live at the instant the split mints that exact name.
 *
 * That library is written to disk, pushed, and written into the Sync Baseline.
 * On the NEXT merge the split record is unchanged from the baseline, so
 * `rewritten` is false, `isDeleted` fires on the Tombstone's clock, and the
 * record — with every Phrase in it — is deleted silently. One round shows only
 * a surprising id; it takes two to see the Deck disappear.
 *
 * This is reachable from T090's own design, not from a contrived file: the
 * split leaves her two Decks to "merge or delete herself, in one tap", and
 * deleting the split one writes a Tombstone for `${id}-2`. A duplicate of the
 * original arriving again re-mints that name.
 *
 * The fix seeds the split's taken ids with the Tombstones of the matching
 * `kind`, so `${id}-2` is skipped exactly as an id in use is. Kind, because
 * that is what `mergeLibraries` namespaces deletion by (`key(kind, id)`): a
 * Deck's Tombstone can never delete a Mix, so it must never block a Mix's
 * split either.
 */
describe('a split never lands on an id a Tombstone claims (T093)', () => {
  beforeEach(() => {
    resetFakeIdb()
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(true) } })
  })

  const deckTombstone: Tombstone = { id: 'd1-2', kind: 'deck', deletedAt: 9_000 }
  const mixTombstone: Tombstone = { id: 'm1-2', kind: 'mix', deletedAt: 9_000 }

  const home = () => deckRecord('d1', 'Home', [phrase('p1', 'Bonjour', 'Hello')])
  const work = () => deckRecord('d1', 'Work', [phrase('p2', 'Merci', 'Thank you')])

  describe('updateAll — the write-back of the merged library', () => {
    it('skips a candidate id a live Deck Tombstone names', async () => {
      const store = createIndexedDbDeckStore()

      const result = await store.updateAll(() =>
        library({ decks: [home(), work()], tombstones: [deckTombstone] }),
      )

      expect(result.library.decks.map((deck) => deck.id)).toEqual(['d1', 'd1-3'])
      expect(result.library.decks.map((deck) => deck.name)).toEqual(['Home', 'Work'])
    })

    it('keeps the split Deck through a SECOND round-trip, instead of its own Tombstone deleting it', async () => {
      const store = createIndexedDbDeckStore()
      // She split a duplicate of `d1` once before and deleted the copy: a live
      // Tombstone for `d1-2`, which is what T090's design produces.
      await store.importAll(library({ decks: [home()], tombstones: [deckTombstone] }))

      // A duplicate of `d1` arrives from the server again.
      const remote = library({ decks: [home(), work()], tombstones: [deckTombstone] })
      const first = await store.updateAll((stored) => mergeLibraries(stored, remote, undefined))

      // The push succeeded, so the server holds `first.library` and so does the
      // Sync Baseline. The next round-trip merges against both.
      const second = await store.updateAll((stored) => mergeLibraries(stored, first.library, first.library))

      expect(second.library.decks.map((deck) => deck.name)).toEqual(['Home', 'Work'])
      expect((await store.loadAll()).flatMap((deck) => deck.phrases.map((p) => p.french))).toEqual([
        'Bonjour',
        'Merci',
      ])
    })

    it('skips a candidate id a live Mix Tombstone names, and keeps the Mix through a second round-trip', async () => {
      const deckStore = createIndexedDbDeckStore()
      const mixStore = createIndexedDbMixStore()
      await deckStore.importAll(
        library({ decks: [home()], mixes: [mixRecord('m1', 'Morning')], tombstones: [mixTombstone] }),
      )

      const remote = library({
        decks: [home()],
        mixes: [mixRecord('m1', 'Morning'), mixRecord('m1', 'Evening')],
        tombstones: [mixTombstone],
      })
      const first = await deckStore.updateAll((stored) => mergeLibraries(stored, remote, undefined))
      expect(first.library.mixes?.map((mix) => mix.id)).toEqual(['m1', 'm1-3'])

      const second = await deckStore.updateAll((stored) => mergeLibraries(stored, first.library, first.library))

      expect(second.library.mixes?.map((mix) => mix.name)).toEqual(['Morning', 'Evening'])
      expect((await mixStore.loadAll()).map((mix) => mix.name)).toEqual(['Morning', 'Evening'])
    })

    it('is not blocked by a Tombstone of the OTHER kind — deletion is namespaced by kind', async () => {
      const store = createIndexedDbDeckStore()

      const result = await store.updateAll(() =>
        library({ decks: [home(), work()], tombstones: [{ id: 'd1-2', kind: 'mix', deletedAt: 9_000 }] }),
      )

      expect(result.library.decks.map((deck) => deck.id)).toEqual(['d1', 'd1-2'])
    })
  })

  describe('importAll — a restore file that carries its own Tombstones', () => {
    it('skips a candidate id a Tombstone in the same file names', async () => {
      const store = createIndexedDbDeckStore()

      await store.importAll(library({ decks: [home(), work()], tombstones: [deckTombstone] }))

      const stored = await store.loadAll()
      expect(stored.map((deck) => deck.id)).toEqual(['d1', 'd1-3'])
      expect(stored.map((deck) => deck.name)).toEqual(['Home', 'Work'])
    })

    it('skips a candidate id a Mix Tombstone in the same file names', async () => {
      const deckStore = createIndexedDbDeckStore()
      const mixStore = createIndexedDbMixStore()

      await deckStore.importAll(
        library({
          decks: [home()],
          mixes: [mixRecord('m1', 'Morning'), mixRecord('m1', 'Evening')],
          tombstones: [mixTombstone],
        }),
      )

      expect((await mixStore.loadAll()).map((mix) => mix.id)).toEqual(['m1', 'm1-3'])
    })
  })
})
