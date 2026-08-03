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

  it('loads with no identity field — device identity is a Keycloak token now, not settings-store state (T043)', async () => {
    const store = createIndexedDbSettingsStore()

    const settings = await store.load()

    expect(settings).not.toHaveProperty('libraryKey')
    expect(settings.voice).toBeNull()
    expect(settings.backupNudgeDismissed).toBe(false)
    expect(settings.lastSyncAt).toBeNull()
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

  it('reports the backup nudge as not dismissed until dismissed', async () => {
    const store = createIndexedDbSettingsStore()

    expect((await store.load()).backupNudgeDismissed).toBe(false)
  })

  it('reads a key an older build never wrote as its documented default, not undefined or a throw — including ignoring a pre-T043 stored library key', async () => {
    // Simulates a store written before `backupNudgeDismissed` existed, and
    // before T043 deleted the library-key identity model: an old,
    // never-cleaned-up `libraryKey` entry is present but must simply be
    // ignored — `load()` must still resolve, and resolve to the documented
    // defaults for the fields it does read, not `undefined` or a throw.
    const db = await idbModule.openDB(DB_NAME, CURRENT_SCHEMA_VERSION, {
      upgrade(rawDb: { createObjectStore(name: string): unknown }) {
        rawDb.createObjectStore(SETTINGS_STORE)
      },
    })
    await db.put(SETTINGS_STORE, 'a'.repeat(64), 'libraryKey')

    const store = createIndexedDbSettingsStore()
    const settings = await store.load()

    expect(settings.backupNudgeDismissed).toBe(false)
    expect(settings).not.toHaveProperty('libraryKey')
  })

  it('dismisses the backup nudge permanently', async () => {
    const store = createIndexedDbSettingsStore()

    await store.dismissBackupNudge()

    expect((await store.load()).backupNudgeDismissed).toBe(true)
  })

  it('keeps the backup nudge dismissed across reloads, independent of the pinned voice', async () => {
    const store = createIndexedDbSettingsStore()
    await store.dismissBackupNudge()
    await store.setVoice({ provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-1' })

    expect((await store.load()).backupNudgeDismissed).toBe(true)
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
