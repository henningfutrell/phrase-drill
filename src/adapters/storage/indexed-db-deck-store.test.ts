import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Deck } from '../../domain'
import { idbDestructiveOperations, resetFakeIdb } from './idb.test-support'
import { CURRENT_SCHEMA_VERSION } from './migrations'

vi.mock('idb', async () => {
  const fake = await import('./idb.test-support')
  return { openDB: fake.openDB }
})

// Imported after the mock is registered, per Vitest's hoisting contract.
const { createIndexedDbDeckStore } = await import('./indexed-db-deck-store')
const { createIndexedDbMixStore } = await import('./indexed-db-mix-store')

function makeDeck(overrides: Partial<Deck> = {}): Deck {
  return {
    id: 'deck-1',
    name: 'Home',
    phrases: [{ id: 'p1', french: 'Bonjour', english: 'Hello' }],
    ...overrides,
  }
}

describe('createIndexedDbDeckStore', () => {
  beforeEach(() => {
    resetFakeIdb()
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(true) } })
  })

  it('persists a deck and reloads it whole, via a single put', async () => {
    const store = createIndexedDbDeckStore()
    const deck = makeDeck()

    await store.save(deck)

    expect(await store.get(deck.id)).toEqual(deck)
    expect(await store.loadAll()).toEqual([deck])
  })

  it('replaces a deck on save rather than merging its phrases', async () => {
    const store = createIndexedDbDeckStore()
    await store.save(
      makeDeck({
        phrases: [
          { id: 'p1', french: 'a', english: 'b' },
          { id: 'p2', french: 'c', english: 'd' },
        ],
      }),
    )

    const replaced = makeDeck({ phrases: [{ id: 'p3', french: 'x', english: 'y' }] })
    await store.save(replaced)

    expect(await store.get(replaced.id)).toEqual(replaced)
  })

  it('returns undefined for a deck that was never saved', async () => {
    const store = createIndexedDbDeckStore()
    expect(await store.get('missing')).toBeUndefined()
  })

  /**
   * `update` is the composition root's write (T075). `save` puts a whole Deck
   * built somewhere else and some time ago — from React state, which is a view
   * and is stale by the time a tap reaches storage. That gap is where a Phrase
   * a merge had just written was overwritten away. `update` closes it the same
   * way `updateAll` closes the sync path's: the read and the write are ONE
   * transaction, and the function is handed the Deck as it is stored at that
   * instant.
   */
  describe('update', () => {
    it('applies the change to what is stored NOW, not to what the caller last read', async () => {
      const store = createIndexedDbDeckStore()
      await store.save(makeDeck({ id: 'home', phrases: [{ id: 'p1', french: 'Bonjour', english: 'Hello' }] }))
      const readEarlier = (await store.get('home'))!
      // A merge writes a Phrase from her other phone while the caller is still
      // holding `readEarlier`.
      await store.save({
        ...readEarlier,
        phrases: [...readEarlier.phrases, { id: 'p2', french: 'Bonne nuit', english: 'Good night' }],
      })

      const written = await store.update('home', (stored) => ({
        ...stored!,
        phrases: [...stored!.phrases, { id: 'p3', french: 'Merci', english: 'Thank you' }],
      }))

      expect(written.phrases.map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
      expect((await store.get('home'))!.phrases.map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
    })

    it('hands the change nothing when this device no longer holds that Deck, and writes what it returns', async () => {
      const store = createIndexedDbDeckStore()
      let seen: unknown = 'never called'

      const written = await store.update('home', (stored) => {
        seen = stored
        return makeDeck({ id: 'home', name: 'Home' })
      })

      expect(seen).toBeUndefined()
      expect(written).toEqual(makeDeck({ id: 'home', name: 'Home' }))
      expect(await store.get('home')).toEqual(makeDeck({ id: 'home', name: 'Home' }))
    })

    it('keeps the Deck’s createdAt and moves its updatedAt, like a save', async () => {
      const store = createIndexedDbDeckStore()
      await store.save(makeDeck({ id: 'home' }))
      const created = (await store.exportAll()).decks[0]!.createdAt

      await store.update('home', (stored) => ({ ...stored!, name: 'À la maison' }))

      const record = (await store.exportAll()).decks[0]!
      expect(record.createdAt).toBe(created)
      expect(record.updatedAt).toBeGreaterThanOrEqual(created)
    })

    it('leaves the stored Deck untouched when the change refuses', async () => {
      const store = createIndexedDbDeckStore()
      await store.save(makeDeck({ id: 'home', name: 'Home' }))

      await expect(
        store.update('home', () => {
          throw new Error('nothing to apply this to')
        }),
      ).rejects.toThrow('nothing to apply this to')

      expect((await store.get('home'))!.name).toBe('Home')
    })

    it('reaches the decks store and nothing else', async () => {
      const store = createIndexedDbDeckStore()
      await store.save(makeDeck({ id: 'home' }))
      idbDestructiveOperations.length = 0

      await store.update('home', (stored) => ({ ...stored!, name: 'Renamed' }))

      expect(idbDestructiveOperations).toEqual([])
    })
  })

  it('removes a deck', async () => {
    const store = createIndexedDbDeckStore()
    const deck = makeDeck()
    await store.save(deck)

    await store.remove(deck.id)

    expect(await store.get(deck.id)).toBeUndefined()
    expect(await store.loadAll()).toEqual([])
  })

  it('records a Tombstone when a deck is removed, so another device cannot resurrect it (T060)', async () => {
    const store = createIndexedDbDeckStore()
    const deck = makeDeck()
    await store.save(deck)

    await store.remove(deck.id)

    const library = await store.exportAll()
    expect(library.tombstones).toEqual([{ id: deck.id, kind: 'deck', deletedAt: expect.any(Number) }])
  })

  it('dates the Tombstone at or after the deck record it replaces, so the delete outranks the write', async () => {
    const store = createIndexedDbDeckStore()
    const deck = makeDeck()
    await store.save(deck)
    const beforeRemoval = await store.exportAll()
    const written = beforeRemoval.decks[0]!.updatedAt

    await store.remove(deck.id)

    const library = await store.exportAll()
    expect(library.tombstones![0]!.deletedAt).toBeGreaterThanOrEqual(written)
  })

  it('carries Tombstones through exportAll and importAll, so a restored device still knows what was deleted', async () => {
    const store = createIndexedDbDeckStore()
    await store.save(makeDeck())
    await store.remove('deck-1')

    const other = createIndexedDbDeckStore()
    await other.importAll(await store.exportAll())

    expect((await other.exportAll()).tombstones).toEqual([
      { id: 'deck-1', kind: 'deck', deletedAt: expect.any(Number) },
    ])
  })

  it('replaces the Tombstones on import rather than accumulating them', async () => {
    const store = createIndexedDbDeckStore()
    await store.save(makeDeck())
    await store.remove('deck-1')

    await store.importAll({
      ...(await store.exportAll()),
      tombstones: [{ id: 'other', kind: 'deck' as const, deletedAt: 5 }],
    })

    expect((await store.exportAll()).tombstones).toEqual([{ id: 'other', kind: 'deck', deletedAt: 5 }])
  })

  it('exports no Tombstones from a library that has never had a deletion', async () => {
    const store = createIndexedDbDeckStore()
    await store.save(makeDeck())

    expect((await store.exportAll()).tombstones).toEqual([])
  })

  it('accepts a library from before Tombstones existed, leaving none behind', async () => {
    const store = createIndexedDbDeckStore()
    await store.importAll({
      format: 'phrase-drill-library',
      schemaVersion: 1,
      exportedAt: 1,
      decks: [{ id: 'old', name: 'Old', phrases: [], createdAt: 1, updatedAt: 1 }],
    })

    const library = await store.exportAll()
    expect(library.decks.map((d) => d.id)).toEqual(['old'])
    expect(library.tombstones).toEqual([])
  })

  it('round-trips the whole library through exportAll and importAll', async () => {
    const store = createIndexedDbDeckStore()
    const home = makeDeck({ id: 'home', name: 'Home' })
    const work = makeDeck({
      id: 'work',
      name: 'Work',
      phrases: [{ id: 'p9', french: 'Salut', english: 'Hi' }],
    })
    await store.save(home)
    await store.save(work)

    const library = await store.exportAll()
    expect(library.format).toBe('phrase-drill-library')
    expect(library.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(library.decks.map((d) => d.id).sort()).toEqual(['home', 'work'])

    const other = createIndexedDbDeckStore()
    await other.importAll(library)

    expect((await other.loadAll()).map((d) => d.id).sort()).toEqual(['home', 'work'])
  })

  it('import replaces the whole library rather than merging with what is already stored', async () => {
    const store = createIndexedDbDeckStore()
    await store.save(makeDeck({ id: 'stale', name: 'Stale' }))
    const exported = await store.exportAll()

    const replacement = {
      ...exported,
      decks: [{ id: 'fresh', name: 'Fresh', phrases: [], createdAt: 1, updatedAt: 1 }],
    }
    await store.importAll(replacement)

    expect((await store.loadAll()).map((d) => d.id)).toEqual(['fresh'])
  })

  it('carries saved Mixes through exportAll and importAll, so they survive a new phone (T059)', async () => {
    const store = createIndexedDbDeckStore()
    const mixStore = createIndexedDbMixStore()
    await store.save(makeDeck({ id: 'home', name: 'Home' }))
    await mixStore.save({ id: 'm1', name: 'Mornings', deckIds: ['home'] })

    const library = await store.exportAll()
    expect(library.mixes?.map((m) => m.id)).toEqual(['m1'])

    resetFakeIdb()
    const freshDecks = createIndexedDbDeckStore()
    const freshMixes = createIndexedDbMixStore()
    await freshDecks.importAll(library)

    expect((await freshDecks.loadAll()).map((d) => d.id)).toEqual(['home'])
    expect(await freshMixes.loadAll()).toEqual([{ id: 'm1', name: 'Mornings', deckIds: ['home'] }])
  })

  it('import replaces saved Mixes wholesale, the same way it replaces Decks', async () => {
    const store = createIndexedDbDeckStore()
    const mixStore = createIndexedDbMixStore()
    await mixStore.save({ id: 'stale', name: 'Stale', deckIds: [] })
    const exported = await store.exportAll()

    await store.importAll({
      ...exported,
      mixes: [{ id: 'fresh', name: 'Fresh', deckIds: ['home'], createdAt: 1, updatedAt: 1 }],
    })

    expect((await mixStore.loadAll()).map((m) => m.id)).toEqual(['fresh'])
  })

  it('restores a pre-v4 backup that carries no mixes at all, leaving no saved Mixes behind', async () => {
    const store = createIndexedDbDeckStore()
    const mixStore = createIndexedDbMixStore()
    await mixStore.save({ id: 'stale', name: 'Stale', deckIds: [] })

    await store.importAll({
      format: 'phrase-drill-library',
      schemaVersion: 3,
      exportedAt: 1,
      decks: [{ id: 'home', name: 'Home', phrases: [], createdAt: 1, updatedAt: 1 }],
    })

    expect((await store.loadAll()).map((d) => d.id)).toEqual(['home'])
    expect(await mixStore.loadAll()).toEqual([])
  })

  /**
   * `updateAll` is the sync path's write (T074). `importAll` replaces what is
   * stored with a library computed somewhere else and some time ago; that gap
   * is where a Deck she saved mid-sync was lost. `updateAll` closes it by
   * doing the read and the write in ONE transaction: the update function is
   * handed what is stored at that instant, and nothing can land between.
   */
  it('hands the update what is stored NOW, not what was read before it was called', async () => {
    const store = createIndexedDbDeckStore()
    await store.save(makeDeck({ id: 'home', name: 'Home' }))
    const readEarlier = await store.exportAll()
    // She saves while the caller is still holding `readEarlier`.
    await store.save(makeDeck({ id: 'clinic', name: 'Chez le médecin' }))

    let seen: string[] = []
    await store.updateAll((stored) => {
      seen = stored.decks.map((deck) => deck.id).sort()
      return { ...stored, decks: [...stored.decks, ...readEarlier.decks.filter((d) => d.id === 'nothing')] }
    })

    expect(seen).toEqual(['clinic', 'home'])
  })

  it('writes what the update returned, and says it changed something', async () => {
    const store = createIndexedDbDeckStore()
    await store.save(makeDeck({ id: 'home', name: 'Home' }))

    const result = await store.updateAll((stored) => ({
      ...stored,
      decks: [...stored.decks, { id: 'arrived', name: 'From the web', phrases: [], createdAt: 1, updatedAt: 1 }],
    }))

    expect(result.changed).toBe(true)
    expect(result.library.decks.map((d) => d.id).sort()).toEqual(['arrived', 'home'])
    expect((await store.loadAll()).map((d) => d.id).sort()).toEqual(['arrived', 'home'])
  })

  it('sees the saved Mixes and Tombstones too, and carries them back', async () => {
    const store = createIndexedDbDeckStore()
    const mixStore = createIndexedDbMixStore()
    await store.save(makeDeck({ id: 'home', name: 'Home' }))
    await mixStore.save({ id: 'm1', name: 'Mornings', deckIds: ['home'] })
    await store.save(makeDeck({ id: 'gone', name: 'Gone' }))
    await store.remove('gone')

    const result = await store.updateAll((stored) => stored)

    expect(result.library.mixes!.map((m) => m.id)).toEqual(['m1'])
    expect(result.library.tombstones!.map((t) => t.id)).toEqual(['gone'])
    expect((await mixStore.loadAll()).map((m) => m.id)).toEqual(['m1'])
  })

  /**
   * The one destructive operation in the adapter is `clear`, and an update
   * that changed nothing must not reach for it. Not an optimization: a
   * wholesale clear-and-rewrite on every idle sync is a wipe waiting for the
   * one interrupted transaction that does not finish.
   */
  it('writes nothing at all when the update changed nothing', async () => {
    const store = createIndexedDbDeckStore()
    await store.save(makeDeck({ id: 'home', name: 'Home' }))
    idbDestructiveOperations.length = 0

    const result = await store.updateAll((stored) => ({ ...stored, exportedAt: stored.exportedAt + 1_000 }))

    expect(result.changed).toBe(false)
    expect(idbDestructiveOperations).toEqual([])
    expect((await store.loadAll()).map((d) => d.id)).toEqual(['home'])
  })

  it('leaves the stored library untouched when the update refuses', async () => {
    const store = createIndexedDbDeckStore()
    await store.save(makeDeck({ id: 'home', name: 'Home' }))

    await expect(
      store.updateAll(() => {
        throw new Error('this build cannot read that envelope')
      }),
    ).rejects.toThrow('this build cannot read that envelope')

    expect((await store.loadAll()).map((d) => d.id)).toEqual(['home'])
  })

  it('requests persistent storage once, at first save, and reports the real result', async () => {
    const persist = vi.fn().mockResolvedValue(false)
    vi.stubGlobal('navigator', { storage: { persist } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const store = createIndexedDbDeckStore()
    await store.save(makeDeck())
    await store.save(makeDeck({ id: 'deck-2' }))

    expect(persist).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not granted/))
    warn.mockRestore()
  })

  it('never includes the API key, or anything else from settings, in an export', async () => {
    const store = createIndexedDbDeckStore()
    await store.save(makeDeck())

    // Reach into the same underlying database's settings store directly, the
    // way a settings adapter would, and confirm the export cannot see it.
    const idbModule = await import('idb')
    const db = await idbModule.openDB('phrase-drill', CURRENT_SCHEMA_VERSION)
    await db.put('settings', 'super-secret-anthropic-key', 'anthropicApiKey')

    const library = await store.exportAll()

    expect(JSON.stringify(library)).not.toContain('super-secret-anthropic-key')
  })
})
