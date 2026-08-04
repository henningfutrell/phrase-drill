import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type {
  Deck,
  DeckStore,
  DraftPhrase,
  Library,
  Mix,
  MixStore,
  PhraseCandidate,
  ScanReader,
  Tombstone,
  Translator,
} from './domain'
import { LIBRARY_FORMAT } from './domain'
import type { BoundedClipCache, ClipCacheUsage, Settings, SettingsStore, Voice } from './adapters/storage'
import type { SynthClient, SynthResult } from './adapters/audio/server-synth-client'
import type { GenerationQueue } from './adapters/audio/generation-queue'
import type { ErrorLog, LogEntry } from './adapters/diagnostics'
import type { LibrarySyncClient, PullResult, PushResult } from './adapters/sync/library-sync-client'
import { createSyncEngine, type PlatformPort, type Scheduler, type SyncEngine } from './adapters/sync/sync-engine'
import { CURRENT_SCHEMA_VERSION } from './adapters/storage/migrations'

vi.mock('./adapters/share/web-share', () => ({
  shareBackupFile: vi.fn().mockResolvedValue('shared'),
}))
const { shareBackupFile } = await import('./adapters/share/web-share')

vi.mock('./adapters/device/install-state', () => ({
  readInstallStateFromBrowser: vi.fn(() => ({ platform: 'ios', installed: true })),
}))
const { readInstallStateFromBrowser } = await import('./adapters/device/install-state')

/** In-memory SettingsStore fake — the real one is exercised in
 * src/adapters/storage; App's wiring is what these tests care about. */
function createFakeSettingsStore(initial: Partial<Settings> = {}): SettingsStore {
  let settings: Settings = {
    voice: null,
    lastSyncAt: null,
    lastExportAt: null,
    ...initial,
  }
  return {
    async load() {
      return settings
    },
    async setVoice(voice) {
      settings = { ...settings, voice }
    },
    async recordSync(timestamp) {
      settings = { ...settings, lastSyncAt: timestamp }
    },
    async recordExport(timestamp) {
      settings = { ...settings, lastExportAt: timestamp }
    },
  }
}

/** In-memory LibrarySyncClient fake — the real adapter is exercised in
 * src/adapters/sync; App's wiring (push after every mutation, pull-once on
 * an empty mount) is what these tests care about. Defaults to a library
 * with no existing server copy, so App's pull-on-empty-mount path is a
 * harmless no-op unless a test wires it otherwise. */
function createFakeLibrarySyncClient(
  overrides: Partial<LibrarySyncClient> = {},
): LibrarySyncClient & { pushed: Library[] } {
  const pushed: Library[] = []
  return {
    pushed,
    async push(library): Promise<PushResult> {
      pushed.push(library)
      return { ok: true }
    },
    async pull(): Promise<PullResult> {
      return { ok: false, reason: 'not-found' }
    },
    ...overrides,
  }
}

/** In-memory DeckStore fake — the real DeckStore is exercised in
 * src/adapters/storage; this fake only lets App's wiring to the port be
 * asserted without a browser IndexedDB. It keeps `updatedAt` per Deck and a
 * Tombstone per removal, because those are what App's sync path merges on
 * (T060); `now` is injectable so a two-device test can date one device's
 * writes before the other's. */
function createFakeDeckStore(
  initial: readonly Deck[] = [],
  now: () => number = () => Date.now(),
): DeckStore & { decks: Map<string, Deck> } {
  const decks = new Map(initial.map((d) => [d.id, d]))
  const updatedAt = new Map(initial.map((d) => [d.id, 0]))
  const tombstones = new Map<string, Tombstone>()
  return {
    decks,
    async loadAll() {
      return [...decks.values()]
    },
    async get(id) {
      return decks.get(id)
    },
    async save(deck) {
      decks.set(deck.id, deck)
      updatedAt.set(deck.id, now())
    },
    async remove(id) {
      decks.delete(id)
      updatedAt.delete(id)
      tombstones.set(id, { id, kind: 'deck', deletedAt: now() })
    },
    async exportAll(): Promise<Library> {
      return {
        format: LIBRARY_FORMAT,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        exportedAt: now(),
        decks: [...decks.values()].map((d) => ({
          id: d.id,
          name: d.name,
          phrases: d.phrases,
          createdAt: 0,
          updatedAt: updatedAt.get(d.id) ?? 0,
        })),
        tombstones: [...tombstones.values()],
      }
    },
    async importAll(library) {
      decks.clear()
      updatedAt.clear()
      tombstones.clear()
      for (const record of library.decks) {
        decks.set(record.id, { id: record.id, name: record.name, phrases: record.phrases })
        updatedAt.set(record.id, record.updatedAt)
      }
      for (const tombstone of library.tombstones ?? []) {
        tombstones.set(tombstone.id, tombstone)
      }
    },
  }
}

/** In-memory MixStore fake — the real IndexedDB store is exercised in
 * src/adapters/storage; App's wiring to the port is what these tests care
 * about. */
function createFakeMixStore(initial: readonly Mix[] = []): MixStore & { mixes: Map<string, Mix> } {
  const mixes = new Map(initial.map((m) => [m.id, m]))
  return {
    mixes,
    async loadAll() {
      return [...mixes.values()]
    },
    async save(mix) {
      mixes.set(mix.id, mix)
    },
    async remove(id) {
      mixes.delete(id)
    },
  }
}

/** In-memory SynthClient fake — the real ElevenLabs adapter is exercised in
 * src/adapters/audio; App's wiring (which text/voice it hands over, whether
 * it aborts) is what these tests care about. */
function createFakeSynthClient(): SynthClient & { synthesize: ReturnType<typeof vi.fn> } {
  const synthesize = vi.fn(
    async (): Promise<SynthResult> => ({ bytes: new ArrayBuffer(0), durationMs: 0 }),
  )
  return { synthesize }
}

/** A GenerationQueue fake that only records what it was asked to enqueue —
 * the real queue is exercised in src/adapters/audio; App's wiring is what
 * these tests care about. `enqueue` never resolves, by design: it proves the
 * Phrase save itself is never gated on generation completing. */
function createFakeGenerationQueue(): GenerationQueue & { enqueued: Array<{ id: string; french: string; english: string }> } {
  const enqueued: Array<{ id: string; french: string; english: string }> = []
  return {
    enqueued,
    enqueue(phrase) {
      enqueued.push({ id: phrase.id, french: phrase.french, english: phrase.english })
    },
    statusFor() {
      return undefined
    },
    async whenIdle() {},
  }
}

/** In-memory ClipCache fake — the real IndexedDB cache is exercised in
 * src/adapters/storage; App's wiring of the readiness gate is what these
 * tests care about. `readyIds`/`readyPhraseIds` default to "nothing ready",
 * which is the honest default for a fresh app. */
function createFakeClipCache(
  readyIds: ReadonlySet<string> = new Set(),
  usage: ClipCacheUsage = { bytes: 149_100_000, clipCount: 3190, maxBytes: 209_715_200 },
): BoundedClipCache {
  return {
    async get() {
      return undefined
    },
    async put() {},
    async has() {
      return false
    },
    async readyPhraseIds(phrases) {
      return new Set(phrases.map((p) => p.id).filter((id) => readyIds.has(id)))
    },
    async usage() {
      return usage
    },
  }
}

/** In-memory ScanReader fake — the real Claude vision adapter is exercised in
 * src/adapters/vision; App's wiring (apiKeyPresent gating, save handling) is
 * what these tests care about. */
function createFakeScanReader(): ScanReader & { read: ReturnType<typeof vi.fn> } {
  const read = vi.fn<ScanReader['read']>()
  return { read }
}

/** In-memory Translator fake — the real server adapter is exercised in
 * src/adapters/translation; App's wiring (candidate acceptance routed to the
 * right Deck(s)) is what these tests care about. Never resolves by default,
 * mirroring createFakeScanReader — most tests here don't exercise it at all. */
function createFakeTranslator(): Translator & { translate: ReturnType<typeof vi.fn> } {
  const translate = vi.fn<Translator['translate']>()
  return { translate }
}

/** In-memory ErrorLog fake — the real IndexedDB-backed ring buffer is
 * exercised in src/adapters/diagnostics; App's wiring (does Diagnostics show
 * what's in the log) is what these tests care about. */
function createFakeErrorLog(entries: readonly LogEntry[] = []): ErrorLog {
  return {
    async record() {},
    async list() {
      return entries
    },
  }
}

const FAKE_VOICE: Voice = { provider: 'elevenlabs', modelId: 'm1', voiceId: 'v1' }

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function click(el: Element): void {
  ;(el as HTMLElement).click()
}

