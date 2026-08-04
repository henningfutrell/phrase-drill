import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetFakeIdb } from './idb.test-support'

import { createIndexedDbSettingsStore } from './settings-store'
import { createIndexedDbClipCache, computeClipHash } from './clip-cache'
import { knownVoices } from '../audio/voice-catalogue'

/**
 * T026 wrote this test to prove the opposite of what it proves now, and the
 * reversal is the point of T067.
 *
 * Then: re-pinning the voice had to invalidate cached readiness, so the
 * library would be regenerated in the new voice. In practice that meant a
 * preference change costing ~2,000 requests and real money, which the owner
 * rejected: "If they are generated in a voice, just keep it that way."
 *
 * Now: a Clip's voice is a property of that Clip. Re-pinning decides what the
 * next new Phrase is generated in, and nothing else. This closes the loop
 * through `SettingsStore.setVoice` — the exact seam the Settings screen calls.
 */
describe('re-pinning the voice through SettingsStore leaves cached readiness alone', () => {
  beforeEach(() => {
    resetFakeIdb()
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(true) } })
  })

  it('keeps a fully-cached phrase ready once a new voice is pinned', async () => {
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

    const voicesBefore = knownVoices((await settingsStore.load()).voice)
    expect(await clipCache.readyPhraseIds([phrase], [...voicesBefore, oldVoice])).toEqual(new Set(['p1']))

    await settingsStore.setVoice(newVoice)
    const voicesAfter = knownVoices((await settingsStore.load()).voice)

    // `oldVoice` is not in the catalogue, so it is appended here the way the
    // drill would find it: what matters is that the sweep asks about more
    // than the pinned voice at all.
    expect(await clipCache.readyPhraseIds([phrase], [...voicesAfter, oldVoice])).toEqual(new Set(['p1']))
  })

  it('still excludes a phrase whose audio exists in no offered voice', async () => {
    const settingsStore = createIndexedDbSettingsStore()
    const clipCache = createIndexedDbClipCache()
    await settingsStore.setVoice({ provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-new' })

    const ready = await clipCache.readyPhraseIds(
      [{ id: 'p1', french: 'Bonjour', english: 'Hello' }],
      knownVoices((await settingsStore.load()).voice),
    )

    expect(ready).toEqual(new Set())
  })
})
