import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeckRecord, Library, MixRecord } from '../../domain'
import { LIBRARY_FORMAT } from '../../domain'
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

function library(parts: { decks?: DeckRecord[]; mixes?: MixRecord[] }): Library {
  return {
    format: LIBRARY_FORMAT,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: 5_000,
    decks: parts.decks ?? [],
    mixes: parts.mixes ?? [],
    tombstones: [],
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
