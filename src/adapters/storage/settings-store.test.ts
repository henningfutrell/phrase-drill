import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetFakeIdb } from './idb.test-support'

vi.mock('idb', async () => {
  const fake = await import('./idb.test-support')
  return { openDB: fake.openDB }
})

// Imported after the mock is registered, per Vitest's hoisting contract.
const idbModule = await import('idb')
const { createIndexedDbSettingsStore } = await import('./settings-store')
const { createIndexedDbDeckStore } = await import('./indexed-db-deck-store')
const { DB_NAME, SETTINGS_STORE } = await import('./database')
const { CURRENT_SCHEMA_VERSION } = await import('./migrations')

describe('createIndexedDbSettingsStore', () => {
  beforeEach(() => {
    resetFakeIdb()
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(true) } })
  })

  it('loads with no identity field — device identity is a session token now, not settings-store state (T050)', async () => {
    const store = createIndexedDbSettingsStore()

    const settings = await store.load()

    expect(settings).not.toHaveProperty('libraryKey')
    expect(settings.voice).toBeNull()
    expect(settings.lastSyncAt).toBeNull()
    expect(settings.lastExportAt).toBeNull()
    expect(settings).not.toHaveProperty('backupNudgeDismissed')
  })

  it('reports no sync as ever having happened until one is recorded', async () => {
    const store = createIndexedDbSettingsStore()

    expect((await store.load()).lastSyncAt).toBeNull()
  })

  it('records and reloads the timestamp of the last successful sync', async () => {
    const store = createIndexedDbSettingsStore()

    await store.recordSync(1_700_000_000_000)

    expect((await store.load()).lastSyncAt).toBe(1_700_000_000_000)
  })

  it('replaces the last-sync timestamp with a newer one rather than keeping the old one alongside it', async () => {
    const store = createIndexedDbSettingsStore()

    await store.recordSync(1_000)
    await store.recordSync(2_000)

    expect((await store.load()).lastSyncAt).toBe(2_000)
  })

  it('reports no export as ever having happened until one is recorded', async () => {
    const store = createIndexedDbSettingsStore()

    expect((await store.load()).lastExportAt).toBeNull()
  })

  it('records and reloads the timestamp of the last file she exported herself', async () => {
    const store = createIndexedDbSettingsStore()

    await store.recordExport(1_700_000_000_000)

    expect((await store.load()).lastExportAt).toBe(1_700_000_000_000)
  })

  it('replaces the last-export timestamp with a newer one rather than keeping the old one alongside it', async () => {
    const store = createIndexedDbSettingsStore()

    await store.recordExport(1_000)
    await store.recordExport(2_000)

    expect((await store.load()).lastExportAt).toBe(2_000)
  })

  it('keeps the sync time and the export time apart — one is not allowed to stand in for the other', async () => {
    const store = createIndexedDbSettingsStore()

    await store.recordSync(1_000)
    await store.recordExport(2_000)

    const settings = await store.load()
    expect(settings.lastSyncAt).toBe(1_000)
    expect(settings.lastExportAt).toBe(2_000)
  })

  it('reads a key an older build never wrote as its documented default, not undefined or a throw — including ignoring a pre-T043 stored library key', async () => {
    // Simulates a store written before `lastExportAt` existed, and before
    // T043 deleted the library-key identity model: an old, never-cleaned-up
    // `libraryKey` entry is present, and so is the retired
    // `backupNudgeDismissed` flag. Both must simply be ignored — `load()`
    // must still resolve, and resolve to the documented defaults for the
    // fields it does read, not `undefined` or a throw. Her Decks are not
    // touched by any of this: these are UI flags in the `settings` store,
    // never drill data.
    const db = await idbModule.openDB(DB_NAME, CURRENT_SCHEMA_VERSION, {
      upgrade(rawDb: { createObjectStore(name: string): unknown }) {
        rawDb.createObjectStore(SETTINGS_STORE)
      },
    })
    await db.put(SETTINGS_STORE, 'a'.repeat(64), 'libraryKey')
    await db.put(SETTINGS_STORE, true, 'backupNudgeDismissed')

    const store = createIndexedDbSettingsStore()
    const settings = await store.load()

    expect(settings.lastExportAt).toBeNull()
    expect(settings).not.toHaveProperty('libraryKey')
    expect(settings).not.toHaveProperty('backupNudgeDismissed')
  })

  it('keeps the export time across reloads, independent of the pinned voice', async () => {
    const store = createIndexedDbSettingsStore()
    await store.recordExport(4_242)
    await store.setVoice({ provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-1' })

    expect((await store.load()).lastExportAt).toBe(4_242)
  })

  it('saves and reloads the pinned voice', async () => {
    const store = createIndexedDbSettingsStore()

    await store.setVoice({ provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-1' })

    expect((await store.load()).voice).toEqual({
      provider: 'elevenlabs',
      modelId: 'eleven_multilingual_v2',
      voiceId: 'voice-1',
    })
  })

  it('clears the pinned voice back to null', async () => {
    const store = createIndexedDbSettingsStore()
    await store.setVoice({ provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-1' })

    await store.setVoice(null)

    expect((await store.load()).voice).toBeNull()
  })

  /**
   * T067 — the pinned voice follows her to a new phone, carried as its own
   * named field on the `Library` envelope. `adoptVoice` is the one write
   * that lands an arriving envelope's voice on this device.
   */
  describe('adoptVoice', () => {
    const VOICE = { provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-1' }

    it('pins the voice an arriving Library carries when this device has none — the new-phone case', async () => {
      const store = createIndexedDbSettingsStore()

      await store.adoptVoice(VOICE)

      expect((await store.load()).voice).toEqual(VOICE)
    })

    it('leaves the local pin alone when the arriving Library has no voice field at all', async () => {
      const store = createIndexedDbSettingsStore()
      await store.setVoice(VOICE)

      await store.adoptVoice(undefined)

      expect((await store.load()).voice).toEqual(VOICE)
    })

    it('replaces the local pin with the one it is given, since the merge already decided which that is', async () => {
      const store = createIndexedDbSettingsStore()
      await store.setVoice(VOICE)
      const other = { ...VOICE, voiceId: 'voice-2' }

      await store.adoptVoice(other)

      expect((await store.load()).voice).toEqual(other)
    })
  })

  it('never lets the pinned voice appear in a Deck export', async () => {
    const settingsStore = createIndexedDbSettingsStore()
    const deckStore = createIndexedDbDeckStore()
    await deckStore.save({
      id: 'd1',
      name: 'Home',
      phrases: [{ id: 'p1', french: 'Bonjour', english: 'Hello' }],
    })

    await settingsStore.setVoice({ provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-1' })

    const library = await deckStore.exportAll()

    const serialized = JSON.stringify(library)
    expect(serialized).not.toContain('eleven_multilingual_v2')
  })
})
