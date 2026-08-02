import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetFakeIdb } from './idb.test-support'

vi.mock('idb', async () => {
  const fake = await import('./idb.test-support')
  return { openDB: fake.openDB }
})

// Imported after the mock is registered, per Vitest's hoisting contract.
const { createIndexedDbSettingsStore } = await import('./settings-store')
const { createIndexedDbDeckStore } = await import('./indexed-db-deck-store')

describe('createIndexedDbSettingsStore', () => {
  beforeEach(() => {
    resetFakeIdb()
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(true) } })
  })

  it('reports no key, no voice, until something is saved', async () => {
    const store = createIndexedDbSettingsStore()

    expect(await store.load()).toEqual({
      anthropicApiKey: null,
      elevenLabsApiKey: null,
      voice: null,
    })
  })

  it('saves and reloads the Anthropic key', async () => {
    const store = createIndexedDbSettingsStore()

    await store.setAnthropicApiKey('sk-ant-abc123')

    expect((await store.load()).anthropicApiKey).toBe('sk-ant-abc123')
  })

  it('replaces the Anthropic key rather than keeping the old one alongside it', async () => {
    const store = createIndexedDbSettingsStore()

    await store.setAnthropicApiKey('sk-ant-old')
    await store.setAnthropicApiKey('sk-ant-new')

    expect((await store.load()).anthropicApiKey).toBe('sk-ant-new')
  })

  it('clears the Anthropic key back to null', async () => {
    const store = createIndexedDbSettingsStore()
    await store.setAnthropicApiKey('sk-ant-abc123')

    await store.setAnthropicApiKey(null)

    expect((await store.load()).anthropicApiKey).toBeNull()
  })

  it('saves, replaces, and clears the ElevenLabs key independently of the Anthropic key', async () => {
    const store = createIndexedDbSettingsStore()
    await store.setAnthropicApiKey('sk-ant-abc123')

    await store.setElevenLabsApiKey('el-key-old')
    await store.setElevenLabsApiKey('el-key-new')
    expect((await store.load()).elevenLabsApiKey).toBe('el-key-new')
    expect((await store.load()).anthropicApiKey).toBe('sk-ant-abc123')

    await store.setElevenLabsApiKey(null)
    expect((await store.load()).elevenLabsApiKey).toBeNull()
    expect((await store.load()).anthropicApiKey).toBe('sk-ant-abc123')
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

  it('never lets a saved key or voice appear in a Deck export', async () => {
    const settingsStore = createIndexedDbSettingsStore()
    const deckStore = createIndexedDbDeckStore()
    await deckStore.save({
      id: 'd1',
      name: 'Home',
      phrases: [{ id: 'p1', french: 'Bonjour', english: 'Hello' }],
    })

    await settingsStore.setAnthropicApiKey('sk-ant-super-secret')
    await settingsStore.setElevenLabsApiKey('el-super-secret')
    await settingsStore.setVoice({ provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-1' })

    const library = await deckStore.exportAll()

    const serialized = JSON.stringify(library)
    expect(serialized).not.toContain('sk-ant-super-secret')
    expect(serialized).not.toContain('el-super-secret')
    expect(serialized).not.toContain('eleven_multilingual_v2')
  })
})
