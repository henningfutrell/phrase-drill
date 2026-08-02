import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Deck } from '../../domain'
import { resetFakeIdb } from './idb.test-support'
import { CURRENT_SCHEMA_VERSION } from './migrations'

vi.mock('idb', async () => {
  const fake = await import('./idb.test-support')
  return { openDB: fake.openDB }
})

// Imported after the mock is registered, per Vitest's hoisting contract.
const { createIndexedDbDeckStore } = await import('./indexed-db-deck-store')

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

  it('removes a deck', async () => {
    const store = createIndexedDbDeckStore()
    const deck = makeDeck()
    await store.save(deck)

    await store.remove(deck.id)

    expect(await store.get(deck.id)).toBeUndefined()
    expect(await store.loadAll()).toEqual([])
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
