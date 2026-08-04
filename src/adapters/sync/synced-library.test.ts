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
const { computeDrillReadiness } = await import('../audio/drill-readiness')
const { LIBRARY_FORMAT } = await import('../../domain')
const { CURRENT_SCHEMA_VERSION } = await import('../storage/migrations')

type Library = import('../../domain').Library

const VOICE = { provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-1' }

function serverLibrary(parts: Partial<Library> = {}): Library {
  return {
    format: LIBRARY_FORMAT,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: 1,
    decks: [{ id: 'd1', name: 'Home', phrases: [{ id: 'p1', french: 'Bonjour', english: 'Hello' }], createdAt: 1, updatedAt: 1 }],
    mixes: [],
    tombstones: [],
    ...parts,
  }
}

describe('createSyncedLibrary (T067)', () => {
  beforeEach(() => {
    resetFakeIdb()
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(true) } })
  })

  it('reads the pinned voice onto the envelope the deck store built, without reading the rest of settings', async () => {
    const settingsStore = createIndexedDbSettingsStore()
    const library = createSyncedLibrary({ deckStore: createIndexedDbDeckStore(), settingsStore })
    await settingsStore.setVoice(VOICE)
    await settingsStore.recordSync(4_242)

    const envelope = await library.readLocal()

    expect(envelope.voice).toEqual(VOICE)
    expect(JSON.stringify(envelope)).not.toContain('4242')
  })

  it('carries no voice field when nothing is pinned', async () => {
    const library = createSyncedLibrary({
      deckStore: createIndexedDbDeckStore(),
      settingsStore: createIndexedDbSettingsStore(),
    })

    expect((await library.readLocal()).voice).toBeUndefined()
  })

  /**
   * THE acceptance case: a new phone. Empty settings store, a server copy
   * that has a voice — after the write, that voice is pinned and the drill
   * is not blocked on `no-voice`.
   */
  it('pins the voice from an arriving Library on a device that has none, and unblocks the drill', async () => {
    const settingsStore = createIndexedDbSettingsStore()
    const library = createSyncedLibrary({ deckStore: createIndexedDbDeckStore(), settingsStore })
    expect((await settingsStore.load()).voice).toBeNull()

    await library.writeLocal(serverLibrary({ voice: VOICE }))

    const settings = await settingsStore.load()
    expect(settings.voice).toEqual(VOICE)

    const readiness = await computeDrillReadiness([{ id: 'p1', french: 'Bonjour', english: 'Hello' }], {
      clipCache: { get: vi.fn(), put: vi.fn(), has: vi.fn(), readyPhraseIds: vi.fn().mockResolvedValue(new Set(['p1'])) },
      generationQueue: { enqueue: vi.fn(), statusFor: vi.fn(), whenIdle: vi.fn().mockResolvedValue(undefined) },
      voice: settings.voice,
    })
    expect(readiness.reason).not.toBe('no-voice')
    expect(readiness.canStart).toBe(true)
  })

  it('leaves a locally pinned voice alone when an older envelope with no voice field arrives', async () => {
    const settingsStore = createIndexedDbSettingsStore()
    const library = createSyncedLibrary({ deckStore: createIndexedDbDeckStore(), settingsStore })
    await settingsStore.setVoice(VOICE)

    await library.writeLocal(serverLibrary())

    expect((await settingsStore.load()).voice).toEqual(VOICE)
  })

  it('still replaces the whole local library, voice or no voice', async () => {
    const deckStore = createIndexedDbDeckStore()
    const library = createSyncedLibrary({ deckStore, settingsStore: createIndexedDbSettingsStore() })

    await library.writeLocal(serverLibrary({ voice: VOICE }))

    expect((await deckStore.loadAll()).map((deck) => deck.id)).toEqual(['d1'])
  })
})