/** Lets the sync engine's fire-and-forget round-trip settle before an
 * assertion — it's not awaited by the click handler itself (persisting the
 * Phrase text must never be gated on the sync round-trip). Deep enough for
 * the whole chain: debounce → pull → read → merge → write → push → record. */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 40; i += 1) await Promise.resolve()
  })
}

/** A baseline that lives only as long as the device it belongs to — a second
 * mount is a second device, and it has never agreed anything with the server. */
function createFakeBaseline() {
  let held: Library | undefined
  return {
    async read() {
      return held
    },
    async write(library: Library) {
      held = library
    },
  }
}

/** Timers that fire as soon as the microtask queue is drained, so a test
 * asserts on sync behaviour rather than on wall-clock debounce windows (those
 * are pinned directly in src/adapters/sync/sync-engine.test.ts). */
function immediateScheduler(): Scheduler {
  return {
    schedule(fn, ms) {
      let cancelled = false
      // Only the zero-delay debounce these tests configure runs. A retry
      // backoff is a real delay and is left un-fired on purpose: firing it as
      // a microtask would re-arm itself forever and never let the queue drain.
      if (ms <= 0) {
        void Promise.resolve().then(() => {
          if (!cancelled) fn()
        })
      }
      return () => {
        cancelled = true
      }
    },
  }
}

function alwaysOnline(): PlatformPort {
  return { isOnline: () => true, onOnline: () => () => {}, onHidden: () => () => {} }
}

/** The real sync engine over test doubles — App's own tests drive the real
 * merge and the real round-trip, because "nothing is lost" is a property of
 * the two together, not of either alone. */
function createTestSyncEngine(
  deckStore: DeckStore,
  settingsStore: SettingsStore,
  client: LibrarySyncClient,
  platform: PlatformPort = alwaysOnline(),
): SyncEngine {
  return createSyncEngine({
    client,
    readLocal: () => deckStore.exportAll(),
    writeLocal: (library) => deckStore.importAll(library),
    baseline: createFakeBaseline(),
    readLastSyncAt: async () => (await settingsStore.load()).lastSyncAt,
    recordSync: (timestamp) => settingsStore.recordSync(timestamp),
    scheduler: immediateScheduler(),
    platform,
    debounceMs: 0,
  })
}

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

async function renderApp(
  store: DeckStore,
  settingsStore: SettingsStore = createFakeSettingsStore(),
  synthClient: SynthClient = createFakeSynthClient(),
  generationQueue: GenerationQueue = createFakeGenerationQueue(),
  clipCache: BoundedClipCache = createFakeClipCache(),
  scanReader: ScanReader = createFakeScanReader(),
  errorLog: ErrorLog = createFakeErrorLog(),
  librarySyncClient: LibrarySyncClient = createFakeLibrarySyncClient(),
  translator: Translator = createFakeTranslator(),
  mixStore: MixStore = createFakeMixStore(),
  syncEngine: SyncEngine = createTestSyncEngine(store, settingsStore, librarySyncClient),
) {
  await act(async () => {
    root.render(
      <App
        mixStore={mixStore}
        deckStore={store}
        settingsStore={settingsStore}
        synthClient={synthClient}
        generationQueue={generationQueue}
        clipCache={clipCache}
        scanReader={scanReader}
        errorLog={errorLog}
        syncEngine={syncEngine}
        translator={translator}
      />,
    )
  })
  await flushMicrotasks()
}

describe('App wired to DeckStore', () => {
  it('loads Decks from the store on mount and renders them', async () => {
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    await renderApp(store)
    expect(container.textContent).toContain('Home')
  })

  it('creating a Deck persists it through DeckStore.save', async () => {
    const store = createFakeDeckStore([])
    await renderApp(store)
    act(() => click(container.querySelector('[data-testid="new-deck"]')!))
    const input = container.querySelector('[data-testid="deck-name-input"]') as HTMLInputElement
    act(() => typeInto(input, 'Work'))
    await act(async () => click(container.querySelector('[data-testid="deck-name-save"]')!))

    expect(store.decks.size).toBe(1)
    const saved = [...store.decks.values()][0]
    expect(saved.name).toBe('Work')
    expect(saved.phrases).toEqual([])
    expect(typeof saved.id).toBe('string')
    expect(saved.id.length).toBeGreaterThan(0)
  })

  it('opens a Deck and adds a Phrase, persisting the whole Deck through save', async () => {
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    await renderApp(store)
    act(() => click(container.querySelector('[data-testid="deck-row-d1"]')!))
    act(() => click(container.querySelector('[data-testid="add-phrase"]')!))
    const french = container.querySelector('[data-testid="phrase-french-input"]') as HTMLInputElement
    const english = container.querySelector('[data-testid="phrase-english-input"]') as HTMLInputElement
    act(() => typeInto(french, 'Bonjour'))
    act(() => typeInto(english, 'Hello'))
    await act(async () => click(container.querySelector('[data-testid="phrase-save"]')!))

    const saved = store.decks.get('d1')!
    expect(saved.phrases).toHaveLength(1)
    expect(saved.phrases[0]).toMatchObject({ french: 'Bonjour', english: 'Hello' })
  })

  it('reordering a Phrase persists the new order through save', async () => {
    const store = createFakeDeckStore([
      {
        id: 'd1',
        name: 'Home',
        phrases: [
          { id: 'p1', french: 'a', english: 'a' },
          { id: 'p2', french: 'b', english: 'b' },
        ],
      },
    ])
    await renderApp(store)
    act(() => click(container.querySelector('[data-testid="deck-row-d1"]')!))
    await act(async () => click(container.querySelector('[data-testid="move-down-p1"]')!))

    const saved = store.decks.get('d1')!
    expect(saved.phrases.map((p) => p.id)).toEqual(['p2', 'p1'])
  })

  it('deleting a Deck removes it through DeckStore.remove and returns to the list', async () => {
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    await renderApp(store)
    act(() => click(container.querySelector('[data-testid="deck-row-d1"]')!))
    act(() => click(container.querySelector('[data-testid="delete-deck"]')!))
    await act(async () => click(container.querySelector('[data-testid="confirm-delete-deck"]')!))

    expect(store.decks.has('d1')).toBe(false)
    expect(container.querySelector('[data-testid="deck-row-d1"]')).toBeNull()
  })
})

describe('App wired to the audio generation queue', () => {
  it('queues generation for both Clips when a Phrase is saved, without gating the persisted text on it', async () => {
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    const generationQueue = createFakeGenerationQueue()
    await renderApp(store, createFakeSettingsStore(), createFakeSynthClient(), generationQueue)
    act(() => click(container.querySelector('[data-testid="deck-row-d1"]')!))
    act(() => click(container.querySelector('[data-testid="add-phrase"]')!))
    const french = container.querySelector('[data-testid="phrase-french-input"]') as HTMLInputElement
    const english = container.querySelector('[data-testid="phrase-english-input"]') as HTMLInputElement
    act(() => typeInto(french, 'Bonjour'))
    act(() => typeInto(english, 'Hello'))
    await act(async () => click(container.querySelector('[data-testid="phrase-save"]')!))

    // The text is persisted even though the fake queue's enqueue() never
    // resolves — proves the save is not gated on generation.
    const saved = store.decks.get('d1')!
    expect(saved.phrases).toHaveLength(1)
    expect(generationQueue.enqueued).toEqual([
      { id: saved.phrases[0]!.id, french: 'Bonjour', english: 'Hello' },
    ])
  })

  it('re-queues generation for both Clips when a Phrase is edited', async () => {
    const store = createFakeDeckStore([
      { id: 'd1', name: 'Home', phrases: [{ id: 'p1', french: 'Bonjour', english: 'Hello' }] },
    ])
    const generationQueue = createFakeGenerationQueue()
    await renderApp(store, createFakeSettingsStore(), createFakeSynthClient(), generationQueue)
    act(() => click(container.querySelector('[data-testid="deck-row-d1"]')!))
    act(() => click(container.querySelector('[data-testid="edit-phrase-p1"]')!))
    const french = container.querySelector('[data-testid="phrase-french-input"]') as HTMLInputElement
    act(() => typeInto(french, 'Bonsoir'))
    await act(async () => click(container.querySelector('[data-testid="phrase-save"]')!))

    expect(store.decks.get('d1')!.phrases[0]).toMatchObject({ french: 'Bonsoir', english: 'Hello' })
    expect(generationQueue.enqueued).toEqual([{ id: 'p1', french: 'Bonsoir', english: 'Hello' }])
  })
})

async function openSettings(): Promise<void> {
  await act(async () => click(container.querySelector('[data-testid="open-settings"]')!))
}

