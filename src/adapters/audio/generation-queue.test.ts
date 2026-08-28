import { describe, expect, it, vi } from 'vitest'
import { createGenerationQueue, type GenerationStatus } from './generation-queue'
import type { SynthClient, SynthError } from './server-synth-client'
import type { Clip, ClipCache } from '../storage/clip-cache'
import { computeClipHash } from '../storage/clip-cache'
import type { Voice } from '../../domain'
import { buildLineRep, buildPhraseRep } from '../../domain'

const VOICE: Voice = { provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-1' }

/** The two-Statement unit these tests mostly drive: a Phrase's Rep, French then English. */
const PHRASE = buildPhraseRep({ id: 'p1', french: 'Bonjour', english: 'Hello' })

/** The one-Statement unit: a Line's Rep, French alone. */
const LINE = buildLineRep({ id: 'l1', text: 'Il faisait beau ce matin.' })

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
    async readyUnitIds() {
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

/** Lets every turn already scheduled run out, so a "did not happen" can be
 * asserted. This is the one thing `whenIdle()` cannot serve: a suspended
 * queue's parked work is genuinely still outstanding, so the latch does not
 * resolve (see `whenIdle`'s doc comment). Only the negative half of a
 * suspension test uses it; every positive half still awaits `whenIdle()`.
 * Same shape as the outstanding-work test below already relies on.
 *
 * Not a tuned wall-clock delay and not fakeable: the drain being waited out
 * is `getVoice`, a `crypto.subtle` digest and a cache read — promise turns,
 * with no timer in them for `vi.advanceTimersByTime` to advance. A
 * zero-delay `setTimeout` is the macrotask yield that lets those turns run,
 * so its cost is scheduler latency, not elapsed time. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
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

    queue.enqueue(buildPhraseRep({ id: 'p9', french: 'Salut', english: 'Hi' }))
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

    queue.enqueue(buildPhraseRep({ id: 'p2', french: 'Salut', english: '' }))
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
    // Exact on the count, because the count is what a bad gate destroys, and
    // `toContain(2000)` cannot see it. One 429 produces two waits: `resumeAt`
    // is queue-wide, so the sibling English Clip, which has not yet reached
    // the gate, waits the same window out — the documented "the whole queue
    // holds off". A gate that re-read `resumeAt` after each sleep put
    // 50,475,833 entries here (measured), and would not terminate at all
    // against a frozen `now`; `toContain(2000)` passed under it, because the
    // first entry is still right.
    //
    // Only the refused Clip's own wait is pinned to a value. It is computed
    // microtasks after `resumeAt` was set, on the same synchronous path out
    // of the `catch`, so no clock tick can reach it. The sibling's is one
    // real millisecond away from 1999, and asserting it would flake.
    expect(sleeps).toHaveLength(2)
    expect(sleeps[0]).toBe(2000)
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

    queue.enqueue(buildPhraseRep({ id: 'p3', french: 'Salut', english: 'Hi' }))
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

    for (let i = 0; i < 50; i++) queue.enqueue(buildPhraseRep({ id: `c${i}`, french: `fr-${i}`, english: `en-${i}` }))
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

  // ── N Statements, not two ───────────────────────────────────────────────
  // A Phrase's Rep carries two Statements, a Line's carries one, and the
  // queue reads the list rather than assuming a French/English pair. These
  // are the one-Statement mirrors of the two-Statement cases above.

  it('synthesizes exactly one Clip for a one-Statement unit, and reports it ready', async () => {
    const clipCache = createFakeClipCache()
    const synthesize = vi.fn<SynthClient['synthesize']>().mockResolvedValue({
      bytes: new ArrayBuffer(8),
      durationMs: 500,
    })
    const queue = createGenerationQueue({ synthClient: { synthesize }, clipCache, getVoice: async () => VOICE })

    queue.enqueue(LINE)
    await queue.whenIdle()

    expect(synthesize).toHaveBeenCalledTimes(1)
    expect(synthesize).toHaveBeenCalledWith('Il faisait beau ce matin.', 'fr-FR', {
      provider: VOICE.provider,
      modelId: VOICE.modelId,
      voiceId: VOICE.voiceId,
    })
    const hash = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Il faisait beau ce matin.' })
    expect(await clipCache.has(hash)).toBe(true)
    expect(queue.statusFor('l1')).toEqual<GenerationStatus>({ kind: 'ready' })
  })

  /** The one-of-one mirror of "one of two clips is affected", above: with a
   * single Statement the worst outcome and the only outcome coincide, and the
   * unit must still report the failure rather than nothing. */
  it('reports unauthorized for a one-Statement unit whose single request is refused', async () => {
    const clipCache = createFakeClipCache()
    const synthesize = vi.fn<SynthClient['synthesize']>().mockRejectedValue(unauthorized())
    const queue = createGenerationQueue({ synthClient: { synthesize }, clipCache, getVoice: async () => VOICE })

    queue.enqueue(LINE)
    await queue.whenIdle()

    expect(queue.statusFor('l1')).toEqual<GenerationStatus>({ kind: 'unauthorized' })
    expect(synthesize).toHaveBeenCalledTimes(1)
  })

  it('reports a one-Statement unit failed when its single request runs out of network attempts', async () => {
    const clipCache = createFakeClipCache()
    const synthesize = vi.fn<SynthClient['synthesize']>().mockRejectedValue(network())
    const queue = createGenerationQueue({
      synthClient: { synthesize },
      clipCache,
      getVoice: async () => VOICE,
      maxAttempts: 3,
    })

    queue.enqueue(LINE)
    await queue.whenIdle()

    expect(synthesize).toHaveBeenCalledTimes(3)
    expect(queue.statusFor('l1')).toEqual<GenerationStatus>({ kind: 'failed' })
  })

  /**
   * `combineAll([])`, reached through the port that owns it. Nothing to
   * generate is nothing outstanding, so the honest answer is `ready` — and
   * the alternative is worse than merely wrong: `generating` is a status
   * nothing would ever settle, leaving a Statement-less unit reading
   * "in flight" forever on a screen that is waiting for it to finish.
   */
  it('reports a unit with no Statements ready without asking the synth client for anything', async () => {
    const clipCache = createFakeClipCache()
    const synthesize = vi.fn<SynthClient['synthesize']>()
    const queue = createGenerationQueue({ synthClient: { synthesize }, clipCache, getVoice: async () => VOICE })

    queue.enqueue({ id: 'u0', statements: [] })
    await queue.whenIdle()

    expect(synthesize).not.toHaveBeenCalled()
    expect(queue.statusFor('u0')).toEqual<GenerationStatus>({ kind: 'ready' })
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

  // ── Generation suspension ───────────────────────────────────────────────
  // A Drill is playing on a phone on cellular. Four concurrent HTTPS fetches,
  // four MP3 bodies, and the IndexedDB writes behind them do not get to
  // compete with the audio the user is listening to.

  it('issues no request while suspended, and issues both Clips once resumed', async () => {
    const clipCache = createFakeClipCache()
    const synthesize = vi.fn<SynthClient['synthesize']>().mockResolvedValue({ bytes: new ArrayBuffer(1), durationMs: 1 })
    const queue = createGenerationQueue({ synthClient: { synthesize }, clipCache, getVoice: async () => VOICE })

    queue.suspend()
    queue.enqueue(PHRASE)
    await settle()
    expect(synthesize).not.toHaveBeenCalled()

    queue.resume()
    await queue.whenIdle()

    expect(synthesize).toHaveBeenCalledTimes(2)
    expect(synthesize).toHaveBeenCalledWith('Bonjour', 'fr-FR', { provider: VOICE.provider, modelId: VOICE.modelId, voiceId: VOICE.voiceId })
    expect(synthesize).toHaveBeenCalledWith('Hello', 'en-US', { provider: VOICE.provider, modelId: VOICE.modelId, voiceId: VOICE.voiceId })
  })

  it('leaves exactly maxConcurrent requests behind it when suspension lands mid-drain', async () => {
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

    for (let i = 0; i < 4; i++) queue.enqueue(buildPhraseRep({ id: `s${i}`, french: `fr-${i}`, english: `en-${i}` }))
    await settle()
    expect(synthesize).toHaveBeenCalledTimes(2)

    queue.suspend()
    // The two slot holders settle, so their slots free and the backlog wakes.
    // Every woken Clip must park rather than take its turn.
    for (const resolve of pending.splice(0)) resolve({ bytes: new ArrayBuffer(1), durationMs: 1 })
    await settle()

    expect(synthesize).toHaveBeenCalledTimes(2)
  })

  it('parks a retrying Clip rather than spending its last attempt on it', async () => {
    const clipCache = createFakeClipCache()
    let frenchCalls = 0
    const synthesize = vi.fn<SynthClient['synthesize']>().mockImplementation(async (text: string) => {
      if (text !== 'Bonjour') return { bytes: new ArrayBuffer(1), durationMs: 1 }
      frenchCalls++
      if (frenchCalls === 1) queue.suspend()
      throw network()
    })
    const queue = createGenerationQueue({
      synthClient: { synthesize },
      clipCache,
      getVoice: async () => VOICE,
      // Two attempts: a gate below `networkAttempts++` would spend the second
      // one here and report the Phrase failed.
      maxAttempts: 2,
    })

    queue.enqueue(PHRASE)
    await settle()

    expect(synthesize.mock.calls.filter((call) => call[0] === 'Bonjour')).toHaveLength(1)
    expect(queue.statusFor('p1')).toEqual<GenerationStatus>({ kind: 'generating' })
  })

  it('does not retry a rate-limited Clip until resume when suspension lands inside the wait', async () => {
    const clipCache = createFakeClipCache()
    // English pre-cached, so exactly one Clip reaches the network and the
    // single sleep below is unambiguously its own.
    const enHash = await computeClipHash({ ...VOICE, lang: 'en-US', text: 'Hello' })
    await clipCache.put({ hash: enHash, bytes: new ArrayBuffer(1), mime: 'audio/mpeg', durationMs: 1, createdAt: 1 })
    const sleeps: number[] = []
    const synthesize = vi
      .fn<SynthClient['synthesize']>()
      .mockRejectedValueOnce(rateLimited(1000))
      .mockResolvedValue({ bytes: new ArrayBuffer(1), durationMs: 1 })
    const queue = createGenerationQueue({
      synthClient: { synthesize },
      clipCache,
      getVoice: async () => VOICE,
      sleep: async (ms) => {
        sleeps.push(ms)
        if (sleeps.length === 1) queue.suspend()
      },
    })

    queue.enqueue(PHRASE)
    await settle()

    expect(synthesize).toHaveBeenCalledTimes(1)

    queue.resume()
    await queue.whenIdle()

    expect(synthesize).toHaveBeenCalledTimes(2)
  })

  it('takes suspension as an idempotent boolean, not a counter', async () => {
    const clipCache = createFakeClipCache()
    const synthesize = vi.fn<SynthClient['synthesize']>().mockResolvedValue({ bytes: new ArrayBuffer(1), durationMs: 1 })
    const queue = createGenerationQueue({ synthClient: { synthesize }, clipCache, getVoice: async () => VOICE })

    queue.resume() // nothing is suspended: a no-op, not a throw and not a debt
    queue.suspend()
    queue.suspend()
    queue.enqueue(PHRASE)
    await settle()
    expect(synthesize).not.toHaveBeenCalled()

    queue.resume() // one release answers both takes
    await queue.whenIdle()

    expect(synthesize).toHaveBeenCalledTimes(2)
  })

  it('does not report itself idle while suspended work is parked, and does once resumed', async () => {
    const clipCache = createFakeClipCache()
    const synthesize = vi.fn<SynthClient['synthesize']>().mockResolvedValue({ bytes: new ArrayBuffer(1), durationMs: 1 })
    const queue = createGenerationQueue({ synthClient: { synthesize }, clipCache, getVoice: async () => VOICE })

    queue.suspend()
    queue.enqueue(PHRASE)
    let idle = false
    void queue.whenIdle().then(() => {
      idle = true
    })
    await settle()
    expect(idle).toBe(false)

    queue.resume()
    await queue.whenIdle()

    expect(idle).toBe(true)
  })

  it('reads nothing from the clip cache while suspended', async () => {
    const clipCache = createFakeClipCache()
    const has = vi.spyOn(clipCache, 'has')
    const synthesize = vi.fn<SynthClient['synthesize']>().mockResolvedValue({ bytes: new ArrayBuffer(1), durationMs: 1 })
    const queue = createGenerationQueue({ synthClient: { synthesize }, clipCache, getVoice: async () => VOICE })

    queue.suspend()
    queue.enqueue(PHRASE)
    await settle()

    // The gate is at `generateOne` too, not only at the request: a suspended
    // queue does no crypto and no IndexedDB work, so the Clip the ClipPlayer
    // is about to `get()` is not queued behind a library's worth of reads.
    expect(has).not.toHaveBeenCalled()

    queue.resume()
    await queue.whenIdle()
    expect(has).toHaveBeenCalled()
  })
})
