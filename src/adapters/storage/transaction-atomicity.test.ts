/**
 * The proof for T074 (`updateAll`) and T075 (`update`) — the two fixes this
 * app's data safety rests on.
 *
 * Both exist for one reason: read/merge/write must be INDIVISIBLE. If a Phrase
 * she saves while a sync merge is running can be computed away, the damage does
 * not stop at the phone. The Sync Baseline then holds a Phrase the local Deck
 * does not, `mergePhrases` reads that as a deletion (T070), and the next
 * round-trip removes it from the server too. One dropped write, gone from both
 * devices, silently.
 *
 * That guarantee IS IndexedDB's transaction semantics, so these tests run
 * against a real implementation of them (`fake-indexeddb`, via
 * `idb.test-support.ts`) — a `readwrite` transaction really holds its stores,
 * `abort()` really rolls back, and `tx.done` really settles at commit. Until
 * T084 they ran against a hand-rolled double whose `abort()` was `() => {}` and
 * whose `done` was already resolved, which could not tell the fixed code from
 * the code before it on the property the fixes are about.
 *
 * Two kinds of assertion are made here, and they are complementary:
 *
 * - **Structural** — read back off `idbTransactions`: which transaction carried
 *   which operation, over which stores, in which mode. This is how "the read
 *   and the write are one transaction" and "it spans all three stores" are
 *   pinned; move the `getAll` out of the transaction and these go red
 *   immediately, whatever the timing happens to be that day.
 * - **Behavioural** — a concurrent write really issued while the read/merge/
 *   write is in flight, and then the store read back to show nothing was lost.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LIBRARY_FORMAT, type Deck, type Library } from '../../domain'
import { failNextWriteTo, idbOperations, idbTransactions, resetFakeIdb, settleIdb } from './idb.test-support'
import { createIndexedDbDeckStore } from './indexed-db-deck-store'
import { DECKS_STORE, MIXES_STORE, TOMBSTONES_STORE, openDatabase } from './database'
import { CURRENT_SCHEMA_VERSION } from './migrations'

function library(overrides: Partial<Library> = {}): Library {
  return {
    format: LIBRARY_FORMAT,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: 1,
    decks: [],
    mixes: [],
    tombstones: [],
    ...overrides,
  }
}

function deckRecord(id: string, name: string, phrases: Deck['phrases'] = []) {
  return { id, name, phrases: [...phrases], createdAt: 1, updatedAt: 1 }
}

/** The operations one transaction carried, in order, as `store:op`. */
function operationsOn(transaction: number): string[] {
  return idbOperations.filter((op) => op.transaction === transaction).map((op) => `${op.store}:${op.op}`)
}

/** The transactions that touched a store, newest last. */
function transactionsTouching(store: string): number[] {
  return [...new Set(idbOperations.filter((op) => op.store === store).map((op) => op.transaction))]
}