describe('App wired to backup and restore', () => {
  beforeEach(() => {
    vi.mocked(shareBackupFile).mockClear()
    vi.mocked(shareBackupFile).mockResolvedValue('shared')
    vi.mocked(readInstallStateFromBrowser).mockReturnValue({ platform: 'ios', installed: true })
  })

  it('exports the whole library through DeckStore.exportAll and hands it to the share adapter', async () => {
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    await renderApp(store)
    await openSettings()

    await act(async () => click(container.querySelector('[data-testid="backup-status-export"]')!))

    expect(shareBackupFile).toHaveBeenCalledTimes(1)
    const [file] = vi.mocked(shareBackupFile).mock.calls[0]!
    expect(file.type).toBe('application/json')
    expect(file.name).toMatch(/^phrase-drill-backup-\d{4}-\d{2}-\d{2}\.json$/)
    const text = await file.text()
    expect(JSON.parse(text)).toMatchObject({ format: LIBRARY_FORMAT })
  })

  it('has the backup File already built before the tap, so the share call never loses its user activation', async () => {
    // WebKit expires transient activation across an await (webkit.org/blog/13862).
    // An `await deckStore.exportAll()` between her tap and `navigator.share()`
    // is exactly the shape that makes Export a button that does nothing.
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    await renderApp(store)
    await openSettings()

    const exportAllSpy = vi.spyOn(store, 'exportAll')
    click(container.querySelector('[data-testid="backup-status-export"]')!)

    expect(shareBackupFile).toHaveBeenCalledTimes(1)
    expect(exportAllSpy).not.toHaveBeenCalled()
    await act(async () => {})
  })

  it('never falls back to a download in an installed web app — it offers the text to copy instead', async () => {
    // WebKit 290847: a download inside a standalone iOS web app opens an
    // "Open in…" splash with no navigation out of it, and she has to force-quit.
    vi.mocked(shareBackupFile).mockResolvedValue('unsupported')
    vi.mocked(readInstallStateFromBrowser).mockReturnValue({ platform: 'ios', installed: true })
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    const createObjectURL = vi.fn().mockReturnValue('blob:fake')
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() })

    await renderApp(store)
    await openSettings()
    await act(async () => click(container.querySelector('[data-testid="backup-status-export"]')!))

    expect(createObjectURL).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="backup-copy-sheet"]')).not.toBeNull()
    vi.unstubAllGlobals()
  })

  it('does fall back to a plain download in an ordinary browser tab, where a download is safe', async () => {
    vi.mocked(shareBackupFile).mockResolvedValue('unsupported')
    vi.mocked(readInstallStateFromBrowser).mockReturnValue({ platform: 'other', installed: false })
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    const createObjectURL = vi.fn().mockReturnValue('blob:fake')
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() })

    await renderApp(store)
    await openSettings()
    await act(async () => click(container.querySelector('[data-testid="backup-status-export"]')!))

    expect(createObjectURL).toHaveBeenCalled()
    expect(container.querySelector('[data-testid="backup-status-result"]')?.textContent).toMatch(/download|files/i)
    vi.unstubAllGlobals()
  })

  it('replaces the whole library through DeckStore.importAll once a valid backup is confirmed', async () => {
    const store = createFakeDeckStore([{ id: 'stale', name: 'Stale', phrases: [] }])
    const replacement: Library = {
      format: LIBRARY_FORMAT,
      schemaVersion: 1,
      exportedAt: 1,
      decks: [{ id: 'fresh', name: 'Fresh', phrases: [], createdAt: 1, updatedAt: 1 }],
    }
    let imported: Library | undefined
    store.importAll = async (library) => {
      imported = library
      store.decks = new Map(library.decks.map((d) => [d.id, { id: d.id, name: d.name, phrases: d.phrases }]))
    }
    store.loadAll = async () => [...store.decks.values()]

    await renderApp(store)
    await openSettings()

    const file = new File([JSON.stringify(replacement)], 'phrase-drill-backup-2026-08-02.json', {
      type: 'application/json',
    })
    const input = container.querySelector('[data-testid="restore-file-input"]') as HTMLInputElement
    Object.defineProperty(input, 'files', {
      value: { 0: file, length: 1, item: (i: number) => (i === 0 ? file : null) } as unknown as FileList,
      configurable: true,
    })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    await act(async () => click(container.querySelector('[data-testid="restore-confirm"]')!))

    expect(imported).toEqual(replacement)
  })

  it('does not touch DeckStore at all when the chosen file is not a valid backup', async () => {
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    let importCalled = false
    store.importAll = async () => {
      importCalled = true
    }
    await renderApp(store)
    await openSettings()

    const file = new File(['not json'], 'notes.txt', { type: 'text/plain' })
    const input = container.querySelector('[data-testid="restore-file-input"]') as HTMLInputElement
    Object.defineProperty(input, 'files', {
      value: { 0: file, length: 1, item: (i: number) => (i === 0 ? file : null) } as unknown as FileList,
      configurable: true,
    })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))

    expect(container.querySelector('[data-testid="restore-confirm-sheet"]')).toBeNull()
    expect(importCalled).toBe(false)
  })
})

describe('App wired to voice preview and selection', () => {
  it('previews the first phrase in the library, in the tapped voice, through SynthClient', async () => {
    const store = createFakeDeckStore([
      { id: 'd1', name: 'Home', phrases: [{ id: 'p1', french: 'Où est la gare ?', english: 'Where is the station?' }] },
    ])
    const synthClient = createFakeSynthClient()
    await renderApp(store, createFakeSettingsStore(), synthClient)
    await openSettings()

    const firstVoice = container.querySelector('[data-testid^="voice-preview-"]') as HTMLButtonElement
    await act(async () => click(firstVoice))

    expect(synthClient.synthesize).toHaveBeenCalledTimes(1)
    const [text, lang] = synthClient.synthesize.mock.calls[0]!
    expect(text).toBe('Où est la gare ?')
    expect(lang).toBe('fr-FR')
  })

  it('falls back to a built-in French phrase to preview when the library has no phrases', async () => {
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    const synthClient = createFakeSynthClient()
    await renderApp(store, createFakeSettingsStore(), synthClient)
    await openSettings()

    const firstVoice = container.querySelector('[data-testid^="voice-preview-"]') as HTMLButtonElement
    await act(async () => click(firstVoice))

    const [text] = synthClient.synthesize.mock.calls[0]!
    expect(typeof text).toBe('string')
    expect((text as string).length).toBeGreaterThan(0)
  })

  it('persists the picked voice through SettingsStore.setVoice once the regeneration warning is confirmed', async () => {
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    const settingsStore = createFakeSettingsStore()
    const setVoiceSpy = vi.spyOn(settingsStore, 'setVoice')
    await renderApp(store, settingsStore)
    await openSettings()

    const chooseButton = container.querySelector('[data-testid^="voice-choose-"]') as HTMLButtonElement
    const voiceTestId = chooseButton.getAttribute('data-testid')!
    const voiceId = voiceTestId.replace('voice-choose-', '')
    await act(async () => click(chooseButton))
    await act(async () => click(container.querySelector('[data-testid="voice-confirm"]')!))

    expect(setVoiceSpy).toHaveBeenCalledWith(expect.objectContaining({ provider: 'elevenlabs', voiceId }))
  })

  it('shows the newly picked voice as current after it is chosen', async () => {
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    await renderApp(store)
    await openSettings()

    const chooseButton = container.querySelector('[data-testid^="voice-choose-"]') as HTMLButtonElement
    const voiceTestId = chooseButton.getAttribute('data-testid')!
    const voiceId = voiceTestId.replace('voice-choose-', '')
    await act(async () => click(chooseButton))
    await act(async () => click(container.querySelector('[data-testid="voice-confirm"]')!))

    expect(container.querySelector(`[data-testid="voice-current-${voiceId}"]`)).not.toBeNull()
  })
})

