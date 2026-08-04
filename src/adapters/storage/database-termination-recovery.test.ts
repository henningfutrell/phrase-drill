import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IDBPDatabase } from 'idb'
import type { Deck, Library, Mix } from '../../domain'
import { LIBRARY_FORMAT } from '../../domain'
import { CURRENT_SCHEMA_VERSION } from './migrations'
import { resetFakeIdb, settleIdb, terminateConnection } from './idb.test-support'

/**
 * What every store does when the BROWSER closes the connection underneath it
 * (T077 — the other half of T087).
 *
 * T087 made each store forget a database open that REJECTED. This is the
 * failure that arrives after the open succeeded: iOS closes the connection
 * under memory pressure, `database.ts` reports `terminated` to
 * `databaseTrouble`, and the handle every store is holding is dead. T087's
 * `.catch()` never fires — nothing rejected — so each store went on handing
 * out the same dead handle, and every write for the rest of the session failed
 * against it. The app told her to close and reopen it; the app can repair
 * itself instead.
 *
 * **Why one store's `terminated` clears all five.** T087 rejected a SHARED
 * module-level handle, because that couples five adapters through mutable
 * module state and lets one store's failure invalidate another's live
 * connection. Nothing here is shared: each store keeps its own slot, and the
 * event only makes it FORGET one. Forgetting cannot invalidate a live
 * connection — the handle is not closed, in-flight work is untouched, and the
 * cost of being wrong is one redundant re-open. And `terminated` is a fact
 * about the database, not about one adapter: the browser reclaiming this
 * origin's storage does not pick a favourite among five connections to one
 * database.
 *
 * The `idb` seam is the real package over fake-indexeddb (T084), wrapped only
 * so the handles the stores open can be reached and closed the way the browser
 * closes them — the same narrow interception `database-open-recovery.test.ts`
 * uses.
 */

const control = vi.hoisted(() => ({
  /** Every database handle the stores have opened, in order. */
  opened: [] as unknown[],
  opens: 0,
}))

vi.mock('idb', async () => {
  const actual = await vi.importActual<typeof import('idb')>('idb')
  return {
    ...actual,
    openDB: async (...args: Parameters<typeof actual.openDB>) => {
      control.opens += 1
      const db = await actual.openDB(...args)
      control.opened.push(db)
      return db
    },
  }
})

const { createIndexedDbDeckStore } = await import('./indexed-db-deck-store')
const { createIndexedDbMixStore } = await import('./indexed-db-mix-store')
const { createIndexedDbSettingsStore } = await import('./settings-store')
const { createIndexedDbSyncBaselineStore } = await import('./sync-baseline-store')
const { createIndexedDbErrorLog } = await import('../diagnostics/error-log')

function makeDeck(overrides: Partial<Deck> = {}): Deck {
  return {
    id: 'deck-1',
    name: 'Home',
    phrases: [{ id: 'p1', french: 'Bonjour', english: 'Hello' }],
    ...overrides,
  }
}

function makeMix(overrides: Partial<Mix> = {}): Mix {
  return { id: 'mix-1', name: 'Mornings', deckIds: ['deck-1'], ...overrides }
}

function makeLibrary(): Library {
  return {
    format: LIBRARY_FORMAT,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: 1,
    decks: [{ id: 'deck-1', name: 'Home', phrases: [], createdAt: 1, updatedAt: 1 }],
    mixes: [],
    tombstones: [],
  }
}

/** Be the browser, closing the connection the store most recently opened. */
async function closeLastConnection(): Promise<void> {
  terminateConnection(control.opened.at(-1) as IDBPDatabase)
  await settleIdb(2)
}

describe('a store whose connection the browser closed', () => {
  beforeEach(() => {
    resetFakeIdb()
    control.opened.length = 0
    control.opens = 0
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(true) } })
  })

  it('saves her Decks again, instead of writing to a dead handle for the session', async () => {
    const store = createIndexedDbDeckStore()
    await store.save(makeDeck())

    await closeLastConnection()

    // The phrases she writes after that moment are the whole point.
    await store.save(makeDeck({ id: 'deck-2', name: 'Marché' }))
    expect((await store.loadAll()).map((deck) => deck.id).sort()).toEqual(['deck-1', 'deck-2'])
  })

  it('saves a Mix again', async () => {
    const store = createIndexedDbMixStore()
    await store.loadAll()

    await closeLastConnection()

    await store.save(makeMix())
    expect(await store.loadAll()).toEqual([makeMix()])
  })

  it('writes settings again', async () => {
    const store = createIndexedDbSettingsStore()
    await store.load()

    await closeLastConnection()

    const voice = { provider: 'elevenlabs', modelId: 'eleven_v3', voiceId: 'amelie' }
    await store.setVoice(voice)
    expect((await store.load()).voice).toEqual(voice)
  })

  it('writes the sync baseline again', async () => {
    const store = createIndexedDbSyncBaselineStore()
    await store.read()

    await closeLastConnection()

    await store.write(makeLibrary())
    expect(await store.read()).toEqual(makeLibrary())
  })

  it('records errors again', async () => {
    const log = createIndexedDbErrorLog({ getSecrets: () => Promise.resolve([]) })
    await log.list()

    await closeLastConnection()

    await log.record({ timestamp: 1, source: 'sync', message: 'push refused' })
    expect(await log.list()).toMatchObject([{ source: 'sync', message: 'push refused' }])
  })

  /**
   * `terminated` names the database, not the adapter that happened to be in
   * use. The browser reclaiming this origin's storage does not pick a
   * favourite among five connections to one database, and `databaseTrouble`
   * carries no connection identity to pick with — so every store forgets, and
   * the store that was merely idle pays one redundant re-open.
   *
   * That price is the whole of the coupling T087 was right to refuse in its
   * other form: forgetting a slot cannot invalidate a live connection, close a
   * handle, or disturb work in flight. It can only cost an `openDB`. The
   * alternative — leaving four stores holding handles the browser has already
   * closed — costs her writes.
   */
  it('makes every store forget, not only the one whose connection died', async () => {
    const deckStore = createIndexedDbDeckStore()
    const settingsStore = createIndexedDbSettingsStore()
    await deckStore.loadAll()
    await settingsStore.load()
    const opensBefore = control.opens

    // Only the settings store's connection is closed.
    await closeLastConnection()

    // The deck store, which was idle, opens again on its next call anyway.
    await deckStore.save(makeDeck())
    await settingsStore.recordSync(42)
    expect(control.opens).toBe(opensBefore + 2)
    expect(await deckStore.loadAll()).toEqual([makeDeck()])
    expect((await settingsStore.load()).lastSyncAt).toBe(42)
  })

  /**
   * Forgetting a handle is a retry, not a loop. Nothing re-opens on its own:
   * the next call the app makes opens once, and that is all.
   */
  it('re-opens exactly once, on the next call, and not before', async () => {
    const store = createIndexedDbDeckStore()
    await store.loadAll()
    const opensBefore = control.opens

    await closeLastConnection()
    expect(control.opens).toBe(opensBefore)

    await store.loadAll()
    await store.loadAll()
    expect(control.opens).toBe(opensBefore + 1)
  })
})
