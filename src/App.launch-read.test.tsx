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
import { createSyncEngine, type SyncEngine, type SyncSnapshot } from './adapters/sync/sync-engine'
import { createSyncedLibrary } from './adapters/sync/synced-library'
import type { AudioElementLike } from './adapters/audio/clip-player'

/** Stands in for the DOM `<audio>` element `main.tsx` reads from `index.html` (T006). */
function fakeAudioElement(): AudioElementLike {
  const listeners: Record<string, Array<() => void>> = {}
  return {
    src: '',
    play: () => Promise.resolve(),
    pause: () => {},
    addEventListener(type, listener) {
      ;(listeners[type] ??= []).push(listener)
    },
    removeEventListener(type, listener) {
      listeners[type] = (listeners[type] ?? []).filter((l) => l !== listener)
    },
  }
}

/**
 * T083 — a storage failure at launch must not be a blank screen (T079 audit,
 * finding 7).
 *
 * Every write in the composition root goes through `persistLocally`, which has
 * both halves of the T069 contract: the screens are put back to what is really
 * on disk, and she is told which change did not survive.
 *
 * The two READS at launch had neither:
 *
 *     App.tsx  void Promise.all([deckStore.loadAll(), mixStore.loadAll()]).then(([...]) => {
 *     App.tsx  the same shape again on the `libraryRevision` re-read
 *
 * One-argument `.then`. No rejection handler on either. If the database cannot
 * be opened or read, `decks` stays `undefined` forever, `renderScreen` returns
 * a bare `<main className="screen" />`, and `WriteFailureNotice` is never
 * raised because nothing set `writeFailure`.
 *
 * `databaseTrouble` does NOT cover this. It reports exactly two conditions —
 * `blocked` and `terminated` (`database.ts:70`), the two IndexedDB signals
 * delivered through a callback. An `openDB` that REJECTS reaches neither: a
 * `VersionError` from a rolled-back build meeting a database a newer build
 * already upgraded, a refusal under storage pressure, a corrupt store. Those
 * all arrive as a rejected promise, and they land here.
 *
 * What she saw was a blank screen, on the app holding phrases that exist
 * nowhere else, with nothing to read and nothing to tap — the same picture as
 * "everything is gone". The path a non-technical user takes from there is
 * delete and reinstall, and on iOS that discards the origin's storage for real.
 *
 * `RestoreControl` is the one control that exists for exactly this moment, and
 * it was unreachable: `decks === undefined` returned before any screen
 * rendered. The failure that most needs Restore was exactly the failure that
 * hid it. That is what these tests pin.
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

/**
 * A store that reads once and then cannot be read again — the shape of the
 * SECOND launch read, the `libraryRevision` re-read after a merge lands.
 */
function readableOnceDeckStore(deck: Deck): DeckStore {
  let reads = 0
  const refuse = () => Promise.reject(new Error('UnknownError: the database could not be read'))
  return {
    loadAll: () => {
      reads += 1
      return reads === 1 ? Promise.resolve([deck]) : (refuse() as Promise<Deck[]>)
    },
    get: refuse as DeckStore['get'],
    save: refuse as DeckStore['save'],
    update: refuse as DeckStore['update'],
    remove: refuse as DeckStore['remove'],
    exportAll: () => Promise.resolve(emptyLibrary()),
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

/** A sync engine whose snapshot this test drives directly. */
function drivableSyncEngine(): SyncEngine & { emit: (snapshot: SyncSnapshot) => void } {
  let held: SyncSnapshot = { state: 'idle', lastSyncAt: null, libraryRevision: 0 }
  const listeners = new Set<(snapshot: SyncSnapshot) => void>()
  return {
    start() {},
    stop() {},
    requestSync() {},
    syncNow() {},
    async libraryRestored() {},
    snapshot: () => held,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emit(snapshot) {
      held = snapshot
      for (const listener of listeners) listener(snapshot)
    },
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

function render(deckStore: DeckStore, settingsStore: SettingsStore, syncEngine: SyncEngine): Promise<void> {
  return act(async () => {
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
        audioElement={fakeAudioElement()}
      />,
    )
  })
}

function settle(): Promise<void> {
  return act(async () => {
    for (let i = 0; i < 40; i += 1) await Promise.resolve()
  })
}

describe('T083 — a database that cannot be read at launch', () => {
  it('says so, and leaves Restore reachable', async () => {
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

    await render(deckStore, settingsStore, syncEngine)
    await settle()

    // 1: she is told. `persistLocally` raises this notice for a refused WRITE;
    // a refused READ now raises it too, instead of saying nothing at all.
    expect(container.querySelector('[data-testid="write-failure"]')).not.toBeNull()

    // 2: the screen is not empty of every word. A blank screen on the app that
    // holds phrases existing nowhere else reads as "everything is gone".
    expect(container.textContent).not.toBe('')

    // 3: Restore — the one control that exists for exactly this moment — is on
    // the screen she is looking at, not inside a tree that never mounted.
    expect(container.querySelector('[data-testid="restore-backup"]')).not.toBeNull()

    // 4: and it is on a screen written for this failure, reachable with no
    // navigation, because there is no navigation available from here.
    const screen = container.querySelector('[data-testid="library-unreadable"]')
    expect(screen).not.toBeNull()
    expect(screen!.querySelector('[data-testid="restore-backup"]')).not.toBeNull()
  })

  it('does not overstate it — nothing says her phrases are gone', async () => {
    await render(unreadableDeckStore(), settings(), drivableSyncEngine())
    await settle()

    const words = (container.textContent ?? '').toLowerCase()
    // She must not be sent to delete and reinstall: on iOS that discards the
    // origin's storage for real. The words have to say the opposite.
    expect(words).toContain('not been deleted')
    expect(words).toContain('do not delete this app')
    expect(words).not.toContain('gone')
    expect(words).not.toContain('lost')
  })

  it('a re-read that fails after a merge tells her without hiding the Decks she has', async () => {
    const deck: Deck = { id: 'd1', name: 'Café', phrases: [] }
    const deckStore = readableOnceDeckStore(deck)
    const syncEngine = drivableSyncEngine()

    await render(deckStore, settings(), syncEngine)
    await settle()
    expect(container.textContent).toContain('Café')

    // A merge landed, so the composition root re-reads both stores — and the
    // database refuses this time.
    await act(async () => {
      syncEngine.emit({ state: 'idle', lastSyncAt: null, libraryRevision: 1 })
    })
    await settle()

    expect(container.querySelector('[data-testid="write-failure"]')).not.toBeNull()
    // What is already on screen is real, stored data. Replacing it with the
    // recovery screen would hide her library to report a failed refresh.
    expect(container.textContent).toContain('Café')
    expect(container.querySelector('[data-testid="library-unreadable"]')).toBeNull()
  })
})