describe('App wired to the Drill screen', () => {
  it('launches a Drill over a whole Deck from Deck detail, gated on readiness', async () => {
    const store = createFakeDeckStore([
      {
        id: 'd1',
        name: 'Home',
        phrases: [
          { id: 'p1', french: 'Bonjour', english: 'Hello' },
          { id: 'p2', french: 'Merci', english: 'Thanks' },
        ],
      },
    ])
    const clipCache = createFakeClipCache(new Set(['p1']))
    await renderApp(
      store,
      createFakeSettingsStore({ voice: FAKE_VOICE }),
      createFakeSynthClient(),
      createFakeGenerationQueue(),
      clipCache,
    )
    act(() => click(container.querySelector('[data-testid="deck-row-d1"]')!))
    await act(async () => click(container.querySelector('[data-testid="drill-deck"]')!))

    expect(container.querySelector('[data-testid="drill-title"]')?.textContent).toBe('Home')
    expect(container.querySelector('[data-testid="drill-phrase-count"]')?.textContent).toBe('1 phrases')
    expect(container.querySelector('[data-testid="drill-skipped-count"]')?.textContent).toContain(
      'no audio yet',
    )
  })

  it('blocks the Drill with a no-voice message, and Open Settings routes to Settings and back', async () => {
    const store = createFakeDeckStore([
      { id: 'd1', name: 'Home', phrases: [{ id: 'p1', french: 'Bonjour', english: 'Hello' }] },
    ])
    await renderApp(store, createFakeSettingsStore({ voice: null }))
    act(() => click(container.querySelector('[data-testid="deck-row-d1"]')!))
    await act(async () => click(container.querySelector('[data-testid="drill-deck"]')!))

    expect(container.querySelector('[data-testid="drill-blocked"]')?.textContent).toContain(
      'No voice has been chosen yet',
    )
    await act(async () => click(container.querySelector('[data-testid="drill-open-settings"]')!))
    expect(container.querySelector('[data-testid="settings-back"]')).not.toBeNull()

    await act(async () => click(container.querySelector('[data-testid="settings-back"]')!))
    expect(container.querySelector('[data-testid="drill-blocked"]')?.textContent).toContain(
      'No voice has been chosen yet',
    )
  })

  it('leaves Deck detail in place behind the Drill, so Back from the Drill returns to it', async () => {
    const store = createFakeDeckStore([
      { id: 'd1', name: 'Home', phrases: [{ id: 'p1', french: 'Bonjour', english: 'Hello' }] },
    ])
    const clipCache = createFakeClipCache(new Set(['p1']))
    await renderApp(store, createFakeSettingsStore({ voice: FAKE_VOICE }), createFakeSynthClient(), createFakeGenerationQueue(), clipCache)
    act(() => click(container.querySelector('[data-testid="deck-row-d1"]')!))
    await act(async () => click(container.querySelector('[data-testid="drill-deck"]')!))
    expect(container.querySelector('[data-testid="drill-start-card"]')).not.toBeNull()

    await act(async () => click(container.querySelector('[data-testid="drill-back"]')!))
    expect(container.querySelector('[data-testid="drill-start-card"]')).toBeNull()
    expect(container.querySelector('[data-testid="rename-deck"]')?.textContent).toBe('Home')
  })

  it('opens the Mix screen from Decks, and hands a multi-Deck selection to the Drill as a combined pool', async () => {
    const store = createFakeDeckStore([
      { id: 'd1', name: 'Home', phrases: [{ id: 'p1', french: 'Bonjour', english: 'Hello' }] },
      { id: 'd2', name: 'Work', phrases: [{ id: 'p2', french: 'Réunion', english: 'Meeting' }] },
    ])
    const clipCache = createFakeClipCache(new Set(['p1', 'p2']))
    await renderApp(store, createFakeSettingsStore({ voice: FAKE_VOICE }), createFakeSynthClient(), createFakeGenerationQueue(), clipCache)

    await act(async () => click(container.querySelector('[data-testid="open-mix"]')!))
    act(() => click(container.querySelector('[data-testid="deck-chip-d1"]')!))
    act(() => click(container.querySelector('[data-testid="deck-chip-d2"]')!))
    await act(async () => click(container.querySelector('[data-testid="start-mix"]')!))

    expect(container.querySelector('[data-testid="drill-phrase-count"]')?.textContent).toBe('2 phrases')
  })
})

describe('App wired to Import', () => {
  it('opens Import from Decks and returns to Decks when cancelled', async () => {
    const store = createFakeDeckStore([])
    await renderApp(store)

    await act(async () => click(container.querySelector('[data-testid="open-import"]')!))
    expect(container.querySelector('[data-testid="take-photo"]')).not.toBeNull()

    await act(async () => click(container.querySelector('[data-testid="cancel-import"]')!))
    expect(container.querySelector('[data-testid="open-import"]')).not.toBeNull()
  })

  it('offers capture immediately — there is no on-device key to be missing any more', async () => {
    const store = createFakeDeckStore([])
    const scanReader = createFakeScanReader()
    await renderApp(
      store,
      createFakeSettingsStore(),
      createFakeSynthClient(),
      createFakeGenerationQueue(),
      createFakeClipCache(),
      scanReader,
    )

    await act(async () => click(container.querySelector('[data-testid="open-import"]')!))
    expect(container.querySelector('[data-testid="take-photo"]')).not.toBeNull()
    expect(scanReader.read).not.toHaveBeenCalled()
  })

  it('confirming a Scan creates the target Deck, persists the Phrases through DeckStore, and queues generation for each', async () => {
    const store = createFakeDeckStore([])
    const scanReader = createFakeScanReader()
    const drafts: DraftPhrase[] = [
      { french: 'Bonjour', english: 'Hello' },
      { french: 'Merci', english: 'Thanks' },
    ]
    scanReader.read.mockResolvedValue(drafts)
    const generationQueue = createFakeGenerationQueue()
    await renderApp(
      store,
      createFakeSettingsStore(),
      createFakeSynthClient(),
      generationQueue,
      createFakeClipCache(),
      scanReader,
    )

    await act(async () => click(container.querySelector('[data-testid="open-import"]')!))
    const input = container.querySelector('[data-testid="take-photo-input"]') as HTMLInputElement
    Object.defineProperty(input, 'files', {
      value: { 0: new File(['x'], 'p.jpg', { type: 'image/jpeg' }), length: 1, item: () => null } as unknown as FileList,
      configurable: true,
    })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))

    await act(async () => click(container.querySelector('[data-testid="new-deck-option"]')!))
    const nameInput = container.querySelector('[data-testid="deck-name-input"]') as HTMLInputElement
    act(() => typeInto(nameInput, 'Scanned'))
    act(() => click(container.querySelector('[data-testid="deck-name-save"]')!))
    await act(async () => click(container.querySelector('[data-testid="save-import"]')!))

    const saved = [...store.decks.values()].find((d) => d.name === 'Scanned')
    expect(saved).toBeDefined()
    expect(saved!.phrases.map((p) => ({ french: p.french, english: p.english }))).toEqual(drafts)
    expect(generationQueue.enqueued.map((p) => ({ french: p.french, english: p.english }))).toEqual(drafts)
    // Import is left behind — she lands somewhere that shows the result, not back on the capture screen.
    expect(container.querySelector('[data-testid="take-photo"]')).toBeNull()
  })
})

