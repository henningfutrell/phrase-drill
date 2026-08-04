import { describe, expect, it, vi } from 'vitest'
import { createGenerationQueue, type GenerationStatus } from './generation-queue'
import type { SynthClient, SynthError } from './server-synth-client'
import type { Clip, ClipCache } from '../storage/clip-cache'
import { computeClipHash } from '../storage/clip-cache'
import type { Voice } from '../../domain'

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
function rateLimited(retryAfterMs = 1000): SynthError {
  return { kind: 'rate-limited', retryAfterMs }
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

// Every test below awaits `queue.whenIdle()` and never a fixed number of
// microtask turns (T056). Counting turns was a race: the work behind one
// `enqueue` is a variable number of them — `getVoice`, `computeClipHash`'s
// `crypto.subtle` digest, the cache write, and now a concurrency slot and a
// backoff — so any constant that happens to be enough today fails under load.
// It failed roughly 1 run in 12 before this.

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
    await queue.whenIdle()

    expect(synthesize).toHaveBeenCalledTimes(2)
    expect(synthesize).toHaveBeenCalledWith('Bonjour', 'fr-FR', { provider: VOICE.provider, modelId: VOICE.modelId, voiceId: VOICE.voiceId })
    expect(synthesize).toHaveBeenCalledWith('Hello', 'en-US', { provider: VOICE.provider, modelId: VOICE.modelId, voiceId: VOICE.voiceId })
    const frHash = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Bonjour' })
    expect(await clipCache.has(frHash)).toBe(true)
    expect(queue.statusFor('p1')).toEqual<GenerationStatus>({ kind: 'ready' })
  })

  it('is idle before anything is enqueued', async () => {
    const queue = createGenerationQueue({
      synthClient: { synthesize: vi.fn().mockReturnValue(new Promise(() => {})) },
      clipCache: createFakeClipCache(),
      getVoice: async () => VOICE,
    })

    await expect(queue.whenIdle()).resolves.toBeUndefined()
  })

  it('is not idle while work is outstanding, and becomes idle once it settles', async () => {
    const pending: Array<(result: { bytes: ArrayBuffer; durationMs: number }) => void> = []
    const synthesize = vi
      .fn<SynthClient['synthesize']>()
      .mockImplementation(() => new Promise((resolve) => pending.push(resolve)))
    const queue = createGenerationQueue({
      synthClient: { synthesize },
      clipCache: createFakeClipCache(),
      getVoice: async () => VOICE,
      maxConcurrent: 2,
    })

    queue.enqueue({ id: 'p9', french: 'Salut', english: 'Hi' })
    let idle = false
    void queue.whenIdle().then(() => {
      idle = true
    })
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(idle).toBe(false)
    expect(pending).toHaveLength(2)

    for (const resolve of pending) resolve({ bytes: new ArrayBuffer(1), durationMs: 1 })
    await queue.whenIdle()
    expect(idle).toBe(true)
  })

  it('does not call the synth client, and stays un-queued, when no voice is pinned', async () => {
    const synthesize = vi.fn<SynthClient['synthesize']>()
    const queue = createGenerationQueue({
      synthClient: { synthesize },
      clipCache: createFakeClipCache(),
      getVoice: async () => null,
    })

    queue.enqueue(PHRASE)
    await queue.whenIdle()

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
    await queue.whenIdle()

    expect(synthesize).toHaveBeenCalledTimes(1)
    expect(synthesize).toHaveBeenCalledWith('Hello', 'en-US', { provider: VOICE.provider, modelId: VOICE.modelId, voiceId: VOICE.voiceId })
  })

  it('retries a network failure and succeeds on a later attempt', async () => {
    const clipCache = createFakeClipCache()
    const synthesize = vi
      .fn<SynthClient['synthesize']>()
      .mockRejectedValueOnce(network())
      .mockResolvedValue({ bytes: new ArrayBuffer(1), durationMs: 1 })
    const queue = createGenerationQueue({ synthClient: { synthesize }, clipCache, getVoice: async () => VOICE })

    queue.enqueue(PHRASE)
    await queue.whenIdle()

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
    await queue.whenIdle()

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
    await queue.whenIdle()

    expect(queue.statusFor('p1')).toEqual<GenerationStatus>({ kind: 'unauthorized' })
    const frenchCalls = synthesize.mock.calls.filter((call) => call[0] === 'Bonjour')
    expect(frenchCalls).toHaveLength(1)
  })

  // The provider is out of credits. No amount of waiting fixes that, so it
  // stays terminal — this is the case T035 must NOT turn into a retry loop.
  it('surfaces quota as a visible state and never retries it', async () => {
    const clipCache = createFakeClipCache()
    const synthesize = vi.fn<SynthClient['synthesize']>().mockRejectedValue(quota())
    const queue = createGenerationQueue({ synthClient: { synthesize }, clipCache, getVoice: async () => VOICE })

    queue.enqueue(PHRASE)
    await queue.whenIdle()

    expect(queue.statusFor('p1')).toEqual<GenerationStatus>({ kind: 'quota' })
    const frenchCalls = synthesize.mock.calls.filter((call) => call[0] === 'Bonjour')
    expect(frenchCalls).toHaveLength(1)
  })

  // T035. `quota` above is the provider out of credits — terminal. This is
  // our own server's limiter, which is a queue, not a wall: waiting is the
  // whole remedy, and giving up on it is what killed 1,940 Phrases of a cold
  // 1,000-Phrase sweep.
  it('waits the time our own server asked for and retries, rather than failing the Phrase', async () => {
    const clipCache = createFakeClipCache()
    const sleeps: number[] = []
    const synthesize = vi
      .fn<SynthClient['synthesize']>()
      .mockRejectedValueOnce(rateLimited(2000))
      .mockResolvedValue({ bytes: new ArrayBuffer(1), durationMs: 1 })
    const queue = createGenerationQueue({
      synthClient: { synthesize },
      clipCache,
      getVoice: async () => VOICE,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })

    queue.enqueue(PHRASE)
    await queue.whenIdle()

    expect(queue.statusFor('p1')).toEqual<GenerationStatus>({ kind: 'ready' })
    expect(sleeps).toContain(2000)
  })

  it('gives up after a bounded number of rate-limit waits — the sweep always terminates', async () => {
    const clipCache = createFakeClipCache()
    const synthesize = vi.fn<SynthClient['synthesize']>().mockRejectedValue(rateLimited(1000))
    const queue = createGenerationQueue({
      synthClient: { synthesize },
      clipCache,
      getVoice: async () => VOICE,
      maxRateLimitWaits: 4,
      sleep: async () => {},
    })

    queue.enqueue({ id: 'p3', french: 'Salut', english: 'Hi' })
    await queue.whenIdle()

    const frenchCalls = synthesize.mock.calls.filter((call) => call[0] === 'Salut')
    expect(frenchCalls).toHaveLength(5) // the first attempt plus four waits
    expect(queue.statusFor('p3')).toEqual<GenerationStatus>({ kind: 'failed' })
  })

  it('never has more than maxConcurrent requests in flight, however many Phrases are enqueued at once', async () => {
    const clipCache = createFakeClipCache()
    let inFlight = 0
    let peakInFlight = 0
    const synthesize = vi.fn<SynthClient['synthesize']>().mockImplementation(async () => {
      inFlight++
      peakInFlight = Math.max(peakInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 0))
      inFlight--
      return { bytes: new ArrayBuffer(1), durationMs: 1 }
    })
    const queue = createGenerationQueue({
      synthClient: { synthesize },
      clipCache,
      getVoice: async () => VOICE,
      maxConcurrent: 3,
    })

    for (let i = 0; i < 50; i++) queue.enqueue({ id: `c${i}`, french: `fr-${i}`, english: `en-${i}` })
    await queue.whenIdle()

    expect(synthesize).toHaveBeenCalledTimes(100)
    expect(peakInFlight).toBeLessThanOrEqual(3)
    expect(queue.statusFor('c49')).toEqual<GenerationStatus>({ kind: 'ready' })
  })

  it('reports unauthorized for the whole Phrase even when only one of its two clips is affected', async () => {
    const clipCache = createFakeClipCache()
    const synthesize = vi.fn<SynthClient['synthesize']>().mockImplementation(async (text: string) => {
      if (text === 'Bonjour') throw unauthorized()
      return { bytes: new ArrayBuffer(1), durationMs: 1 }
    })
    const queue = createGenerationQueue({ synthClient: { synthesize }, clipCache, getVoice: async () => VOICE })

    queue.enqueue(PHRASE)
    await queue.whenIdle()

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
    await queue.whenIdle()

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
