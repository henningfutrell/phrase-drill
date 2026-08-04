import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetFakeIdb } from '../storage/idb.test-support'

vi.mock('idb', async () => {
  const fake = await import('../storage/idb.test-support')
  return { openDB: fake.openDB }
})

// Imported after the mock is registered, per Vitest's hoisting contract.
const { createIndexedDbDeckStore } = await import('../storage/indexed-db-deck-store')
const { createIndexedDbSettingsStore } = await import('../storage/settings-store')
const { createSyncedLibrary } = await import('./synced-library')
const { createSyncEngine } = await import('./sync-engine')
const { LIBRARY_FORMAT } = await import('../../domain')
const { CURRENT_SCHEMA_VERSION } = await import('../storage/migrations')

type Library = import('../../domain').Library
type PlatformPort = import('./sync-engine').PlatformPort
type Scheduler = import('./sync-engine').Scheduler

/**
 * The whole round-trip against the real storage adapters (T074).
 *
 * This is deliberately not a unit test of the engine: the defect it pins is
 * the gap between the engine READING her library and WRITING the merge back,
 * and what closes that gap lives in the storage adapter. A fake local store
 * could be written to hide it either way, so both halves are real here and
 * only the network is faked.
 */

const HER_NEW_DECK = {
  id: 'd2',
  name: 'Chez le médecin',
  phrases: [{ id: 'p9', french: 'J’ai mal ici', english: 'It hurts here' }],
}

function remoteLibrary(): Library {
  return {
    format: LIBRARY_FORMAT,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: 1,
    decks: [{ id: 'r1', name: 'From the web', phrases: [], createdAt: 1, updatedAt: 1 }],
    mixes: [],
    tombstones: [],
  }
}

/** Timers that never fire, so a retry cannot quietly do the test's work. */
const frozenScheduler: Scheduler = {
  schedule() {
    return () => {}
  },
}

const onlinePlatform: PlatformPort = {
  isOnline: () => true,
  onOnline: () => () => {},
  onHidden: () => () => {},
}

/** Long enough for pull → read → merge → write → push → record to finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * One launch sync, with her save landing in the middle of it.
 *
 * The save is made from `baseline.read()`, which the round-trip awaits after
 * it has read the library and before it writes the merge back. That is the
 * window: she is holding the phone, a sync is not instant, and IndexedDB
 * takes her write the moment she makes it whether or not a sync is running.
 */
async function launchSyncWithAnEditPartWayThrough(): Promise<{
  storedDeckNames(): Promise<string[]>
  pushes: Library[]
}> {
  const deckStore = createIndexedDbDeckStore()
  const settingsStore = createIndexedDbSettingsStore()
  await deckStore.save({ id: 'd1', name: 'Home', phrases: [] })

  const pushes: Library[] = []
  let heldBaseline: Library | undefined
  let edited = false

  const engine = createSyncEngine({
    client: {
      async pull() {
        return { ok: true, library: remoteLibrary() }
      },
      async push(library) {
        pushes.push(library)
        return { ok: true }
      },
    },
    ...createSyncedLibrary({ deckStore, settingsStore }),
    baseline: {
      async read() {
        if (!edited) {
          edited = true
          await deckStore.save(HER_NEW_DECK)
        }
        return heldBaseline
      },
      async write(library) {
        heldBaseline = library
      },
    },
    readLastSyncAt: async () => null,
    recordSync: async () => {},
    now: () => 1_000,
    scheduler: frozenScheduler,
    platform: onlinePlatform,
  })

  engine.start()
  await settle()
  engine.stop()

  return {
    async storedDeckNames() {
      return (await deckStore.loadAll()).map((deck) => deck.name).sort()
    },
    pushes,
  }
}

describe('the sync round-trip against a library she is still editing (T074)', () => {
  beforeEach(() => {
    resetFakeIdb()
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(true) } })
  })

  it('keeps a Deck she saved after the round-trip read her library and before it wrote the merge', async () => {
    const run = await launchSyncWithAnEditPartWayThrough()

    expect(await run.storedDeckNames()).toEqual(['Chez le médecin', 'From the web', 'Home'])
  })

  it('pushes the Deck she saved mid-round-trip, so it is not left only on this phone', async () => {
    const run = await launchSyncWithAnEditPartWayThrough()

    expect(run.pushes).toHaveLength(1)
    expect(run.pushes[0]!.decks.map((deck) => deck.name).sort()).toEqual([
      'Chez le médecin',
      'From the web',
      'Home',
    ])
  })
})
