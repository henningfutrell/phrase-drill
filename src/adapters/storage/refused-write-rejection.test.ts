import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIBRARY_FORMAT, type Deck, type Library } from '../../domain'
import { CURRENT_SCHEMA_VERSION } from './migrations'
import { DECKS_STORE, MIXES_STORE, TOMBSTONES_STORE } from './database'
import {
  failNextWriteTo,
  resetFakeIdb,
  settleIdb,
  throwOnNextWriteTo,
} from './idb.test-support'
import { createIndexedDbDeckStore } from './indexed-db-deck-store'
import { createIndexedDbMixStore } from './indexed-db-mix-store'

/**
 * What a REFUSED write leaves behind (T077).
 *
 * Two separate defects, both about the transaction rather than the record:
 *
 * 1. **A rejection nobody awaits.** `update`, `updateAll` and `importAll` each
 *    read `tx.done` on the path where they abort deliberately, and none of them
 *    read it where a write fails. The `put` rejects, the function throws, and
 *    `tx.done` is left rejecting `AbortError` with no handler. On her phone
 *    that reaches `error-capture.ts`'s `unhandledrejection` listener and is
 *    logged as a SECOND captured error, on top of the one she was already
 *    shown — and the error log is what Diagnostics reports. No record is at
 *    risk; the rollback is correct (T084 proved it under real transaction
 *    semantics). This is noise on top of a real failure.
 *
 * 2. **A synchronously-thrown `put` does not abort at all.** `DataCloneError`
 *    and `DataError` are raised at request creation, so no request exists to
 *    fire `error`, nothing aborts on the app's behalf, and the transaction
 *    AUTO-COMMITS whatever it has already done. In `importAll` that is a
 *    `clear()` of all three stores plus the Decks written before the bad one:
 *    her library replaced by a fragment. It is not reachable from app data
 *    today — `importAll` values come from `JSON.parse` — and it is the one
 *    error class the rollback did not cover, so it is closed by the same
 *    `try`/`catch` rather than by machinery of its own.
 *
 * The unhandled rejection is observed through Node's `unhandledRejection`,
 * which is the runtime signal `error-capture.ts` subscribes to in a browser as
 * `window.onunhandledrejection`. Own listener rather than the runner's, so the
 * assertion is a value in the test rather than a report on the side.
 */

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

/**
 * The runner's own process, reached off `globalThis` rather than through
 * `@types/node`: `tsc -b` compiles `src/` as browser code and has no Node
 * types in scope, and this file is the only thing in `src/` that wants one.
 */
const runtime = (
  globalThis as unknown as {
    process: {
      on(event: 'unhandledRejection', listener: (reason: unknown) => void): void
      off(event: 'unhandledRejection', listener: (reason: unknown) => void): void
    }
  }
).process

let unhandled: unknown[] = []
const collect = (reason: unknown): void => {
  unhandled.push(reason)
}

/** Every rejection that reached the runtime with no handler, after settling. */
async function unhandledRejections(): Promise<unknown[]> {
  await settleIdb()
  return unhandled
}