describe('DeckStore.updateAll is one transaction over all three stores (T074)', () => {
  beforeEach(() => {
    resetFakeIdb()
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(true) } })
  })

  it('reads, merges and writes on ONE transaction, holding decks, mixes and tombstones', async () => {
    const store = createIndexedDbDeckStore()
    await store.save({ id: 'd1', name: 'Marché', phrases: [{ id: 'p1', french: 'le pain', english: 'the bread' }] })
    idbOperations.length = 0

    await store.updateAll((stored) =>
      library({ decks: [...stored.decks, deckRecord('d2', 'Chez le médecin')] }),
    )

    const carriers = [
      ...new Set(
        idbOperations
          .filter((op) => [DECKS_STORE, MIXES_STORE, TOMBSTONES_STORE].includes(op.store))
          .map((op) => op.transaction),
      ),
    ]
    expect(carriers).toHaveLength(1)

    const carrier = idbTransactions.get(carriers[0])
    expect(carrier?.mode).toBe('readwrite')
    expect([...(carrier?.stores ?? [])].sort()).toEqual([DECKS_STORE, MIXES_STORE, TOMBSTONES_STORE].sort())

    // The read is INSIDE it, which is the whole claim — not merely that the
    // writes share a transaction.
    const carried = operationsOn(carriers[0])
    expect(carried.slice(0, 3).sort()).toEqual(
      [`${DECKS_STORE}:getAll`, `${MIXES_STORE}:getAll`, `${TOMBSTONES_STORE}:getAll`].sort(),
    )
    expect(carried).toContain(`${DECKS_STORE}:clear`)
    expect(carried).toContain(`${DECKS_STORE}:put`)
  })

  it('cannot compute away a Deck she saves while the merge is in flight', async () => {
    const store = createIndexedDbDeckStore()
    await store.save({ id: 'd1', name: 'Marché', phrases: [{ id: 'p1', french: 'le pain', english: 'the bread' }] })

    // Her save and the merge, genuinely in flight together — she taps Save at
    // the moment a round-trip lands, which is the whole of T074's case. The
    // merge writes back only what IT read, so if her save can commit between
    // that read and that write, the clear-and-rewrite erases her Deck. Run
    // against the `readLocal`/`writeLocal` pair `updateAll` replaced, this
    // fails: her Deck lands between the two transactions and is wiped.
    const herSave = store.save({
      id: 'hers',
      name: 'Chez le médecin',
      phrases: [{ id: 'p9', french: "j'ai mal ici", english: 'it hurts here' }],
    })
    const merge = store.updateAll((stored) =>
      library({ decks: stored.decks.map((d) => ({ ...d, name: `${d.name} (merged)` })) }),
    )
    const [, merged] = await Promise.all([herSave, merge])
    await settleIdb()

    expect(merged.changed).toBe(true)
    const names = (await store.loadAll()).map((d) => d.name)
    // Both survive: her save either commits before the merge reads — and is
    // merged in — or after it writes — and stands. There is no third outcome.
    expect(names).toContain('Chez le médecin')
    expect(names).toContain('Marché (merged)')
  })

  it('holds the decks store for the whole of the merge, so no other writer can slip in', async () => {
    const store = createIndexedDbDeckStore()
    await store.save({ id: 'd1', name: 'Marché', phrases: [] })
    const db = await openDatabase()

    // The merge's transaction, with a read outstanding — which is the state
    // `updateAll` is in for the whole of its read/merge/write, since every
    // await it makes is on a request of this same transaction.
    const merge = db.transaction([DECKS_STORE, MIXES_STORE, TOMBSTONES_STORE], 'readwrite')
    const read = merge.objectStore(DECKS_STORE).getAll()

    // Her save, issued now. It is its own transaction over the same store, and
    // it was created second.
    let landed = false
    const herSave = db.put(DECKS_STORE, deckRecord('hers', 'Chez le médecin')).then(() => {
      landed = true
    })

    await read
    expect(landed).toBe(false)
    await merge.objectStore(DECKS_STORE).put(deckRecord('d1', 'Marché (merged)'))
    expect(landed).toBe(false)

    await merge.done
    await herSave
    expect(landed).toBe(true)
    // And it is not lost either — it lands after, whole.
    expect(await db.get(DECKS_STORE, 'hers')).toMatchObject({ name: 'Chez le médecin' })
    expect(await db.get(DECKS_STORE, 'd1')).toMatchObject({ name: 'Marché (merged)' })
  })

  it('leaves every store exactly as it was when the update refuses the envelope', async () => {
    const store = createIndexedDbDeckStore()
    await store.save({ id: 'd1', name: 'Marché', phrases: [{ id: 'p1', french: 'le pain', english: 'the bread' }] })
    const before = await store.exportAll()
    idbOperations.length = 0

    await expect(
      store.updateAll(() => {
        throw new Error('library schema version 99 is newer than supported version')
      }),
    ).rejects.toThrow('newer than supported')
    await settleIdb()

    const after = await store.exportAll()
    expect(after.decks).toEqual(before.decks)
    expect(after.mixes).toEqual(before.mixes)
    expect(after.tombstones).toEqual(before.tombstones)
    // Not one destructive operation was even attempted on the way out.
    expect(idbOperations.filter((op) => op.op === 'clear' || op.op === 'delete')).toEqual([])
  })

  it('rolls the whole restore back when a write fails partway — nothing was replaced', async () => {
    const store = createIndexedDbDeckStore()
    await store.save({ id: 'd1', name: 'Marché', phrases: [{ id: 'p1', french: 'le pain', english: 'the bread' }] })
    const before = await store.exportAll()

    // A refused write on a phone under storage pressure — raised through the
    // implementation's own request pipeline, so the abort and the rollback are
    // real. `importAll` clears and rewrites the decks store BEFORE it reaches
    // the mixes store, so this fails after the damage would have been done and
    // the transaction has to undo it. `App.tsx` tells her "nothing was
    // replaced, and the Decks she had are still the Decks she has"; this is
    // that sentence, asserted.
    const incoming = library({
      decks: [deckRecord('d9', 'From the file')],
      mixes: [{ id: 'm1', name: 'Everything', deckIds: ['d9'], createdAt: 1, updatedAt: 1 }],
    })
    failNextWriteTo(MIXES_STORE)

    await expect(store.importAll(incoming)).rejects.toThrow()
    await settleIdb()

    const after = await store.exportAll()
    expect(after.decks).toEqual(before.decks)
    expect(after.mixes).toEqual([])
    expect(after.tombstones).toEqual(before.tombstones)
  })
})

