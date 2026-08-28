import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Passage } from '../../domain'
import { resetFakeIdb, idbOperations } from './idb.test-support'
import { CURRENT_SCHEMA_VERSION } from './migrations'

import { openDB } from 'idb'
import { createIndexedDbPassageStore } from './indexed-db-passage-store'
import { createIndexedDbDeckStore } from './indexed-db-deck-store'
import { PASSAGES_STORE, TOMBSTONES_STORE } from './database'

function makePassage(overrides: Partial<Passage> = {}): Passage {
  return {
    id: 'pg-1',
    name: 'Le Petit Prince, ch. 1',
    text: 'Lorsque j’avais six ans j’ai vu, une fois, une magnifique image.',
    ...overrides,
  }
}

describe('createIndexedDbPassageStore', () => {
  beforeEach(() => {
    resetFakeIdb()
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(true) } })
  })

  it('persists a Passage and reloads it whole', async () => {
    const store = createIndexedDbPassageStore()
    const passage = makePassage()

    await store.save(passage)

    expect(await store.loadAll()).toEqual([passage])
  })

  /**
   * Last-writer-wins is a Passage's whole merge rule (`PassageStore` in
   * ports.ts): its content is one text field, so there is no merged part of
   * it to lose and a save replaces rather than combines.
   */
  it('replaces a Passage on save rather than appending to its text', async () => {
    const store = createIndexedDbPassageStore()
    await store.save(makePassage({ text: 'Le premier texte.' }))

    await store.save(makePassage({ text: 'Le texte réécrit.' }))

    expect(await store.loadAll()).toEqual([makePassage({ text: 'Le texte réécrit.' })])
  })

  /**
   * `createdAt` is when the user first made it, so a rewrite must not restamp it —
   * the same rule the deck and mix stores follow, and the reason `save` reads
   * the existing record before it puts.
   */
  it('keeps the createdAt of the record it replaces, and moves only updatedAt', async () => {
    const store = createIndexedDbPassageStore()
    await store.save(makePassage())
    const db = await openDB('phrase-drill', CURRENT_SCHEMA_VERSION)
    const first = (await db.get(PASSAGES_STORE, 'pg-1')) as { createdAt: number; updatedAt: number }

    // A Date.now spy rather than fake timers: fake-indexeddb drives its own
    // requests off the real event loop, and freezing that stalls every write
    // this test is about.
    const later = vi.spyOn(Date, 'now').mockReturnValue(first.updatedAt + 60_000)
    await store.save(makePassage({ text: 'Réécrit.' }))
    later.mockRestore()

    const second = (await db.get(PASSAGES_STORE, 'pg-1')) as { createdAt: number; updatedAt: number }
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt)
  })

  it('keeps two Passages apart', async () => {
    const store = createIndexedDbPassageStore()
    await store.save(makePassage({ id: 'pg-1', name: 'Chapitre 1' }))
    await store.save(makePassage({ id: 'pg-2', name: 'Chapitre 2' }))

    expect((await store.loadAll()).map((p) => p.name)).toEqual(['Chapitre 1', 'Chapitre 2'])
  })

  it('removes a Passage', async () => {
    const store = createIndexedDbPassageStore()
    await store.save(makePassage())

    await store.remove('pg-1')

    expect(await store.loadAll()).toEqual([])
  })

  it('records a Tombstone when a Passage is removed, so another device cannot resurrect it (T060)', async () => {
    const store = createIndexedDbPassageStore()
    const deckStore = createIndexedDbDeckStore()
    await store.save(makePassage())

    await store.remove('pg-1')

    expect((await deckStore.exportAll()).tombstones).toEqual([
      { id: 'pg-1', kind: 'passage', deletedAt: expect.any(Number) },
    ])
  })

  /**
   * The delete and its Tombstone are ONE fact: a delete whose Tombstone did
   * not commit is a delete that comes back on the next sync, from every
   * device that still holds the Passage. One transaction is the only ordering
   * under which that cannot happen — not even if the tab is closed between
   * the two writes.
   */
  it('deletes the record and writes the Tombstone on ONE transaction', async () => {
    const store = createIndexedDbPassageStore()
    await store.save(makePassage())
    idbOperations.length = 0

    await store.remove('pg-1')

    const carriers = [
      ...new Set(
        idbOperations
          .filter((op) => [PASSAGES_STORE, TOMBSTONES_STORE].includes(op.store))
          .map((op) => op.transaction),
      ),
    ]
    expect(carriers).toHaveLength(1)
    expect(
      idbOperations
        .filter((op) => op.transaction === carriers[0])
        .map((op) => `${op.store}:${op.op}`),
    ).toEqual([`${PASSAGES_STORE}:delete`, `${TOMBSTONES_STORE}:put`])
  })

  it('deleting a Passage never touches a Deck', async () => {
    const deckStore = createIndexedDbDeckStore()
    await deckStore.save({ id: 'home', name: 'Home', phrases: [{ id: 'p1', french: 'Bonjour', english: 'Hello' }] })
    const store = createIndexedDbPassageStore()
    await store.save(makePassage())

    await store.remove('pg-1')

    expect((await deckStore.loadAll()).map((d) => d.id)).toEqual(['home'])
    expect((await deckStore.get('home'))?.phrases).toHaveLength(1)
  })

  it('shares the one database and version with every other store', async () => {
    const store = createIndexedDbPassageStore()
    await store.save(makePassage())

    const db = await openDB('phrase-drill', CURRENT_SCHEMA_VERSION)

    expect(db.objectStoreNames.contains('passages')).toBe(true)
  })
})