describe('a write the database refuses leaves no rejection for the crash handler (T077)', () => {
  beforeEach(() => {
    resetFakeIdb()
    unhandled = []
    runtime.on('unhandledRejection', collect)
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(true) } })
  })

  afterEach(() => {
    runtime.off('unhandledRejection', collect)
  })

  it('update: the caller is told once, and nothing is left rejecting', async () => {
    const store = createIndexedDbDeckStore()
    await store.save({ id: 'd1', name: 'Marché', phrases: [] })

    failNextWriteTo(DECKS_STORE)
    await expect(store.update('d1', (stored) => ({ ...stored!, name: 'Le marché' }))).rejects.toThrow()

    expect(await unhandledRejections()).toEqual([])
    // The rollback is unchanged — this fix is about the second error, not the record.
    expect((await store.loadAll())[0]?.name).toBe('Marché')
  })

  it('updateAll: the caller is told once, and nothing is left rejecting', async () => {
    const store = createIndexedDbDeckStore()
    await store.save({ id: 'd1', name: 'Marché', phrases: [] })

    failNextWriteTo(DECKS_STORE)
    await expect(
      store.updateAll((stored) => library({ decks: [...stored.decks, deckRecord('d2', 'Chez le médecin')] })),
    ).rejects.toThrow()

    expect(await unhandledRejections()).toEqual([])
    expect((await store.loadAll()).map((deck) => deck.id)).toEqual(['d1'])
  })

  it('importAll: the caller is told once, and nothing is left rejecting', async () => {
    const store = createIndexedDbDeckStore()
    await store.save({ id: 'd1', name: 'Marché', phrases: [] })

    failNextWriteTo(DECKS_STORE)
    await expect(store.importAll(library({ decks: [deckRecord('d2', 'Chez le médecin')] }))).rejects.toThrow()

    expect(await unhandledRejections()).toEqual([])
    expect((await store.loadAll()).map((deck) => deck.id)).toEqual(['d1'])
  })

  it('remove: the Tombstone write being refused leaves nothing rejecting either', async () => {
    const store = createIndexedDbDeckStore()
    await store.save({ id: 'd1', name: 'Marché', phrases: [] })

    failNextWriteTo(TOMBSTONES_STORE)
    await expect(store.remove('d1')).rejects.toThrow()

    expect(await unhandledRejections()).toEqual([])
    // The Deck is still there: a delete with no Tombstone is a delete every
    // other device undoes, so the two roll back together or not at all (T060).
    expect((await store.loadAll()).map((deck) => deck.id)).toEqual(['d1'])
  })

  it('the mix store rolls back the same way, and just as quietly', async () => {
    const deckStore = createIndexedDbDeckStore()
    const mixStore = createIndexedDbMixStore()
    await deckStore.save({ id: 'd1', name: 'Marché', phrases: [] })
    await mixStore.save({ id: 'm1', name: 'Mornings', deckIds: ['d1'] })

    failNextWriteTo(TOMBSTONES_STORE)
    await expect(mixStore.remove('m1')).rejects.toThrow()

    expect(await unhandledRejections()).toEqual([])
    expect((await mixStore.loadAll()).map((mix) => mix.id)).toEqual(['m1'])
  })
})

describe('a write that throws at request creation still rolls back (T077)', () => {
  beforeEach(() => {
    resetFakeIdb()
    unhandled = []
    runtime.on('unhandledRejection', collect)
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(true) } })
  })

  afterEach(() => {
    runtime.off('unhandledRejection', collect)
  })

  /**
   * The restore path's promise is "nothing was replaced". A `DataCloneError`
   * is thrown, not reported through a request, so the abort IndexedDB performs
   * on a failed request never happens — without an explicit abort the
   * transaction commits the `clear()` it already did.
   */
  it('importAll leaves her library exactly as it was, not cleared', async () => {
    const store = createIndexedDbDeckStore()
    const mixStore = createIndexedDbMixStore()
    await store.save({ id: 'd1', name: 'Marché', phrases: [{ id: 'p1', french: 'le pain', english: 'the bread' }] })
    await mixStore.save({ id: 'm1', name: 'Mornings', deckIds: ['d1'] })

    throwOnNextWriteTo(DECKS_STORE)
    await expect(store.importAll(library({ decks: [deckRecord('d2', 'Chez le médecin')] }))).rejects.toThrow(
      /DataCloneError/,
    )

    await settleIdb()
    const decks = await store.loadAll()
    expect(decks.map((deck) => deck.id)).toEqual(['d1'])
    expect(decks[0]?.phrases).toEqual([{ id: 'p1', french: 'le pain', english: 'the bread' }])
    expect((await mixStore.loadAll()).map((mix) => mix.id)).toEqual(['m1'])
    expect(await unhandledRejections()).toEqual([])
  })

  it('updateAll leaves her library exactly as it was', async () => {
    const store = createIndexedDbDeckStore()
    await store.save({ id: 'd1', name: 'Marché', phrases: [] })

    throwOnNextWriteTo(DECKS_STORE)
    await expect(
      store.updateAll((stored) => library({ decks: [...stored.decks, deckRecord('d2', 'Chez le médecin')] })),
    ).rejects.toThrow(/DataCloneError/)

    await settleIdb()
    expect((await store.loadAll()).map((deck) => deck.id)).toEqual(['d1'])
  })

  it('the stores it never reached are untouched as well', async () => {
    const store = createIndexedDbDeckStore()
    await store.importAll(library({ decks: [deckRecord('d1', 'Marché')] }))

    // MIXES is cleared before DECKS is written, so a throw on the deck write
    // has already destroyed the mixes unless the transaction rolls back.
    throwOnNextWriteTo(MIXES_STORE)
    await expect(
      store.importAll(
        library({
          decks: [deckRecord('d2', 'X')],
          mixes: [{ id: 'm1', name: 'Mornings', deckIds: ['d2'], createdAt: 1, updatedAt: 1 }],
        }),
      ),
    ).rejects.toThrow(/DataCloneError/)

    await settleIdb()
    expect((await store.loadAll()).map((deck) => deck.id)).toEqual(['d1'])
  })
})
