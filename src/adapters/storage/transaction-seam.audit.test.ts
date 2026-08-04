import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetFakeIdb } from './idb.test-support'

/**
 * T080 audit of T074 (`updateAll`) and T075 (`update`) — the EVIDENCE, not a
 * defect claim.
 *
 * Both fixes rest entirely on one property of IndexedDB: a `readwrite`
 * transaction is indivisible. T074: "read/merge/write in ONE transaction …
 * there is no third outcome". T075: "every step between the `get` and the
 * `put` is synchronous, so nothing can land in between". T072/`importAll`:
 * "one transaction over all three stores, so a refusal rolls the whole restore
 * back — nothing was replaced".
 *
 * The `idb` seam every one of those tests runs against is
 * `src/adapters/storage/idb.test-support.ts`, and it provides NONE of that:
 *
 *     done: Promise.resolve(),
 *     abort: () => {},
 *
 * — every operation is applied to the backing `Map` the moment it is called,
 * `abort()` does nothing, `done` is already settled, and `transaction()`
 * ignores its scope and takes no locks. So the double cannot distinguish the
 * fixed code from the code before the fix on the property the fixes are ABOUT.
 * `sync-round-trip-race.test.ts` passes because it injects her save inside
 * `baseline.read()` — i.e. before `updateLocal` is even called, which only
 * pins that the read happens late. Nothing exercises the read-to-write window
 * the transaction is there to close.
 *
 * These tests assert the two properties the claims need. They FAIL. That is
 * not proof the app is broken — real IndexedDB does provide both, and reading
 * the adapters I could not construct an interleave that survives real IDB
 * semantics. It is proof that the guarantee is currently unwitnessed: if
 * someone moves the `getAll` out of the transaction tomorrow, every existing
 * test still passes.
 */

/** Set to a store name to make every `put` against it reject. */
const failPutOn = { store: '' }

vi.mock('idb', async () => {
  const fake = await import('./idb.test-support')
  return {
    async openDB(name: string, version: number, callbacks?: Record<string, unknown>) {
      const db = (await fake.openDB(name, version, callbacks as never)) as Record<string, unknown>
      const guard = (store: string, ops: Record<string, unknown>) => ({
        ...ops,
        put: async (...args: unknown[]) => {
          if (failPutOn.store === store) throw new Error('QuotaExceededError')
          return (ops.put as (...a: unknown[]) => Promise<unknown>)(...args)
        },
      })
      return {
        ...db,
        transaction(names: string | string[], mode?: string) {
          const tx = (db.transaction as (n: unknown, m?: unknown) => Record<string, unknown>)(names, mode)
          return {
            ...tx,
            objectStore: (store: string) =>
              guard(store, (tx.objectStore as (s: string) => Record<string, unknown>)(store)),
          }
        },
      }
    },
  }
})

const { createIndexedDbDeckStore } = await import('./indexed-db-deck-store')
const { DECKS_STORE, MIXES_STORE, openDatabase } = await import('./database')
const { LIBRARY_FORMAT } = await import('../../domain')
const { CURRENT_SCHEMA_VERSION } = await import('./migrations')

type Library = import('../../domain').Library

describe('T080 audit — the transaction seam T074/T075 rest on', () => {
  beforeEach(() => {
    resetFakeIdb()
    failPutOn.store = ''
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(true) } })
  })

  /**
   * `update` and `updateAll` both call `tx.abort()` on a refusal, "rather than
   * writing a guess". Under the double, abort writes the guess.
   */
  it('aborting a transaction undoes the writes made on it', async () => {
    const db = await openDatabase()
    const tx = db.transaction([DECKS_STORE], 'readwrite')
    await tx.objectStore(DECKS_STORE).put({ id: 'd1', name: 'guess', phrases: [], createdAt: 1, updatedAt: 1 })
    tx.abort()

    expect(await db.get(DECKS_STORE, 'd1')).toBeUndefined()
  })

  /**
   * A `readwrite` transaction holds its object stores until it commits, which
   * is exactly what makes "there is no third outcome" true. Under the double
   * a second writer walks straight in.
   */
  it('a second writer cannot land inside an open readwrite transaction', async () => {
    const db = await openDatabase()
    const tx = db.transaction([DECKS_STORE], 'readwrite')
    const store = tx.objectStore(DECKS_STORE)
    await store.getAll()

    // Her save, made while the merge transaction is open.
    let landed = false
    void db.put(DECKS_STORE, { id: 'hers', name: 'Chez le médecin', phrases: [], createdAt: 1, updatedAt: 1 }).then(() => {
      landed = true
    })
    await Promise.resolve()

    expect(landed).toBe(false)
  })

  /**
   * The consequence for the restore path. `App.tsx` tells her "nothing was
   * replaced, and the Decks she had are still the Decks she has" when
   * `importAll` rejects. Under the double the decks store is already cleared
   * and rewritten by the time the mixes write fails, so that sentence is
   * asserted by nothing at all.
   */
  it('a restore that fails partway leaves her existing Decks in place', async () => {
    const deckStore = createIndexedDbDeckStore()
    await deckStore.save({ id: 'd1', name: 'Marché', phrases: [{ id: 'p1', french: 'le pain', english: 'the bread' }] })

    const incoming: Library = {
      format: LIBRARY_FORMAT,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      exportedAt: 1,
      decks: [{ id: 'd9', name: 'From the file', phrases: [], createdAt: 1, updatedAt: 1 }],
      mixes: [{ id: 'm1', name: 'Everything', deckIds: ['d9'], createdAt: 1, updatedAt: 1 }],
      tombstones: [],
    }

    failPutOn.store = MIXES_STORE
    await expect(deckStore.importAll(incoming)).rejects.toThrow()
    failPutOn.store = ''

    const after = (await deckStore.loadAll()).map((d) => d.name)
    expect(after).toEqual(['Marché'])
  })
})
