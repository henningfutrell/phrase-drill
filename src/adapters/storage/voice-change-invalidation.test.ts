import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetFakeIdb } from './idb.test-support'

vi.mock('idb', async () => {
  const fake = await import('./idb.test-support')
  return { openDB: fake.openDB }
})

// Imported after the mock is registered, per Vitest's hoisting contract.
const { createIndexedDbSettingsStore } = await import('./settings-store')
const { createIndexedDbClipCache, computeClipHash } = await import('./clip-cache')

/**
 * T026: re-pinning the voice from the Settings screen must actually stop
 * the old Clips being considered ready — the behaviour that breaks silently
 * if the hash or the wiring is wrong. `clip-cache.test.ts` already proves
 * the hash itself changes with the voice; this test closes the loop through
 * `SettingsStore.setVoice`, the exact seam the Settings screen calls.
 */
describe('re-pinning the voice through SettingsStore invalidates cached readiness', () => {
  beforeEach(() => {
    resetFakeIdb()
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(true) } })
  })

  it('stops a fully-cached phrase from being ready once a new voice is pinned', async () => {
    const settingsStore = createIndexedDbSettingsStore()
    const clipCache = createIndexedDbClipCache()
    const oldVoice = { provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-old' }
    const newVoice = { provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-new' }
    const phrase = { id: 'p1', french: 'Bonjour', english: 'Hello' }

    await settingsStore.setVoice(oldVoice)
    const frHash = await computeClipHash({ ...oldVoice, lang: 'fr-FR', text: phrase.french })
    const enHash = await computeClipHash({ ...oldVoice, lang: 'en-US', text: phrase.english })
    await clipCache.put({ hash: frHash, bytes: new ArrayBuffer(1), mime: 'audio/mpeg', durationMs: 1, createdAt: 1 })
    await clipCache.put({ hash: enHash, bytes: new ArrayBuffer(1), mime: 'audio/mpeg', durationMs: 1, createdAt: 1 })

    const readyBefore = await clipCache.readyPhraseIds([phrase], (await settingsStore.load()).voice!)
    expect(readyBefore).toEqual(new Set(['p1']))

    await settingsStore.setVoice(newVoice)
    const readyAfter = await clipCache.readyPhraseIds([phrase], (await settingsStore.load()).voice!)

    expect(readyAfter).toEqual(new Set())
  })
})
