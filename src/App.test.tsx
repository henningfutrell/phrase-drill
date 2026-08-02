import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { Deck, DeckStore, Library } from './domain'
import { LIBRARY_FORMAT } from './domain'
import type { ClipCache, Settings, SettingsStore, Voice } from './adapters/storage'
import type { SynthClient, SynthResult } from './adapters/audio/eleven-labs-synth-client'
import type { GenerationQueue } from './adapters/audio/generation-queue'

vi.mock('./adapters/share/web-share', () => ({
  shareBackupFile: vi.fn().mockResolvedValue('shared'),
}))
const { shareBackupFile } = await import('./adapters/share/web-share')

/** In-memory SettingsStore fake — the real one is exercised in
 * src/adapters/storage; App's wiring is what these tests care about. */
function createFakeSettingsStore(initial: Partial<Settings> = {}): SettingsStore {
  let settings: Settings = { anthropicApiKey: null, elevenLabsApiKey: null, voice: null, ...initial }
  return {
    async load() {
      return settings
    },
    async setAnthropicApiKey(key) {
      settings = { ...settings, anthropicApiKey: key }
    },
    async setElevenLabsApiKey(key) {
      settings = { ...settings, elevenLabsApiKey: key }
    },
    async setVoice(voice) {
      settings = { ...settings, voice }
    },
  }
}

/** In-memory DeckStore fake — the real DeckStore is exercised in
 * src/adapters/storage; this fake only lets App's wiring to the port be
 * asserted without a browser IndexedDB. */
function createFakeDeckStore(initial: readonly Deck[] = []): DeckStore & { decks: Map<string, Deck> } {
  const decks = new Map(initial.map((d) => [d.id, d]))
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
    },
    async remove(id) {
      decks.delete(id)
    },
    async exportAll(): Promise<Library> {
      return { format: LIBRARY_FORMAT, schemaVersion: 1, exportedAt: 0, decks: [] }
    },
    async importAll() {},
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
  }
}

/** In-memory ClipCache fake — the real IndexedDB cache is exercised in
 * src/adapters/storage; App's wiring of the readiness gate is what these
 * tests care about. `readyIds`/`readyPhraseIds` default to "nothing ready",
 * which is the honest default for a fresh app. */
function createFakeClipCache(readyIds: ReadonlySet<string> = new Set()): ClipCache {
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
  clipCache: ClipCache = createFakeClipCache(),
) {
  await act(async () => {
    root.render(
      <App
        deckStore={store}
        settingsStore={settingsStore}
        synthClient={synthClient}
        generationQueue={generationQueue}
        clipCache={clipCache}
      />,
    )
  })
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
  })

  it('exports the whole library through DeckStore.exportAll and hands it to the share adapter', async () => {
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    await renderApp(store)
    await openSettings()

    await act(async () => click(container.querySelector('[data-testid="export-backup"]')!))

    expect(shareBackupFile).toHaveBeenCalledTimes(1)
    const [file] = vi.mocked(shareBackupFile).mock.calls[0]!
    expect(file.type).toBe('application/json')
    expect(file.name).toMatch(/^phrase-drill-backup-\d{4}-\d{2}-\d{2}\.json$/)
    const text = await file.text()
    expect(JSON.parse(text)).toMatchObject({ format: LIBRARY_FORMAT })
  })

  it('never puts an API key in the exported file', async () => {
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    await renderApp(store)
    await openSettings()
    act(() => click(container.querySelector('[data-testid="anthropic-key-input"]')!))
    await act(async () => click(container.querySelector('[data-testid="export-backup"]')!))

    const [file] = vi.mocked(shareBackupFile).mock.calls[0]!
    const text = await file.text()
    expect(text).not.toMatch(/apiKey|anthropic|elevenlabs/i)
  })

  it('falls back to a plain download when the share adapter reports the platform cannot share files', async () => {
    vi.mocked(shareBackupFile).mockResolvedValue('unsupported')
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    const createObjectURL = vi.fn().mockReturnValue('blob:fake')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })

    await renderApp(store)
    await openSettings()
    await act(async () => click(container.querySelector('[data-testid="export-backup"]')!))

    expect(createObjectURL).toHaveBeenCalled()
    expect(container.querySelector('[data-testid="export-status"]')?.textContent).toMatch(/download|files/i)
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
    await renderApp(store, createFakeSettingsStore({ elevenLabsApiKey: 'el-key' }), synthClient)
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
    await renderApp(store, createFakeSettingsStore({ elevenLabsApiKey: 'el-key' }), synthClient)
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
