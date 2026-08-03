import { describe, expect, it, vi } from 'vitest'
import { createGenerationQueue, type GenerationStatus } from './generation-queue'
import type { SynthClient, SynthError } from './server-synth-client'
import type { Clip, ClipCache } from '../storage/clip-cache'
import { computeClipHash } from '../storage/clip-cache'
import type { Voice } from '../storage/settings-store'

const VOICE: Voice = { provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-1' }
const PHRASE = { id: 'p1', french: 'Bonjour', english: 'Hello' }

function unauthorized(): SynthError {
  return { kind: 'unauthorized' }
}
function quota(): SynthError {
  return { kind: 'quota' }
}
function network(): SynthError {
  return { kind: 'network', detail: 'Failed to fetch' }
}

/** A minimal in-memory ClipCache fake — this module's own tests exercise the
 * real IndexedDB one; the queue only needs get/put/has. */
function createFakeClipCache(): ClipCache {
  const clips = new Map<string, Clip>()
  return {
    async get(hash) {
      return clips.get(hash)
    },
    async put(clip) {
      clips.set(clip.hash, clip)
    },
    async has(hash) {
      return clips.has(hash)
    },
    async readyPhraseIds() {
      return new Set()
    },
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('createGenerationQueue', () => {
  it('synthesizes and caches both the French and English clips for a Phrase, then reports ready', async () => {
    const clipCache = createFakeClipCache()
    const synthesize = vi.fn<SynthClient['synthesize']>().mockResolvedValue({
      bytes: new ArrayBuffer(8),
      durationMs: 500,
    })
    const queue = createGenerationQueue({
      synthClient: { synthesize },
      clipCache,
      getVoice: async () => VOICE,
    })

    queue.enqueue(PHRASE)
    await flush()
    await flush()

    expect(synthesize).toHaveBeenCalledTimes(2)
    expect(synthesize).toHaveBeenCalledWith('Bonjour', 'fr-FR', { modelId: VOICE.modelId, voiceId: VOICE.voiceId })
    expect(synthesize).toHaveBeenCalledWith('Hello', 'en-US', { modelId: VOICE.modelId, voiceId: VOICE.voiceId })
    const frHash = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Bonjour' })
    expect(await clipCache.has(frHash)).toBe(true)
    expect(queue.statusFor('p1')).toEqual<GenerationStatus>({ kind: 'ready' })
  })

  it('does not call the synth client, and stays un-queued, when no voice is pinned', async () => {
    const synthesize = vi.fn<SynthClient['synthesize']>()
    const queue = createGenerationQueue({
      synthClient: { synthesize },
      clipCache: createFakeClipCache(),
      getVoice: async () => null,
    })

    queue.enqueue(PHRASE)
    await flush()
    await flush()

    expect(synthesize).not.toHaveBeenCalled()
    expect(queue.statusFor('p1')).toBeUndefined()
  })

  it('skips a clip already in the cache rather than re-synthesizing it', async () => {
    const clipCache = createFakeClipCache()
    const frHash = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Bonjour' })
    await clipCache.put({ hash: frHash, bytes: new ArrayBuffer(1), mime: 'audio/mpeg', durationMs: 1, createdAt: 1 })
    const synthesize = vi.fn<SynthClient['synthesize']>().mockResolvedValue({ bytes: new ArrayBuffer(1), durationMs: 1 })
    const queue = createGenerationQueue({ synthClient: { synthesize }, clipCache, getVoice: async () => VOICE })

    queue.enqueue(PHRASE)
    await flush()
    await flush()

    expect(synthesize).toHaveBeenCalledTimes(1)
    expect(synthesize).toHaveBeenCalledWith('Hello', 'en-US', { modelId: VOICE.modelId, voiceId: VOICE.voiceId })
  })

  it('retries a network failure and succeeds on a later attempt', async () => {
    const clipCache = createFakeClipCache()
    const synthesize = vi
      .fn<SynthClient['synthesize']>()
      .mockRejectedValueOnce(network())
      .mockResolvedValue({ bytes: new ArrayBuffer(1), durationMs: 1 })
    const queue = createGenerationQueue({ synthClient: { synthesize }, clipCache, getVoice: async () => VOICE })

    queue.enqueue(PHRASE)
    for (let i = 0; i < 5; i++) await flush()

    expect(queue.statusFor('p1')).toEqual<GenerationStatus>({ kind: 'ready' })
  })

  it('gives up after a bounded number of network failures — never retries forever', async () => {
    const clipCache = createFakeClipCache()
    const synthesize = vi.fn<SynthClient['synthesize']>().mockRejectedValue(network())
    const queue = createGenerationQueue({
      synthClient: { synthesize },
      clipCache,
      getVoice: async () => VOICE,
      maxAttempts: 3,
    })

    queue.enqueue({ id: 'p2', french: 'Salut', english: '' })
    for (let i = 0; i < 10; i++) await flush()

    // one target only (english is empty and cached-skip doesn't apply, but
    // we only assert the bounded-retry target here): french attempted
    // exactly maxAttempts times, never more.
    const frenchCalls = synthesize.mock.calls.filter((call) => call[0] === 'Salut')
    expect(frenchCalls).toHaveLength(3)
    expect(queue.statusFor('p2')).toEqual<GenerationStatus>({ kind: 'failed' })
  })

  it('surfaces unauthorized as a visible state and never retries it', async () => {
    const clipCache = createFakeClipCache()
    const synthesize = vi.fn<SynthClient['synthesize']>().mockRejectedValue(unauthorized())
    const queue = createGenerationQueue({ synthClient: { synthesize }, clipCache, getVoice: async () => VOICE })

    queue.enqueue(PHRASE)
    for (let i = 0; i < 5; i++) await flush()

    expect(queue.statusFor('p1')).toEqual<GenerationStatus>({ kind: 'unauthorized' })
    const frenchCalls = synthesize.mock.calls.filter((call) => call[0] === 'Bonjour')
    expect(frenchCalls).toHaveLength(1)
  })

  it('surfaces quota as a visible state and never retries it', async () => {
    const clipCache = createFakeClipCache()
    const synthesize = vi.fn<SynthClient['synthesize']>().mockRejectedValue(quota())
    const queue = createGenerationQueue({ synthClient: { synthesize }, clipCache, getVoice: async () => VOICE })

    queue.enqueue(PHRASE)
    for (let i = 0; i < 5; i++) await flush()

    expect(queue.statusFor('p1')).toEqual<GenerationStatus>({ kind: 'quota' })
    const frenchCalls = synthesize.mock.calls.filter((call) => call[0] === 'Bonjour')
    expect(frenchCalls).toHaveLength(1)
  })

  it('reports unauthorized for the whole Phrase even when only one of its two clips is affected', async () => {
    const clipCache = createFakeClipCache()
    const synthesize = vi.fn<SynthClient['synthesize']>().mockImplementation(async (text: string) => {
      if (text === 'Bonjour') throw unauthorized()
      return { bytes: new ArrayBuffer(1), durationMs: 1 }
    })
    const queue = createGenerationQueue({ synthClient: { synthesize }, clipCache, getVoice: async () => VOICE })

    queue.enqueue(PHRASE)
    for (let i = 0; i < 5; i++) await flush()

    expect(queue.statusFor('p1')).toEqual<GenerationStatus>({ kind: 'unauthorized' })
  })

  it('notifies onStatusChange as generation starts and settles', async () => {
    const clipCache = createFakeClipCache()
    const synthesize = vi.fn<SynthClient['synthesize']>().mockResolvedValue({ bytes: new ArrayBuffer(1), durationMs: 1 })
    const onStatusChange = vi.fn()
    const queue = createGenerationQueue({
      synthClient: { synthesize },
      clipCache,
      getVoice: async () => VOICE,
      onStatusChange,
    })

    queue.enqueue(PHRASE)
    for (let i = 0; i < 5; i++) await flush()

    expect(onStatusChange).toHaveBeenCalledWith('p1', { kind: 'generating' })
    expect(onStatusChange).toHaveBeenCalledWith('p1', { kind: 'ready' })
  })

  it('does not gate on a caller awaiting it — enqueue itself never returns a Promise', () => {
    const queue = createGenerationQueue({
      synthClient: { synthesize: vi.fn().mockReturnValue(new Promise(() => {})) },
      clipCache: createFakeClipCache(),
      getVoice: async () => VOICE,
    })

    expect(queue.enqueue(PHRASE)).toBeUndefined()
  })
})
