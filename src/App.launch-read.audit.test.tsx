import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from './App'
import type { Deck, DeckStore, Library, MixStore, ScanReader, Translator } from './domain'
import { LIBRARY_FORMAT } from './domain'
import type { BoundedClipCache, DatabaseTroubleSource, Settings, SettingsStore } from './adapters/storage'
import type { SynthClient } from './adapters/audio/server-synth-client'
import type { GenerationQueue } from './adapters/audio/generation-queue'
import type { ErrorLog } from './adapters/diagnostics'
import { CURRENT_SCHEMA_VERSION } from './adapters/storage/migrations'
import { createSyncEngine, type SyncEngine } from './adapters/sync/sync-engine'
import { createSyncedLibrary } from './adapters/sync/synced-library'

/**
 * AUDIT T079 — FINDING 3.
 *
 * Every write in the composition root goes through `persistLocally`
 * (`App.tsx:345-353`), which has both halves of the T069 contract: the screens
 * are put back to what is really on disk, and she is told which change did not
 * survive.
 *
 * The two READS at launch have neither:
 *
 *     App.tsx:214   void Promise.all([deckStore.loadAll(), mixStore.loadAll()]).then(([...]) => {
 *     App.tsx:243   void Promise.all([deckStore.loadAll(), mixStore.loadAll()]).then(([...]) => {
 *
 * One-argument `.then`. No rejection handler on either. If the database cannot
 * be opened or read, `decks` stays `undefined` forever, `renderScreen`
 * (`App.tsx:752-754`) returns a bare `<main className="screen" />`, and
 * `WriteFailureNotice` is never raised because nothing set `writeFailure`.
 *
 * `databaseTrouble` does NOT cover this. It reports exactly two conditions —
 * `blocked` and `terminated` (`database.ts:70`), the two IndexedDB signals
 * through a callback. An `openDB` that REJECTS reaches neither: a `VersionError`
 * from a rolled-back build meeting a database a newer build already upgraded, a
 * refusal under storage pressure, a corrupt store. Those all arrive as a
 * rejected promise, and this is where they land.
 *
 * What she sees is a blank screen, on the app that holds phrases that exist
 * nowhere else, with nothing to read and nothing to tap — the same picture as
 * "everything is gone". The path a non-technical user takes from there is
 * delete and reinstall, and on iOS that discards the origin's storage for real.
 *
 * The empty state is also the ONLY screen carrying `RestoreControl` on the
 * Decks screen ("the screen a wiped or replaced phone actually opens on" —
 * `RestoreControl.tsx`), and it is unreachable here: `decks === undefined`
 * returns before any screen renders. She cannot restore her way out either.
 */

function settings(): SettingsStore {
  let held: Settings = { voice: null, lastSyncAt: null, lastExportAt: null }
  return {
    async load() {
      return held
    },
    async setVoice(voice) {
      held = { ...held, voice }
    },
    async adoptVoice(voice) {
      if (voice) held = { ...held, voice }
    },
    async recordSync(timestamp) {
      held = { ...held, lastSyncAt: timestamp }
    },
    async recordExport(timestamp) {
      held = { ...held, lastExportAt: timestamp }
    },
  }
}

function emptyLibrary(): Library {
  return {
    format: LIBRARY_FORMAT,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: 0,
    decks: [],
    mixes: [],
    tombstones: [],
  }
}

/** A deck store whose database cannot be read — an `openDB` that rejected. */
function unreadableDeckStore(): DeckStore {
  const refuse = () => Promise.reject(new Error('UnknownError: the database could not be opened'))
  return {
    loadAll: refuse as () => Promise<Deck[]>,
    get: refuse as DeckStore['get'],
    save: refuse as DeckStore['save'],
    update: refuse as DeckStore['update'],
    remove: refuse as DeckStore['remove'],
    exportAll: refuse as () => Promise<Library>,
    importAll: refuse as DeckStore['importAll'],
    updateAll: refuse as DeckStore['updateAll'],
  }
}

function emptyMixStore(): MixStore {
  return {
    async loadAll() {
      return []
    },
    async save() {},
    async remove() {},
  }
}

const noopSynth: SynthClient = { async synthesize() { return { bytes: new ArrayBuffer(0), durationMs: 0 } } }
const noopQueue: GenerationQueue = {
  enqueue() {},
  statusFor() {
    return undefined
  },
  async whenIdle() {},
}
const noopClipCache: BoundedClipCache = {
  async get() {
    return undefined
  },
  async put() {},
  async has() {
    return false
  },
  async readyPhraseIds() {
    return new Set()
  },
  async usage() {
    return { bytes: 0, clipCount: 0, maxBytes: 1 }
  },
}
const noopScan: ScanReader = { async read() { return [] } }
const noopTranslate: Translator = { async translate() { return [] } }
const noopErrorLog: ErrorLog = {
  async record() {},
  async list() {
    return []
  },
}
const noopTrouble: DatabaseTroubleSource = { subscribe: () => () => {} }

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('AUDIT T079 — a database that cannot be read at launch says nothing at all', () => {
  it('shows a blank screen with no notice and no way to restore', async () => {
    const deckStore = unreadableDeckStore()
    const settingsStore = settings()
    const syncEngine: SyncEngine = createSyncEngine({
      client: {
        async pull() {
          return { ok: true, library: emptyLibrary() }
        },
        async push() {
          return { ok: true }
        },
      },
      ...createSyncedLibrary({ deckStore, settingsStore }),
      baseline: {
        async read() {
          return undefined
        },
        async write() {},
      },
      readLastSyncAt: async () => null,
      recordSync: async () => {},
      scheduler: { schedule: () => () => {} },
      platform: { isOnline: () => true, onOnline: () => () => {}, onHidden: () => () => {} },
      debounceMs: 0,
    })

    await act(async () => {
      root.render(
        <App
          deckStore={deckStore}
          mixStore={emptyMixStore()}
          settingsStore={settingsStore}
          synthClient={noopSynth}
          generationQueue={noopQueue}
          clipCache={noopClipCache}
          scanReader={noopScan}
          errorLog={noopErrorLog}
          syncEngine={syncEngine}
          translator={noopTranslate}
          databaseTrouble={noopTrouble}
        />,
      )
    })
    await act(async () => {
      for (let i = 0; i < 40; i += 1) await Promise.resolve()
    })

    // DEMONSTRATION 1: no notice. `persistLocally` would have raised one for a
    // failed WRITE; a failed READ raises nothing.
    expect(container.querySelector('[data-testid="write-failure"]')).not.toBeNull()

    // DEMONSTRATION 2: the screen is empty of every word. She is looking at an
    // app that has lost its voice, holding phrases that exist nowhere else.
    expect(container.textContent).not.toBe('')

    // DEMONSTRATION 3: Restore — the one control that exists for exactly this
    // moment — never renders, because `decks === undefined` returns first.
    expect(container.querySelector('[data-testid="restore-backup"]')).not.toBeNull()
  })
})