describe('App wired to translate-and-add candidates (T057 scope addition)', () => {
  it('accepting candidates routed to two different Decks persists each into its own Deck through DeckStore, and queues generation for each', async () => {
    vi.useFakeTimers()
    try {
      const store = createFakeDeckStore([
        { id: 'd1', name: 'Home', phrases: [] },
        { id: 'd2', name: 'Formal', phrases: [] },
      ])
      const translator = createFakeTranslator()
      const candidates: PhraseCandidate[] = [
        { text: 'Tu peux venir?', register: 'tu' },
        { text: 'Pouvez-vous venir?', register: 'vous' },
      ]
      translator.translate.mockResolvedValue(candidates)
      const generationQueue = createFakeGenerationQueue()
      await renderApp(
        store,
        createFakeSettingsStore(),
        createFakeSynthClient(),
        generationQueue,
        createFakeClipCache(),
        createFakeScanReader(),
        createFakeErrorLog(),
        createFakeLibrarySyncClient(),
        translator,
      )
      act(() => click(container.querySelector('[data-testid="deck-row-d1"]')!))
      act(() => click(container.querySelector('[data-testid="add-phrase"]')!))
      const english = container.querySelector('[data-testid="phrase-english-input"]') as HTMLInputElement
      act(() => typeInto(english, 'Can you come?'))

      await act(async () => {
        vi.advanceTimersByTime(600)
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(translator.translate).toHaveBeenCalledWith('Can you come?', 'en-to-fr', 'Home')

      act(() => click(container.querySelector('[data-testid="candidate-checkbox-0"]')!))
      act(() => click(container.querySelector('[data-testid="candidate-checkbox-1"]')!))
      const deckSelect1 = container.querySelector('[data-testid="candidate-deck-1"]') as HTMLSelectElement
      act(() => {
        deckSelect1.value = 'd2'
        deckSelect1.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await act(async () => click(container.querySelector('[data-testid="add-candidates"]')!))

      const home = store.decks.get('d1')!
      const formal = store.decks.get('d2')!
      expect(home.phrases).toEqual([expect.objectContaining({ french: 'Tu peux venir?', english: 'Can you come?' })])
      expect(formal.phrases).toEqual([
        expect.objectContaining({ french: 'Pouvez-vous venir?', english: 'Can you come?' }),
      ])
      expect(generationQueue.enqueued.map((p) => ({ french: p.french, english: p.english }))).toEqual([
        { french: 'Tu peux venir?', english: 'Can you come?' },
        { french: 'Pouvez-vous venir?', english: 'Can you come?' },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it("handleAddCandidates groups selections by destination Deck, matching handleImportSave's established pattern", async () => {
    const store = createFakeDeckStore([
      { id: 'd1', name: 'Home', phrases: [] },
      { id: 'd2', name: 'Formal', phrases: [] },
    ])
    const generationQueue = createFakeGenerationQueue()
    await renderApp(
      store,
      createFakeSettingsStore(),
      createFakeSynthClient(),
      generationQueue,
      createFakeClipCache(),
      createFakeScanReader(),
      createFakeErrorLog(),
      createFakeLibrarySyncClient(),
      createFakeTranslator(),
    )
    act(() => click(container.querySelector('[data-testid="deck-row-d1"]')!))
    act(() => click(container.querySelector('[data-testid="add-phrase"]')!))
    // Manual save still works exactly as before with a Translator wired —
    // the addition is additive, never a replacement of the existing path.
    const french = container.querySelector('[data-testid="phrase-french-input"]') as HTMLInputElement
    const english = container.querySelector('[data-testid="phrase-english-input"]') as HTMLInputElement
    act(() => typeInto(french, 'Bonjour'))
    act(() => typeInto(english, 'Hello'))
    await act(async () => click(container.querySelector('[data-testid="phrase-save"]')!))

    const saved = store.decks.get('d1')!
    expect(saved.phrases).toHaveLength(1)
    expect(saved.phrases[0]).toMatchObject({ french: 'Bonjour', english: 'Hello' })
  })
})

describe('App wired to the backup age (T031)', () => {
  const DAY = 86_400_000

  beforeEach(() => {
    vi.mocked(shareBackupFile).mockClear()
    vi.mocked(shareBackupFile).mockResolvedValue('shared')
  })

  it('states the age on the home screen from the last successful sync', async () => {
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    await renderApp(store, createFakeSettingsStore({ lastSyncAt: Date.now() - 11 * DAY }))
    expect(container.querySelector('[data-testid="backup-status"]')!.textContent).toContain('11 days ago')
  })

  it('counts a manual export as a backup too, and takes whichever of the two is more recent', async () => {
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    await renderApp(
      store,
      createFakeSettingsStore({ lastSyncAt: Date.now() - 40 * DAY, lastExportAt: Date.now() - 2 * DAY }),
    )
    expect(container.querySelector('[data-testid="backup-status"]')!.textContent).toContain('2 days ago')
  })

  it('escalates to overdue once neither has happened for a month', async () => {
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    await renderApp(store, createFakeSettingsStore({ lastSyncAt: Date.now() - 45 * DAY }))
    const indicator = container.querySelector('[data-testid="backup-status"]') as HTMLElement
    expect(indicator.dataset.level).toBe('overdue')
  })

  it('says nothing has ever been backed up when neither has ever happened', async () => {
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    await renderApp(store, createFakeSettingsStore({ lastSyncAt: null, lastExportAt: null }))
    expect(container.querySelector('[data-testid="backup-status"]')!.textContent).toContain('Not backed up yet')
  })

  it('offers nothing to dismiss, anywhere — the indicator is a fact, not a nudge', async () => {
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    await renderApp(store, createFakeSettingsStore({ lastSyncAt: Date.now() - 45 * DAY }))
    expect(container.querySelector('[data-testid="dismiss-backup-nudge"]')).toBeNull()
  })

  it('records the export time and goes quiet immediately, with no reload', async () => {
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    const settingsStore = createFakeSettingsStore({ lastSyncAt: Date.now() - 45 * DAY })
    await renderApp(store, settingsStore)

    await act(async () => click(container.querySelector('[data-testid="backup-status-export"]')!))

    expect((await settingsStore.load()).lastExportAt).toBeGreaterThan(Date.now() - 5_000)
    const indicator = container.querySelector('[data-testid="backup-status"]') as HTMLElement
    expect(indicator.dataset.level).toBe('fresh')
  })

  it('records nothing when she backs out of the share sheet — a cancelled export is not a backup', async () => {
    vi.mocked(shareBackupFile).mockResolvedValue('cancelled')
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    const settingsStore = createFakeSettingsStore({ lastSyncAt: Date.now() - 45 * DAY })
    await renderApp(store, settingsStore)

    await act(async () => click(container.querySelector('[data-testid="backup-status-export"]')!))

    expect((await settingsStore.load()).lastExportAt).toBeNull()
  })

  it('carries the indicator onto a Deck screen once it is urgent', async () => {
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    await renderApp(store, createFakeSettingsStore({ lastSyncAt: Date.now() - 45 * DAY }))
    await act(async () => click(container.querySelector('[data-testid="deck-row-d1"]')!))
    expect(container.querySelector('[data-testid="backup-status"]')).not.toBeNull()
  })

  it('leaves a Deck screen alone while the backup is fresh', async () => {
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    await renderApp(store, createFakeSettingsStore({ lastSyncAt: Date.now() - 1 * DAY }))
    await act(async () => click(container.querySelector('[data-testid="deck-row-d1"]')!))
    expect(container.querySelector('[data-testid="backup-status"]')).toBeNull()
  })
})

describe('App — restore is reachable from the screen a wiped phone opens on (T031)', () => {
  it('restores the library from the Decks empty state without ever opening Settings', async () => {
    const store = createFakeDeckStore([])
    const replacement: Library = {
      format: LIBRARY_FORMAT,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      exportedAt: 1,
      decks: [{ id: 'fresh', name: 'Rescued', phrases: [], createdAt: 1, updatedAt: 1 }],
    }
    store.importAll = async (library) => {
      store.decks = new Map(library.decks.map((d) => [d.id, { id: d.id, name: d.name, phrases: d.phrases }]))
    }
    store.loadAll = async () => [...store.decks.values()]
    await renderApp(store)

    const input = container.querySelector('[data-testid="restore-file-input"]') as HTMLInputElement
    const file = new File([JSON.stringify(replacement)], 'backup.json', { type: 'application/json' })
    Object.defineProperty(input, 'files', {
      value: { 0: file, length: 1, item: () => file } as unknown as FileList,
      configurable: true,
    })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    await act(async () => click(container.querySelector('[data-testid="restore-confirm"]')!))

    expect(container.textContent).toContain('Rescued')
  })
})

describe('App wired to library sync (T041)', () => {
  it('pulls from the server on mount when local storage is empty, and renders what came back', async () => {
    const store = createFakeDeckStore([])
    const library: Library = {
      format: LIBRARY_FORMAT,
      schemaVersion: 1,
      exportedAt: 1,
      decks: [{ id: 'remote', name: 'From server', phrases: [], createdAt: 1, updatedAt: 1 }],
    }
    store.importAll = async (lib) => {
      store.decks = new Map(lib.decks.map((d) => [d.id, { id: d.id, name: d.name, phrases: d.phrases }]))
    }
    store.loadAll = async () => [...store.decks.values()]
    const librarySyncClient = createFakeLibrarySyncClient({
      pull: async () => ({ ok: true, library }),
    })

    await renderApp(
      store,
      createFakeSettingsStore(),
      createFakeSynthClient(),
      createFakeGenerationQueue(),
      createFakeClipCache(),
      createFakeScanReader(),
      createFakeErrorLog(),
      librarySyncClient,
    )

    expect(container.textContent).toContain('From server')
  })

  it('pulls on mount even when local storage already has Decks — otherwise a second device never sees the first one\'s work (T060)', async () => {
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    const library: Library = {
      format: LIBRARY_FORMAT,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      exportedAt: 1,
      decks: [{ id: 'remote', name: 'From server', phrases: [], createdAt: 1, updatedAt: 1 }],
    }
    const librarySyncClient = createFakeLibrarySyncClient({ pull: async () => ({ ok: true, library }) })

    await renderApp(
      store,
      createFakeSettingsStore(),
      createFakeSynthClient(),
      createFakeGenerationQueue(),
      createFakeClipCache(),
      createFakeScanReader(),
      createFakeErrorLog(),
      librarySyncClient,
    )
    await flushMicrotasks()

    expect(container.textContent).toContain('From server')
    expect(container.textContent).toContain('Home')
  })

  /**
   * T060 asserted the opposite — boot pulled but never pushed, so opening the
   * app could not change the server copy. T034 pushes on launch on purpose: a
   * change she made while offline yesterday reaches the server only if
   * *something* pushes without her tapping anything, and launch is the one
   * moment guaranteed to happen. What made a boot push unsafe was pushing this
   * device's snapshot blind; what is pushed now is the merge of both sides, so
   * the server can gain records and never lose them.
   */
  it('pushes on launch, and pushes the merge of both sides — the server never loses what only it had', async () => {
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    const librarySyncClient = createFakeLibrarySyncClient({
      pull: async () => ({
        ok: true,
        library: {
          format: LIBRARY_FORMAT,
          schemaVersion: CURRENT_SCHEMA_VERSION,
          exportedAt: 1,
          decks: [{ id: 'remote', name: 'From server', phrases: [], createdAt: 1, updatedAt: 1 }],
        },
      }),
    })

    await renderApp(
      store,
      createFakeSettingsStore(),
      createFakeSynthClient(),
      createFakeGenerationQueue(),
      createFakeClipCache(),
      createFakeScanReader(),
      createFakeErrorLog(),
      librarySyncClient,
    )

    expect(librarySyncClient.pushed).toHaveLength(1)
    expect(librarySyncClient.pushed[0]!.decks.map((d) => d.name).sort()).toEqual(['From server', 'Home'])
  })

  it('pushes the whole library to the server after a Deck is created', async () => {
    const store = createFakeDeckStore([])
    const librarySyncClient = createFakeLibrarySyncClient()
    await renderApp(
      store,
      createFakeSettingsStore(),
      createFakeSynthClient(),
      createFakeGenerationQueue(),
      createFakeClipCache(),
      createFakeScanReader(),
      createFakeErrorLog(),
      librarySyncClient,
    )

    act(() => click(container.querySelector('[data-testid="new-deck"]')!))
    const input = container.querySelector('[data-testid="deck-name-input"]') as HTMLInputElement
    act(() => typeInto(input, 'Work'))
    await act(async () => click(container.querySelector('[data-testid="deck-name-save"]')!))
    await flushMicrotasks()

    expect(librarySyncClient.pushed.length).toBeGreaterThan(0)
  })

  it('pushes to the server after a Deck is deleted', async () => {
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    const librarySyncClient = createFakeLibrarySyncClient()
    await renderApp(
      store,
      createFakeSettingsStore(),
      createFakeSynthClient(),
      createFakeGenerationQueue(),
      createFakeClipCache(),
      createFakeScanReader(),
      createFakeErrorLog(),
      librarySyncClient,
    )

    act(() => click(container.querySelector('[data-testid="deck-row-d1"]')!))
    act(() => click(container.querySelector('[data-testid="delete-deck"]')!))
    await act(async () => click(container.querySelector('[data-testid="confirm-delete-deck"]')!))
    await flushMicrotasks()

    expect(librarySyncClient.pushed.length).toBeGreaterThan(0)
  })
})

/**
 * One server, two devices (T060). The defect these pin: the phone never
 * pulled, so its first local save pushed a library missing the Deck created
 * on the web — and last-write-wins deleted her phrases with no error
 * anywhere. Each test drives the real App twice, against two DeckStores and
 * one shared server copy.
 */
function createFakeServer(): { library: Library | undefined; client(): LibrarySyncClient } {
  const server: { library: Library | undefined; client(): LibrarySyncClient } = {
    library: undefined,
    client() {
      return {
        async push(library) {
          server.library = library
          return { ok: true }
        },
        async pull() {
          return server.library ? { ok: true, library: server.library } : { ok: false, reason: 'not-found' }
        },
      }
    },
  }
  return server
}

/** Tear the current App down and hand the next one a clean root — a second
 * device is a second mount, not a re-render of the first. */
function remount(): void {
  act(() => root.unmount())
  container.remove()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
}

async function createDeckThroughUi(name: string): Promise<void> {
  act(() => click(container.querySelector('[data-testid="new-deck"]')!))
  const input = container.querySelector('[data-testid="deck-name-input"]') as HTMLInputElement
  act(() => typeInto(input, name))
  await act(async () => click(container.querySelector('[data-testid="deck-name-save"]')!))
  await flushMicrotasks()
}

function serverDeckNames(server: { library: Library | undefined }): string[] {
  return (server.library?.decks ?? []).map((d) => d.name).sort()
}

describe('App wired to two devices against one library (T060)', () => {
  it('keeps a Deck created on one device when another device, which never saw it, saves', async () => {
    const server = createFakeServer()

    const web = createFakeDeckStore([], () => 1000)
    await renderApp(
      web,
      createFakeSettingsStore(),
      createFakeSynthClient(),
      createFakeGenerationQueue(),
      createFakeClipCache(),
      createFakeScanReader(),
      createFakeErrorLog(),
      server.client(),
    )
    await createDeckThroughUi('Made on web')
    expect(serverDeckNames(server)).toEqual(['Made on web'])

    remount()
    const phone = createFakeDeckStore([{ id: 'phone-deck', name: 'Made on phone', phrases: [] }], () => 2000)
    await renderApp(
      phone,
      createFakeSettingsStore(),
      createFakeSynthClient(),
      createFakeGenerationQueue(),
      createFakeClipCache(),
      createFakeScanReader(),
      createFakeErrorLog(),
      server.client(),
    )
    await createDeckThroughUi('Also on phone')

    expect(serverDeckNames(server)).toEqual(['Also on phone', 'Made on phone', 'Made on web'])
  })

  it('shows the other device\'s Deck on this one, without dropping this one\'s own', async () => {
    const server = createFakeServer()
    const web = createFakeDeckStore([], () => 1000)
    await renderApp(
      web,
      createFakeSettingsStore(),
      createFakeSynthClient(),
      createFakeGenerationQueue(),
      createFakeClipCache(),
      createFakeScanReader(),
      createFakeErrorLog(),
      server.client(),
    )
    await createDeckThroughUi('Made on web')

    remount()
    const phone = createFakeDeckStore([{ id: 'phone-deck', name: 'Made on phone', phrases: [] }], () => 2000)
    await renderApp(
      phone,
      createFakeSettingsStore(),
      createFakeSynthClient(),
      createFakeGenerationQueue(),
      createFakeClipCache(),
      createFakeScanReader(),
      createFakeErrorLog(),
      server.client(),
    )
    await flushMicrotasks()

    expect(container.textContent).toContain('Made on web')
    expect(container.textContent).toContain('Made on phone')
  })

  it('does not push at all when it could not read the server copy first — a device that cannot merge must not overwrite', async () => {
    const server = createFakeServer()
    server.library = {
      format: LIBRARY_FORMAT,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      exportedAt: 1,
      decks: [{ id: 'web-deck', name: 'Made on web', phrases: [], createdAt: 1, updatedAt: 1 }],
    }
    const offlinePull: LibrarySyncClient = {
      ...server.client(),
      async pull() {
        return { ok: false, reason: 'network' }
      },
    }

    const phone = createFakeDeckStore([{ id: 'phone-deck', name: 'Made on phone', phrases: [] }], () => 2000)
    await renderApp(
      phone,
      createFakeSettingsStore(),
      createFakeSynthClient(),
      createFakeGenerationQueue(),
      createFakeClipCache(),
      createFakeScanReader(),
      createFakeErrorLog(),
      offlinePull,
    )
    await createDeckThroughUi('Also on phone')

    expect(serverDeckNames(server)).toEqual(['Made on web'])
  })

  it('still deletes: a Deck deleted on one device does not come back from another device\'s stale copy', async () => {
    const server = createFakeServer()

    const web = createFakeDeckStore([], () => 1000)
    await renderApp(
      web,
      createFakeSettingsStore(),
      createFakeSynthClient(),
      createFakeGenerationQueue(),
      createFakeClipCache(),
      createFakeScanReader(),
      createFakeErrorLog(),
      server.client(),
    )
    await createDeckThroughUi('Made on web')
    const deckId = [...web.decks.keys()][0]!

    // The phone had already synced that Deck down before it was deleted.
    const phone = createFakeDeckStore([{ id: deckId, name: 'Made on web', phrases: [] }], () => 1500)

    act(() => click(container.querySelector(`[data-testid="deck-row-${deckId}"]`)!))
    act(() => click(container.querySelector('[data-testid="delete-deck"]')!))
    await act(async () => click(container.querySelector('[data-testid="confirm-delete-deck"]')!))
    await flushMicrotasks()
    expect(serverDeckNames(server)).toEqual([])

    remount()
    await renderApp(
      phone,
      createFakeSettingsStore(),
      createFakeSynthClient(),
      createFakeGenerationQueue(),
      createFakeClipCache(),
      createFakeScanReader(),
      createFakeErrorLog(),
      server.client(),
    )
    await createDeckThroughUi('Also on phone')

    expect(serverDeckNames(server)).toEqual(['Also on phone'])
    expect(container.textContent).not.toContain('Made on web')
  })
})

describe('App wired to Diagnostics (T039)', () => {
  it('is reachable from Settings and shows Phrase counts, never text — no provider key is held on device to leak', async () => {
    const store = createFakeDeckStore([
      { id: 'd1', name: 'Home', phrases: [{ id: 'p1', french: 'Bonjour', english: 'Hello' }] },
    ])
    await renderApp(store, createFakeSettingsStore())
    await openSettings()

    await act(async () => click(container.querySelector('[data-testid="open-diagnostics"]')!))

    const report = container.querySelector('[data-testid="diagnostics-report"]')!.textContent!
    expect(report).not.toContain('Bonjour')
    expect(report).toMatch(/1/) // 1 Phrase total, counted, not named
  })

  it('shows the last captured errors from the injected ErrorLog', async () => {
    const store = createFakeDeckStore([])
    const errorLog = createFakeErrorLog([
      { id: 1, timestamp: 1_700_000_000_000, source: 'window.onerror', message: 'TypeError: oops' },
    ])
    await renderApp(
      store,
      createFakeSettingsStore(),
      createFakeSynthClient(),
      createFakeGenerationQueue(),
      createFakeClipCache(),
      createFakeScanReader(),
      errorLog,
    )
    await openSettings()

    await act(async () => click(container.querySelector('[data-testid="open-diagnostics"]')!))

    expect(container.querySelector('[data-testid="diagnostics-report"]')!.textContent).toContain(
      'TypeError: oops',
    )
  })

  it('copies the whole report as text through one control', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const store = createFakeDeckStore([])
    await renderApp(store)
    await openSettings()
    await act(async () => click(container.querySelector('[data-testid="open-diagnostics"]')!))

    await act(async () => click(container.querySelector('[data-testid="copy-diagnostics-report"]')!))

    expect(writeText).toHaveBeenCalledTimes(1)
    const [copied] = writeText.mock.calls[0]!
    expect(typeof copied).toBe('string')
    expect((copied as string).length).toBeGreaterThan(0)
    vi.unstubAllGlobals()
  })

  it('returns to Settings from Diagnostics', async () => {
    const store = createFakeDeckStore([])
    await renderApp(store)
    await openSettings()
    await act(async () => click(container.querySelector('[data-testid="open-diagnostics"]')!))

    await act(async () => click(container.querySelector('[data-testid="diagnostics-back"]')!))

    expect(container.querySelector('[data-testid="settings-back"]')).not.toBeNull()
  })

  /** T036 — the ceiling is only honest if what it is holding right now is
   * read off the live cache when Settings opens, not baked in at boot. */
  it('reads what the clip cache is holding when Settings opens, and states it', async () => {
    const store = createFakeDeckStore([])
    const clipCache = createFakeClipCache(new Set(), { bytes: 149_100_000, clipCount: 3190, maxBytes: 209_715_200 })
    await renderApp(
      store,
      createFakeSettingsStore(),
      createFakeSynthClient(),
      createFakeGenerationQueue(),
      clipCache,
    )
    await openSettings()

    const usage = container.querySelector('[data-testid="saved-audio-usage"]')
    expect(usage?.textContent).toMatch(/142 MB/)
    expect(usage?.textContent).toMatch(/200 MB/)
  })
})

describe('App wired to saved Mixes (T059)', () => {
  const HOME: Deck = { id: 'd1', name: 'Home', phrases: [{ id: 'p1', french: 'Bonjour', english: 'Hello' }] }
  const WORK: Deck = { id: 'd2', name: 'Work', phrases: [{ id: 'p2', french: 'Réunion', english: 'Meeting' }] }

  async function renderWithMixes(
    decks: readonly Deck[],
    mixes: readonly Mix[],
    ready: ReadonlySet<string> = new Set(['p1', 'p2']),
  ) {
    const deckStore = createFakeDeckStore(decks)
    const mixStore = createFakeMixStore(mixes)
    const sync = createFakeLibrarySyncClient()
    await renderApp(
      deckStore,
      createFakeSettingsStore({ voice: FAKE_VOICE }),
      createFakeSynthClient(),
      createFakeGenerationQueue(),
      createFakeClipCache(ready),
      createFakeScanReader(),
      createFakeErrorLog(),
      sync,
      // Slot 9 is `translator` (T057), slot 10 is `mixStore` (T059). Both
      // branches added a parameter to the tail of this positional helper and
      // each was correct alone; the merge is where they collided. Passed
      // explicitly rather than relying on the default so the order is visible
      // at the call site.
      createFakeTranslator(),
      mixStore,
    )
    return { deckStore, mixStore, sync }
  }

  it('saves a Mix through MixStore.save and lists it on the Mix screen', async () => {
    const { mixStore } = await renderWithMixes([HOME, WORK], [])

    await act(async () => click(container.querySelector('[data-testid="open-mix"]')!))
    act(() => click(container.querySelector('[data-testid="deck-chip-d1"]')!))
    act(() => click(container.querySelector('[data-testid="deck-chip-d2"]')!))
    act(() => click(container.querySelector('[data-testid="save-mix"]')!))
    const input = container.querySelector('[data-testid="deck-name-input"]') as HTMLInputElement
    act(() => typeInto(input, 'Mornings'))
    await act(async () => click(container.querySelector('[data-testid="deck-name-save"]')!))

    expect(mixStore.mixes.size).toBe(1)
    const saved = [...mixStore.mixes.values()][0]
    expect(saved.name).toBe('Mornings')
    expect(saved.deckIds).toEqual(['d1', 'd2'])
    expect(typeof saved.id).toBe('string')
    expect(saved.id.length).toBeGreaterThan(0)
    expect(container.querySelector(`[data-testid="mix-row-${saved.id}"]`)).not.toBeNull()
  })

  it('loads saved Mixes on mount and drills one in a single tap', async () => {
    await renderWithMixes([HOME, WORK], [{ id: 'm1', name: 'Mornings', deckIds: ['d1', 'd2'] }])

    await act(async () => click(container.querySelector('[data-testid="open-mix"]')!))
    await act(async () => click(container.querySelector('[data-testid="mix-row-m1"]')!))

    expect(container.querySelector('[data-testid="drill-phrase-count"]')?.textContent).toBe('2 phrases')
  })

  it('renames a saved Mix through MixStore.save, keeping its Decks', async () => {
    const { mixStore } = await renderWithMixes([HOME, WORK], [{ id: 'm1', name: 'Mornings', deckIds: ['d1', 'd2'] }])

    await act(async () => click(container.querySelector('[data-testid="open-mix"]')!))
    act(() => click(container.querySelector('[data-testid="rename-mix-m1"]')!))
    const input = container.querySelector('[data-testid="deck-name-input"]') as HTMLInputElement
    act(() => typeInto(input, 'Evenings'))
    await act(async () => click(container.querySelector('[data-testid="deck-name-save"]')!))

    expect(mixStore.mixes.get('m1')).toEqual({ id: 'm1', name: 'Evenings', deckIds: ['d1', 'd2'] })
  })

  it('edits a saved Mix Deck selection through MixStore.save', async () => {
    const { mixStore } = await renderWithMixes([HOME, WORK], [{ id: 'm1', name: 'Mornings', deckIds: ['d1'] }])

    await act(async () => click(container.querySelector('[data-testid="open-mix"]')!))
    act(() => click(container.querySelector('[data-testid="edit-mix-m1"]')!))
    act(() => click(container.querySelector('[data-testid="deck-chip-d2"]')!))
    await act(async () => click(container.querySelector('[data-testid="save-mix"]')!))

    expect(mixStore.mixes.get('m1')).toEqual({ id: 'm1', name: 'Mornings', deckIds: ['d1', 'd2'] })
  })

  it('deleting a Mix removes it and never touches its source Decks', async () => {
    const { deckStore, mixStore } = await renderWithMixes(
      [HOME, WORK],
      [{ id: 'm1', name: 'Mornings', deckIds: ['d1', 'd2'] }],
    )

    await act(async () => click(container.querySelector('[data-testid="open-mix"]')!))
    act(() => click(container.querySelector('[data-testid="delete-mix-m1"]')!))
    await act(async () => click(container.querySelector('[data-testid="confirm-delete-mix-m1"]')!))

    expect(mixStore.mixes.size).toBe(0)
    expect([...deckStore.decks.keys()].sort()).toEqual(['d1', 'd2'])
    expect(deckStore.decks.get('d1')!.phrases).toHaveLength(1)
    expect(container.querySelector('[data-testid="mix-row-m1"]')).toBeNull()
  })

  it('survives a Deck deleted out from under a saved Mix: the Mix still lists and drills what is left', async () => {
    await renderWithMixes([HOME, WORK], [{ id: 'm1', name: 'Mornings', deckIds: ['d1', 'd2'] }])

    // Delete Work from the Decks screen, then go to the Mix screen.
    act(() => click(container.querySelector('[data-testid="delete-deck-d2"]')!))
    await act(async () => click(container.querySelector('[data-testid="confirm-delete-deck-d2"]')!))
    await act(async () => click(container.querySelector('[data-testid="open-mix"]')!))

    expect(container.querySelector('[data-testid="mix-row-m1"]')?.textContent).toContain('1 deck · 1 phrase')

    await act(async () => click(container.querySelector('[data-testid="mix-row-m1"]')!))
    expect(container.querySelector('[data-testid="drill-phrase-count"]')?.textContent).toBe('1 phrases')
  })

  it('pushes the library to the server after a Mix is saved, so a new phone gets it', async () => {
    const { sync } = await renderWithMixes([HOME, WORK], [])

    await act(async () => click(container.querySelector('[data-testid="open-mix"]')!))
    act(() => click(container.querySelector('[data-testid="deck-chip-d1"]')!))
    act(() => click(container.querySelector('[data-testid="save-mix"]')!))
    const input = container.querySelector('[data-testid="deck-name-input"]') as HTMLInputElement
    act(() => typeInto(input, 'Mornings'))
    await act(async () => click(container.querySelector('[data-testid="deck-name-save"]')!))
    await flushMicrotasks()

    expect(sync.pushed.length).toBeGreaterThan(0)
  })
})

/**
 * Sync she never has to think about (T034). The failure mode these exist to
 * make impossible: "everything is gone". "Nothing happened yet" is allowed
 * and is what the sync line says out loud.
 */
function createManualPlatform(): PlatformPort & { goOnline(): void; hide(): void } {
  const onlineListeners: (() => void)[] = []
  const hiddenListeners: (() => void)[] = []
  return {
    isOnline: () => true,
    onOnline(listener) {
      onlineListeners.push(listener)
      return () => onlineListeners.splice(onlineListeners.indexOf(listener), 1)
    },
    onHidden(listener) {
      hiddenListeners.push(listener)
      return () => hiddenListeners.splice(hiddenListeners.indexOf(listener), 1)
    },
    goOnline() {
      for (const listener of [...onlineListeners]) listener()
    },
    hide() {
      for (const listener of [...hiddenListeners]) listener()
    },
  }
}

async function addPhraseThroughUi(deckId: string, french: string, english: string): Promise<void> {
  act(() => click(container.querySelector(`[data-testid="deck-row-${deckId}"]`)!))
  act(() => click(container.querySelector('[data-testid="add-phrase"]')!))
  const frenchInput = container.querySelector('[data-testid="phrase-french-input"]') as HTMLInputElement
  const englishInput = container.querySelector('[data-testid="phrase-english-input"]') as HTMLInputElement
  act(() => typeInto(frenchInput, french))
  act(() => typeInto(englishInput, english))
  await act(async () => click(container.querySelector('[data-testid="phrase-save"]')!))
  await flushMicrotasks()
  await act(async () => click(container.querySelector('[data-testid="back"]')!))
}

function syncLine(): string {
  return container.querySelector('[data-testid="sync-status"]')?.textContent ?? ''
}

describe('App wired to sync without a tap (T034)', () => {
  const P1 = { id: 'p1', french: 'Bonjour', english: 'Hello' }
  const P3 = { id: 'p3', french: 'Bonsoir', english: 'Good evening' }

  it('loses nothing from either side when one device edits a Deck offline and the other edits the same Deck', async () => {
    const server = createFakeServer()

    // The other device — its own store and its own engine, no screen. It
    // starts from the shared one-Phrase Deck and syncs, so both sides have a
    // baseline: the state they last agreed on.
    const web = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [P1] }], () => 3000)
    const webEngine = createTestSyncEngine(web, createFakeSettingsStore(), server.client())
    webEngine.start()
    await flushMicrotasks()
    expect(server.library!.decks[0]!.phrases.map((p) => p.id)).toEqual(['p1'])

    // This device: the phone, running the real app, from the same Deck.
    const phone = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [P1] }], () => 4000)
    const offline = { value: false }
    const live = server.client()
    const phoneClient: LibrarySyncClient = {
      async pull() {
        return offline.value ? { ok: false, reason: 'network' } : live.pull()
      },
      async push(library) {
        return offline.value ? { ok: false, reason: 'network' } : live.push(library)
      },
    }
    const platform = createManualPlatform()
    const phoneSettings = createFakeSettingsStore()
    await renderApp(
      phone,
      phoneSettings,
      createFakeSynthClient(),
      createFakeGenerationQueue(),
      createFakeClipCache(),
      createFakeScanReader(),
      createFakeErrorLog(),
      phoneClient,
      createFakeTranslator(),
      createFakeMixStore(),
      createTestSyncEngine(phone, phoneSettings, phoneClient, platform),
    )

    // She goes offline and adds a Phrase on the phone.
    offline.value = true
    await addPhraseThroughUi('d1', 'Merci', 'Thanks')
    expect(phone.decks.get('d1')!.phrases.map((p) => p.french)).toEqual(['Bonjour', 'Merci'])
    expect(syncLine()).toContain('Saved on this phone')

    // Meanwhile, on the other device, she adds a different Phrase to the same Deck.
    await web.save({ id: 'd1', name: 'Home', phrases: [P1, P3] })
    webEngine.syncNow()
    await flushMicrotasks()

    // The phone comes back.
    offline.value = false
    platform.goOnline()
    await flushMicrotasks()

    expect(phone.decks.get('d1')!.phrases.map((p) => p.french).sort()).toEqual(['Bonjour', 'Bonsoir', 'Merci'])
    expect(server.library!.decks[0]!.phrases.map((p) => p.french).sort()).toEqual(['Bonjour', 'Bonsoir', 'Merci'])
    expect(container.textContent).toContain('3 phrases')
  })

  it('keeps an offline change on the device and pushes it once the connection returns', async () => {
    const server = createFakeServer()
    const offline = { value: true }
    const live = server.client()
    const client: LibrarySyncClient = {
      async pull() {
        return offline.value ? { ok: false, reason: 'network' } : live.pull()
      },
      async push(library) {
        return offline.value ? { ok: false, reason: 'network' } : live.push(library)
      },
    }
    const platform = createManualPlatform()
    const store = createFakeDeckStore([], () => 1000)
    const settingsStore = createFakeSettingsStore()
    await renderApp(
      store,
      settingsStore,
      createFakeSynthClient(),
      createFakeGenerationQueue(),
      createFakeClipCache(),
      createFakeScanReader(),
      createFakeErrorLog(),
      client,
      createFakeTranslator(),
      createFakeMixStore(),
      createTestSyncEngine(store, settingsStore, client, platform),
    )

    await createDeckThroughUi('Made offline')
    expect(server.library).toBeUndefined()

    offline.value = false
    platform.goOnline()
    await flushMicrotasks()

    expect(serverDeckNames(server)).toEqual(['Made offline'])
  })

  it('reports the time of the last successful sync', async () => {
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    await renderApp(store)

    expect(syncLine()).toBe('Synced just now')
  })

  it('never reports success for a sync that failed — "nothing happened" is said, "everything is gone" is not', async () => {
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    const client = createFakeLibrarySyncClient({
      async push(): Promise<PushResult> {
        return { ok: false, reason: 'network' }
      },
    })
    await renderApp(
      store,
      createFakeSettingsStore(),
      createFakeSynthClient(),
      createFakeGenerationQueue(),
      createFakeClipCache(),
      createFakeScanReader(),
      createFakeErrorLog(),
      client,
    )

    expect(syncLine()).toBe('Saved on this phone · will sync when back online · not synced yet')
    expect(store.decks.get('d1')).toBeDefined()
  })

  it('says nothing has synced yet before the first round-trip succeeds, rather than implying one did', async () => {
    const store = createFakeDeckStore([])
    const client = createFakeLibrarySyncClient({
      async pull(): Promise<PullResult> {
        return { ok: false, reason: 'network' }
      },
    })
    await renderApp(
      store,
      createFakeSettingsStore(),
      createFakeSynthClient(),
      createFakeGenerationQueue(),
      createFakeClipCache(),
      createFakeScanReader(),
      createFakeErrorLog(),
      client,
    )

    expect(syncLine()).toContain('not synced yet')
  })
})