describe('the skip-when-unchanged path in updateAll misses no change (T074)', () => {
  beforeEach(() => {
    resetFakeIdb()
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(true) } })
  })

  async function seeded() {
    const store = createIndexedDbDeckStore()
    await store.updateAll(() =>
      library({
        decks: [
          deckRecord('d1', 'Marché', [
            { id: 'p1', french: 'le pain', english: 'the bread' },
            { id: 'p2', french: 'le lait', english: 'the milk' },
          ]),
          deckRecord('d2', 'Gare'),
        ],
        mixes: [{ id: 'm1', name: 'Mornings', deckIds: ['d1'], createdAt: 1, updatedAt: 1 }],
        tombstones: [{ id: 'gone', kind: 'deck' as const, deletedAt: 1 }],
      }),
    )
    return store
  }

  it('skips the write, and only the write, when the update changed nothing', async () => {
    const store = await seeded()
    const before = await store.exportAll()
    idbOperations.length = 0

    const result = await store.updateAll((stored) => stored)

    expect(result.changed).toBe(false)
    expect(idbOperations.filter((op) => op.op === 'clear' || op.op === 'put')).toEqual([])
    const after = await store.exportAll()
    expect({ decks: after.decks, mixes: after.mixes, tombstones: after.tombstones }).toEqual({
      decks: before.decks,
      mixes: before.mixes,
      tombstones: before.tombstones,
    })
  })

  it('re-reading and writing back an identical library is not mistaken for a change', async () => {
    const store = await seeded()

    // `exportedAt` is stamped fresh on every read, so an envelope that is
    // byte-identical apart from it must still count as unchanged — otherwise
    // every idle sync writes the whole library back and re-renders her screen.
    const result = await store.updateAll((stored) => ({ ...stored, exportedAt: stored.exportedAt + 10_000 }))

    expect(result.changed).toBe(false)
  })

  const changes: [name: string, change: (stored: Library) => Library, sees: (stored: Library) => unknown][] = [
    [
      'a Phrase added to a Deck',
      (s) => ({
        ...s,
        decks: s.decks.map((d) =>
          d.id === 'd1'
            ? { ...d, phrases: [...d.phrases, { id: 'p3', french: 'le beurre', english: 'the butter' }] }
            : d,
        ),
      }),
      (s) => s.decks.find((d) => d.id === 'd1')?.phrases.map((p) => p.id),
    ],
    [
      'a Phrase whose text was corrected',
      (s) => ({
        ...s,
        decks: s.decks.map((d) =>
          d.id === 'd1'
            ? { ...d, phrases: d.phrases.map((p) => (p.id === 'p1' ? { ...p, french: 'la baguette' } : p)) }
            : d,
        ),
      }),
      (s) => s.decks.find((d) => d.id === 'd1')?.phrases.find((p) => p.id === 'p1')?.french,
    ],
    [
      'Phrases reordered inside a Deck',
      (s) => ({
        ...s,
        decks: s.decks.map((d) => (d.id === 'd1' ? { ...d, phrases: [...d.phrases].reverse() } : d)),
      }),
      (s) => s.decks.find((d) => d.id === 'd1')?.phrases.map((p) => p.id),
    ],
    [
      'a renamed Deck',
      (s) => ({ ...s, decks: s.decks.map((d) => (d.id === 'd2' ? { ...d, name: 'Gare du Nord' } : d)) }),
      (s) => s.decks.find((d) => d.id === 'd2')?.name,
    ],
    [
      'a Deck removed',
      (s) => ({ ...s, decks: s.decks.filter((d) => d.id !== 'd2') }),
      (s) => s.decks.map((d) => d.id),
    ],
    [
      'a Deck added',
      (s) => ({ ...s, decks: [...s.decks, deckRecord('d3', 'Pharmacie')] }),
      (s) => s.decks.map((d) => d.id).sort(),
    ],
    [
      'a Mix whose Deck ids changed',
      (s) => ({ ...s, mixes: s.mixes!.map((m) => ({ ...m, deckIds: ['d1', 'd2'] })) }),
      (s) => s.mixes?.[0]?.deckIds,
    ],
    [
      'a renamed Mix',
      (s) => ({ ...s, mixes: s.mixes!.map((m) => ({ ...m, name: 'Evenings' })) }),
      (s) => s.mixes?.[0]?.name,
    ],
    [
      'a Tombstone added',
      (s) => ({ ...s, tombstones: [...s.tombstones!, { id: 'd2', kind: 'deck' as const, deletedAt: 9 }] }),
      (s) => s.tombstones?.map((t) => t.id).sort(),
    ],
    [
      'a Tombstone dropped',
      (s) => ({ ...s, tombstones: [] }),
      (s) => s.tombstones?.length,
    ],
  ]

  it.each(changes)('reports and writes %s', async (_name, change, sees) => {
    const store = await seeded()
    const before = await store.exportAll()

    const result = await store.updateAll(change)

    const after = await store.exportAll()
    expect(result.changed).toBe(true)
    expect(sees(after)).toEqual(sees(change(before)))
    expect(sees(after)).not.toEqual(sees(before))
  })
})

