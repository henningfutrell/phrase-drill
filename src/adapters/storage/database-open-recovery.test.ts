import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Deck, Library, Mix } from '../../domain'
import { LIBRARY_FORMAT } from '../../domain'
import { CURRENT_SCHEMA_VERSION } from './migrations'
import { resetFakeIdb } from './idb.test-support'

/**
 * What every store that opens this database does when the open is refused
 * once (T087, extending T085 from the clip cache to the rest).
 *
 * Each store memoized its handle as `dbPromise ??= openDatabase()`. **A
 * rejected promise is still a settled promise**, so one refusal was recorded
 * as firmly as a success and replayed for every later call: no retry was ever
 * attempted, for the whole life of the store instance.
 *
 * In the clip cache (T085) the cost of that was silence — audio is derived and
 * can always be made again. In the DECK store the cost is her work. Every
 * write is optimistic (`App.tsx` `persistLocally`): the screen changes first
 * and the store is written after. A deck store whose handle is a remembered
 * rejection refuses every write for the rest of the session, and the only
 * repair is a relaunch she has no reason to attempt — she has been told a
 * change did not save, not that nothing will ever save again. She scans a
 * page of phrases written nowhere else, closes the app, and they are gone.
 *
 * The triggers are ordinary on the one phone this app has to work on: iOS
 * closing the connection under memory pressure, a `versionchange` raised by
 * another surface, transient storage pressure at launch.
 *
 * **A retry is not a loop.** Nothing here retries by itself. Forgetting the
 * failed handle means the NEXT call the app makes opens again; a database that
 * is persistently refusing therefore rejects once per call she makes, each
 * rejection reaching `persistLocally` -> `WriteFailureNotice` (T069) or the
 * launch-failure screen (T083) exactly as it does today. The last test in this
 * file pins that: one open per call, no hidden second attempt, and the
 * rejection still reaches the caller.
 *
 * The `idb` seam is the real package over fake-indexeddb (T084), wrapped only
 * so `openDB` can be made to reject on demand — the same narrow interception
 * `clip-cache-resilience.test.ts` uses.
 */

const control = vi.hoisted(() => ({
  /** How many further `openDB` calls reject. */
  failingOpens: 0,
  /** How many times `openDB` has been called at all. */
  opens: 0,
}))

vi.mock('idb', async () => {
  const actual = await vi.importActual<typeof import('idb')>('idb')
  return {
    ...actual,
    openDB: (...args: Parameters<typeof actual.openDB>) => {
      control.opens += 1
      if (control.failingOpens > 0) {
        control.failingOpens--
        return Promise.reject(new Error('idb: the database could not be opened'))
      }
      return actual.openDB(...args)
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

describe('a store whose database refused to open once', () => {
  beforeEach(() => {
    resetFakeIdb()
    control.failingOpens = 0
    control.opens = 0
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(true) } })
  })

  it('saves her Decks again after one refused open, instead of refusing every write for the session', async () => {
    const store = createIndexedDbDeckStore()

    control.failingOpens = 1
    await expect(store.loadAll()).rejects.toThrow()

    // The phrases she writes after that moment are the whole point.
    await store.save(makeDeck())
    expect(await store.loadAll()).toEqual([makeDeck()])
  })

  it('saves a Mix again after one refused open', async () => {
    const store = createIndexedDbMixStore()

    control.failingOpens = 1
    await expect(store.loadAll()).rejects.toThrow()

    await store.save(makeMix())
    expect(await store.loadAll()).toEqual([makeMix()])
  })

  it('writes settings again after one refused open', async () => {
    const store = createIndexedDbSettingsStore()

    control.failingOpens = 1
    await expect(store.load()).rejects.toThrow()

    const voice = { provider: 'elevenlabs', modelId: 'eleven_v3', voiceId: 'amelie' }
    await store.setVoice(voice)
    expect((await store.load()).voice).toEqual(voice)
  })

  it('writes the sync baseline again after one refused open', async () => {
    const store = createIndexedDbSyncBaselineStore()

    control.failingOpens = 1
    await expect(store.read()).rejects.toThrow()

    // Without this the baseline is never written again, and every merge for
    // the rest of the session falls back to whole-record rules.
    await store.write(makeLibrary())
    expect(await store.read()).toEqual(makeLibrary())
  })

  it('records errors again after one refused open', async () => {
    const log = createIndexedDbErrorLog({ getSecrets: () => Promise.resolve([]) })

    control.failingOpens = 1
    await expect(log.list()).rejects.toThrow()

    // The diagnostics report is how a failure gets described to anyone who
    // could fix it. A log that gave up first records nothing about the rest.
    await log.record({ timestamp: 1, source: 'sync', message: 'push refused' })
    expect(await log.list()).toMatchObject([{ source: 'sync', message: 'push refused' }])
  })

  it('opens once per call while the database keeps refusing, and still rejects to the caller', async () => {
    const store = createIndexedDbDeckStore()

    control.failingOpens = 3
    control.opens = 0

    // Every call must still fail loudly — that is what reaches `persistLocally`
    // and the T069 notice. Forgetting the handle must not become a retry loop
    // that hides a persistent failure behind a spinner.
    await expect(store.loadAll()).rejects.toThrow()
    await expect(store.save(makeDeck())).rejects.toThrow()
    await expect(store.loadAll()).rejects.toThrow()

    expect(control.opens).toBe(3)
  })
})
