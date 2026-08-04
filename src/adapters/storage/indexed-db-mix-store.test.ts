import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mix } from '../../domain'
import { resetFakeIdb } from './idb.test-support'
import { CURRENT_SCHEMA_VERSION } from './migrations'

vi.mock('idb', async () => {
  const fake = await import('./idb.test-support')
  return { openDB: fake.openDB }
})

// Imported after the mock is registered, per Vitest's hoisting contract.
const { createIndexedDbMixStore } = await import('./indexed-db-mix-store')
const { createIndexedDbDeckStore } = await import('./indexed-db-deck-store')

function makeMix(overrides: Partial<Mix> = {}): Mix {
  return { id: 'mix-1', name: 'Mornings', deckIds: ['home', 'work'], ...overrides }
}

describe('createIndexedDbMixStore', () => {
  beforeEach(() => {
    resetFakeIdb()
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(true) } })
  })

  it('persists a Mix and reloads it whole', async () => {
    const store = createIndexedDbMixStore()
    const mix = makeMix()

    await store.save(mix)

    expect(await store.loadAll()).toEqual([mix])
  })

  it('replaces a Mix on save rather than merging its Deck ids', async () => {
    const store = createIndexedDbMixStore()
    await store.save(makeMix({ deckIds: ['home', 'work', 'formal'] }))

    await store.save(makeMix({ deckIds: ['climbing'] }))

    expect(await store.loadAll()).toEqual([makeMix({ deckIds: ['climbing'] })])
  })

  it('removes a Mix', async () => {
    const store = createIndexedDbMixStore()
    await store.save(makeMix())

    await store.remove('mix-1')

    expect(await store.loadAll()).toEqual([])
  })

  it('records a Tombstone when a Mix is removed, so another device cannot resurrect it (T060)', async () => {
    const store = createIndexedDbMixStore()
    const deckStore = createIndexedDbDeckStore()
    await store.save(makeMix())

    await store.remove('mix-1')

    expect((await deckStore.exportAll()).tombstones).toEqual([
      { id: 'mix-1', kind: 'mix', deletedAt: expect.any(Number) },
    ])
  })

  it('deleting a Mix never touches the Decks it named', async () => {
    const deckStore = createIndexedDbDeckStore()
    await deckStore.save({ id: 'home', name: 'Home', phrases: [{ id: 'p1', french: 'Bonjour', english: 'Hello' }] })
    await deckStore.save({ id: 'work', name: 'Work', phrases: [] })
    const mixStore = createIndexedDbMixStore()
    await mixStore.save(makeMix())

    await mixStore.remove('mix-1')

    expect((await deckStore.loadAll()).map((d) => d.id).sort()).toEqual(['home', 'work'])
    expect((await deckStore.get('home'))?.phrases).toHaveLength(1)
  })

  it('keeps the id of a Deck that has been deleted — the Mix is not rewritten behind her back', async () => {
    const deckStore = createIndexedDbDeckStore()
    await deckStore.save({ id: 'home', name: 'Home', phrases: [] })
    const mixStore = createIndexedDbMixStore()
    await mixStore.save(makeMix({ deckIds: ['home', 'work'] }))

    await deckStore.remove('work')

    expect((await mixStore.loadAll())[0].deckIds).toEqual(['home', 'work'])
  })

  it('shares the one database and version with every other store', async () => {
    const store = createIndexedDbMixStore()
    await store.save(makeMix())

    const idbModule = await import('idb')
    const db = await idbModule.openDB('phrase-drill', CURRENT_SCHEMA_VERSION)

    expect(db.objectStoreNames.contains('mixes')).toBe(true)
  })
})