describe('DeckStore.update is one transaction over the Deck it changes (T075)', () => {
  beforeEach(() => {
    resetFakeIdb()
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(true) } })
  })

  it('reads and writes the Deck on ONE readwrite transaction', async () => {
    const store = createIndexedDbDeckStore()
    await store.save({ id: 'd1', name: 'Marché', phrases: [{ id: 'p1', french: 'le pain', english: 'the bread' }] })
    idbOperations.length = 0

    await store.update('d1', (stored) => ({
      ...stored!,
      phrases: [...stored!.phrases, { id: 'p2', french: 'le lait', english: 'the milk' }],
    }))

    const carriers = transactionsTouching(DECKS_STORE)
    expect(carriers).toHaveLength(1)
    expect(idbTransactions.get(carriers[0])?.mode).toBe('readwrite')
    expect(operationsOn(carriers[0])).toEqual([`${DECKS_STORE}:get`, `${DECKS_STORE}:put`])
  })

  it('applies her edit to the STORED Deck, not to the render she tapped', async () => {
    const store = createIndexedDbDeckStore()
    await store.save({ id: 'd1', name: 'Marché', phrases: [{ id: 'p1', french: 'le pain', english: 'the bread' }] })

    // The render her tap was computed against.
    const rendered = (await store.get('d1'))!

    // A merge lands between that render and the write it produces — a Phrase
    // from her other phone. This is the T075 defect exactly: `App.persist`
    // used to put a whole Deck built from React state, so the merged Phrase
    // went away, and the Sync Baseline then held it while the local Deck did
    // not, which the next round-trip carried to the server as a deletion.
    await store.updateAll(() =>
      library({
        decks: [
          deckRecord('d1', 'Marché', [
            ...rendered.phrases,
            { id: 'p-other-phone', french: 'le fromage', english: 'the cheese' },
          ]),
        ],
      }),
    )

    // Her tap, arriving now, carrying the same pure change the screen showed.
    const addWine = (deck: Deck): Deck => ({
      ...deck,
      phrases: [...deck.phrases, { id: 'p-hers', french: 'le vin', english: 'the wine' }],
    })
    const saved = await store.update('d1', (stored) => addWine(stored ?? rendered))

    expect(saved.phrases.map((p) => p.id)).toEqual(['p1', 'p-other-phone', 'p-hers'])
    expect((await store.get('d1'))!.phrases.map((p) => p.id)).toEqual(['p1', 'p-other-phone', 'p-hers'])
  })

  it('cannot lose a merge landing while her edit is in flight', async () => {
    const store = createIndexedDbDeckStore()
    await store.save({ id: 'd1', name: 'Marché', phrases: [{ id: 'p1', french: 'le pain', english: 'the bread' }] })
    const rendered = (await store.get('d1'))!

    // Her edit and the merge, in flight together, both changing the same Deck.
    // The merge adds onto whatever it reads, the way `mergeLibraries` does, so
    // the only way a Phrase can be lost is the read-to-write window T075
    // exists to close. Run against a `get` and a `put` in two transactions —
    // what `App.persist` did — this fails: the merge commits in between and
    // her put writes it away.
    const addWine = (deck: Deck): Deck => ({
      ...deck,
      phrases: [...deck.phrases, { id: 'p-hers', french: 'le vin', english: 'the wine' }],
    })
    const herEdit = store.update('d1', (stored) => addWine(stored ?? rendered))
    const theMerge = store.updateAll((storedLibrary) =>
      library({
        decks: storedLibrary.decks.map((d) => ({
          ...d,
          phrases: [...d.phrases, { id: 'p-other-phone', french: 'le fromage', english: 'the cheese' }],
        })),
      }),
    )
    await Promise.all([herEdit, theMerge])
    await settleIdb()

    const ids = (await store.get('d1'))!.phrases.map((p) => p.id)
    expect(ids).toContain('p-hers')
    expect(ids).toContain('p-other-phone')
  })

  it('leaves the stored Deck untouched when apply refuses', async () => {
    const store = createIndexedDbDeckStore()
    await store.save({ id: 'd1', name: 'Marché', phrases: [{ id: 'p1', french: 'le pain', english: 'the bread' }] })
    const before = await store.get('d1')
    idbOperations.length = 0

    await expect(
      store.update('d1', () => {
        throw new Error('refused')
      }),
    ).rejects.toThrow('refused')
    await settleIdb()

    expect(await store.get('d1')).toEqual(before)
    expect(idbOperations.filter((op) => op.op === 'put')).toEqual([])
  })

  it('rolls back a write already made on the transaction when it aborts', async () => {
    // The property `update` and `updateAll` both depend on when they abort, at
    // the seam itself: a write made on a transaction that then aborts leaves
    // nothing behind. The hand-rolled double this suite used until T084 had
    // `abort: () => {}`, so it kept the guess.
    const db = await openDatabase()
    const tx = db.transaction([DECKS_STORE], 'readwrite')
    void tx.done.catch(() => {})
    await tx.objectStore(DECKS_STORE).put(deckRecord('guess', 'A guess'))
    tx.abort()
    await settleIdb()

    expect(await db.get(DECKS_STORE, 'guess')).toBeUndefined()
  })
})
