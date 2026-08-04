// T067 — THE acceptance test for "a voice change must not regenerate the
// library".
//
// The owner's instruction, verbatim: "I don't want it to regenerate thousands
// of translations for a voice change. That just doesn't make sense. If they
// are generated in a voice, just keep it that way."
//
// So this drives the real clip cache, the real readiness sweep, the real
// generation queue and the real clip player through the sequence that used to
// cost ~2,000 requests: a library fully generated in voice A, then voice B
// pinned. Nothing may be enqueued, every Phrase must still read ready, and
// the drill must still produce audio — the A-voiced audio, which is the only
// audio there is.
//
// Named `.integration.test.ts` for the reason the others are: it wires
// several real adapters together rather than testing one against fakes.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetFakeIdb } from '../storage/idb.test-support'

vi.mock('idb', async () => {
  const fake = await import('../storage/idb.test-support')
  return { openDB: fake.openDB }
})

// Imported after the mock is registered, per Vitest's hoisting contract.
const { createIndexedDbClipCache, computeClipHash } = await import('../storage/clip-cache')
const { createIndexedDbSettingsStore } = await import('../storage/settings-store')
const { createGenerationQueue } = await import('./generation-queue')
const { computeDrillReadiness } = await import('./drill-readiness')
const { createClipPlayer } = await import('./clip-player')
const { knownVoices, VOICE_CATALOGUE } = await import('./voice-catalogue')

type Voice = import('../../domain').Voice
type Phrase = import('../../domain').Phrase
type SynthClient = import('./server-synth-client').SynthClient

/** Two voices actually in the catalogue — she can only pin one of those. */
const VOICE_A: Voice = pick(0)
const VOICE_B: Voice = pick(1)

function pick(index: number): Voice {
  const entry = VOICE_CATALOGUE[index]!
  return { provider: entry.provider, modelId: entry.modelId, voiceId: entry.voiceId }
}

const PHRASES: Phrase[] = [
  { id: 'p1', french: 'Bonjour', english: 'Hello' },
  { id: 'p2', french: 'Salut', english: 'Hi' },
  { id: 'p3', french: 'Merci', english: 'Thanks' },
]

/** Counts what it was asked to make, and in which voice. Never a real network. */
function countingSynthClient(): SynthClient & { calls: { text: string; voiceId: string }[] } {
  const calls: { text: string; voiceId: string }[] = []
  return {
    calls,
    async synthesize(text, _lang, voice) {
      calls.push({ text, voiceId: voice.voiceId })
      return { bytes: new TextEncoder().encode(`${voice.voiceId}:${text}`).buffer as ArrayBuffer, durationMs: 10 }
    },
  }
}

describe('changing the pinned voice (T067)', () => {
  beforeEach(() => {
    resetFakeIdb()
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(true) } })
  })

  async function generatedInVoiceA() {
    const clipCache = createIndexedDbClipCache()
    const settingsStore = createIndexedDbSettingsStore()
    const synthClient = countingSynthClient()
    const queue = createGenerationQueue({
      synthClient,
      clipCache,
      getVoice: () => settingsStore.load().then((s) => s.voice),
    })
    await settingsStore.setVoice(VOICE_A)
    for (const phrase of PHRASES) queue.enqueue(phrase)
    await queue.whenIdle()
    expect(synthClient.calls).toHaveLength(PHRASES.length * 2)
    return { clipCache, settingsStore, synthClient, queue }
  }

  it('enqueues nothing and keeps every Phrase ready when the pinned voice changes', async () => {
    const { clipCache, settingsStore, synthClient } = await generatedInVoiceA()
    const enqueue = vi.fn()
    synthClient.calls.length = 0

    await settingsStore.setVoice(VOICE_B)
    const readiness = await computeDrillReadiness(PHRASES, {
      clipCache,
      generationQueue: { enqueue, statusFor: vi.fn(), whenIdle: async () => {} },
      voice: (await settingsStore.load()).voice,
      isOnline: () => true,
    })

    expect(enqueue).toHaveBeenCalledTimes(0)
    expect(readiness.ready.map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
    expect(readiness.skippedCount).toBe(0)
    expect(readiness.canStart).toBe(true)
    expect(synthClient.calls).toHaveLength(0)
  })

  it('still plays audio after the switch — the Clips made in the old voice', async () => {
    const { clipCache, settingsStore } = await generatedInVoiceA()
    await settingsStore.setVoice(VOICE_B)
    const played: string[] = []
    const element = {
      src: '',
      play: async () => {
        played.push(element.src)
      },
      pause: () => {},
      addEventListener: (_type: 'ended', listener: () => void) => {
        setTimeout(listener, 0)
      },
      removeEventListener: () => {},
    }
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:played', revokeObjectURL: () => {} })
    const onMissingClip = vi.fn()

    const player = createClipPlayer({
      element,
      clipCache,
      voices: knownVoices((await settingsStore.load()).voice),
      onMissingClip,
    })
    await player.speak('Bonjour', 'fr-FR')

    expect(onMissingClip).not.toHaveBeenCalled()
    expect(played).toEqual(['blob:played'])
  })

  it('generates a Phrase added after the switch in the newly pinned voice, and only that Phrase', async () => {
    const { clipCache, settingsStore, synthClient, queue } = await generatedInVoiceA()
    await settingsStore.setVoice(VOICE_B)
    synthClient.calls.length = 0

    queue.enqueue({ id: 'p4', french: 'Au revoir', english: 'Goodbye' })
    await queue.whenIdle()

    expect(synthClient.calls.map((c) => c.voiceId)).toEqual([VOICE_B.voiceId, VOICE_B.voiceId])
    expect(await clipCache.has(await computeClipHash({ ...VOICE_B, lang: 'fr-FR', text: 'Au revoir' }))).toBe(true)
  })

  /**
   * Requirement 4: an explicit, user-initiated re-generation. It ADDS Clips
   * in the current voice; it deletes nothing. Because a Clip is
   * content-addressed by `provider|modelId|voiceId|lang|text`, the old
   * voice's Clips are at different hashes and simply stay.
   */
  it('adds Clips in the new voice on an explicit re-generation, leaving the old voice\'s Clips in the cache', async () => {
    const { clipCache, settingsStore, synthClient, queue } = await generatedInVoiceA()
    await settingsStore.setVoice(VOICE_B)
    synthClient.calls.length = 0

    for (const phrase of PHRASES) queue.enqueue(phrase)
    await queue.whenIdle()

    expect(synthClient.calls).toHaveLength(PHRASES.length * 2)
    expect(new Set(synthClient.calls.map((c) => c.voiceId))).toEqual(new Set([VOICE_B.voiceId]))
    for (const phrase of PHRASES) {
      expect(await clipCache.has(await computeClipHash({ ...VOICE_A, lang: 'fr-FR', text: phrase.french }))).toBe(true)
      expect(await clipCache.has(await computeClipHash({ ...VOICE_B, lang: 'fr-FR', text: phrase.french }))).toBe(true)
    }
  })

  it('costs nothing to ask twice for the same voice and statement — the second request hits the cache', async () => {
    const { synthClient, queue } = await generatedInVoiceA()
    synthClient.calls.length = 0

    for (const phrase of PHRASES) queue.enqueue(phrase)
    await queue.whenIdle()

    expect(synthClient.calls).toHaveLength(0)
  })
})
