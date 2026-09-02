import { describe, expect, it, vi, type Mock } from 'vitest'
import { computeDrillReadiness } from './drill-readiness'
import { computeClipHash, type ClipCache } from '../storage/clip-cache'
import type { GenerationQueue } from './generation-queue'
import type { Rep, Voice } from '../../domain'
import { buildLineRep, buildPhraseRep } from '../../domain'
import { knownVoices } from './voice-catalogue'

const VOICE: Voice = { provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-1' }

/** Three Phrase Reps — two Statements each, French then English. */
const REPS: Rep[] = [
  buildPhraseRep({ id: 'p1', french: 'Bonjour', english: 'Hello' }),
  buildPhraseRep({ id: 'p2', french: 'Salut', english: 'Hi' }),
  buildPhraseRep({ id: 'p3', french: 'Merci', english: 'Thanks' }),
]

function fakeClipCache(ready: readonly string[]): ClipCache {
  return {
    get: vi.fn(),
    put: vi.fn(),
    has: vi.fn(),
    readyUnitIds: vi.fn().mockResolvedValue(new Set(ready)),
  }
}

function fakeQueue(): GenerationQueue & { enqueue: Mock<GenerationQueue['enqueue']> } {
  return {
    enqueue: vi.fn<GenerationQueue['enqueue']>(),
    statusFor: vi.fn(),
    whenIdle: vi.fn().mockResolvedValue(undefined),
    suspend: vi.fn(),
    resume: vi.fn(),
    watchRefusals: vi.fn().mockReturnValue(() => {}),
  }
}

describe('computeDrillReadiness', () => {
  it('excludes unready Reps and reports how many were skipped', async () => {
    const clipCache = fakeClipCache(['p1'])
    const generationQueue = fakeQueue()

    const result = await computeDrillReadiness(REPS, { clipCache, generationQueue, voice: VOICE })

    expect(result.ready.map((rep) => rep.id)).toEqual(['p1'])
    expect(result.skippedCount).toBe(2)
    expect(result.canStart).toBe(true)
  })

  it('queues generation for every unready Rep when online', async () => {
    const clipCache = fakeClipCache(['p1'])
    const generationQueue = fakeQueue()

    await computeDrillReadiness(REPS, { clipCache, generationQueue, voice: VOICE, isOnline: () => true })

    expect(generationQueue.enqueue).toHaveBeenCalledTimes(2)
    expect(generationQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({ id: 'p2' }))
    expect(generationQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({ id: 'p3' }))
  })

  it('does not queue anything while offline, though the exclusion still applies', async () => {
    const clipCache = fakeClipCache(['p1'])
    const generationQueue = fakeQueue()

    const result = await computeDrillReadiness(REPS, { clipCache, generationQueue, voice: VOICE, isOnline: () => false })

    expect(generationQueue.enqueue).not.toHaveBeenCalled()
    expect(result.skippedCount).toBe(2)
  })

  it('cannot start, with a reason, when every Rep is unready', async () => {
    const clipCache = fakeClipCache([])
    const generationQueue = fakeQueue()

    const result = await computeDrillReadiness(REPS, { clipCache, generationQueue, voice: VOICE })

    expect(result.ready).toEqual([])
    expect(result.canStart).toBe(false)
    expect(result.reason).toBe('none-ready')
  })

  it('treats "no voice pinned" as its own reason, distinct from "no clips yet" — and queues nothing', async () => {
    const clipCache = fakeClipCache(['p1'])
    const generationQueue = fakeQueue()

    const result = await computeDrillReadiness(REPS, { clipCache, generationQueue, voice: null })

    expect(result.ready).toEqual([])
    expect(result.skippedCount).toBe(3)
    expect(result.canStart).toBe(false)
    expect(result.reason).toBe('no-voice')
    expect(clipCache.readyUnitIds).not.toHaveBeenCalled()
    expect(generationQueue.enqueue).not.toHaveBeenCalled()
  })

  /**
   * T067 — the defect this task exists to end. Readiness used to be asked
   * about the pinned voice alone, so re-pinning made every already-generated
   * Phrase read as unready and queued the whole library for regeneration.
   */
  it('asks the cache about the pinned voice first, then every other voice a Clip could be in', async () => {
    const clipCache = fakeClipCache(['p1', 'p2', 'p3'])
    const generationQueue = fakeQueue()

    await computeDrillReadiness(REPS, { clipCache, generationQueue, voice: VOICE })

    expect(clipCache.readyUnitIds).toHaveBeenCalledWith(REPS, knownVoices(VOICE))
    expect(knownVoices(VOICE)[0]).toEqual(VOICE)
  })

  it('can start when every Rep is already ready, with nothing to queue', async () => {
    const clipCache = fakeClipCache(['p1', 'p2', 'p3'])
    const generationQueue = fakeQueue()

    const result = await computeDrillReadiness(REPS, { clipCache, generationQueue, voice: VOICE })

    expect(result.ready.map((rep) => rep.id)).toEqual(['p1', 'p2', 'p3'])
    expect(result.skippedCount).toBe(0)
    expect(result.canStart).toBe(true)
    expect(result.reason).toBeUndefined()
    expect(generationQueue.enqueue).not.toHaveBeenCalled()
  })

  /**
   * One sweep serves both kinds of Rep. This is the whole reason readiness
   * moved to Reps rather than gaining a second Passage-shaped path: a Drill
   * over a Mix of Decks and a Drill over a Passage's Lines ask the same
   * question, and `ready` stays exactly what `createDrillPlayer` is handed.
   */
  it('sweeps Phrase Reps and Line Reps in one pass, returning the ready ones and queueing the rest', async () => {
    const lines = [
      buildLineRep({ id: 'l1', text: 'Il faisait beau ce matin.' }),
      buildLineRep({ id: 'l2', text: 'Le train est parti sans nous.' }),
    ]
    const mixed = [...REPS, ...lines]
    const clipCache = fakeClipCache(['p1', 'l2'])
    const generationQueue = fakeQueue()

    const result = await computeDrillReadiness(mixed, { clipCache, generationQueue, voice: VOICE, isOnline: () => true })

    expect(result.ready.map((rep) => rep.id)).toEqual(['p1', 'l2'])
    expect(result.ready.map((rep) => rep.statements.length)).toEqual([2, 1])
    expect(result.skippedCount).toBe(3)
    expect(result.canStart).toBe(true)
    expect(generationQueue.enqueue.mock.calls.map(([unit]) => unit.id)).toEqual(['p2', 'p3', 'l1'])
  })

  /**
   * T036 — once Clips can be evicted, "this Rep has no audio" stops being
   * "it is still being made" and becomes "it was thrown away and cannot come
   * back until there is a network." The screen has to tell those apart, so
   * the readiness result carries whether there was a network at all.
   */
  it('reports whether it was online, so the screen never promises audio it cannot fetch', async () => {
    const generationQueue = fakeQueue()

    const online = await computeDrillReadiness(REPS, {
      clipCache: fakeClipCache(['p1']),
      generationQueue,
      voice: VOICE,
      isOnline: () => true,
    })
    const offline = await computeDrillReadiness(REPS, {
      clipCache: fakeClipCache(['p1']),
      generationQueue,
      voice: VOICE,
      isOnline: () => false,
    })

    expect(online.online).toBe(true)
    expect(offline.online).toBe(false)
  })

  /**
   * The defect this exists to close: a clip a running drill still needs can
   * be evicted mid-run by the very generation sweep this function kicks off.
   * `computeDrillReadiness` already knows exactly which clip hashes the run
   * will need — this asserts it hands that working set to the cache so it can
   * be spared for the run's duration.
   */
  describe('protecting the running drill\'s working set', () => {
    it('protects the pinned-voice clip hashes of every Statement of every ready Rep', async () => {
      const clipCache = fakeClipCache(['p1'])
      clipCache.has = vi.fn().mockResolvedValue(true)
      clipCache.protect = vi.fn()
      const generationQueue = fakeQueue()

      await computeDrillReadiness(REPS, { clipCache, generationQueue, voice: VOICE })

      const frHash = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Bonjour' })
      const enHash = await computeClipHash({ ...VOICE, lang: 'en-US', text: 'Hello' })
      expect(clipCache.protect).toHaveBeenCalledTimes(1)
      expect(clipCache.protect).toHaveBeenCalledWith(new Set([frHash, enHash]))
    })

    /** A Line's Rep has one Statement, so its working set is one hash — not a
     * pair with an `undefined` English half quietly dropped. */
    it('protects the single hash of a ready one-Statement Rep', async () => {
      const line = buildLineRep({ id: 'l1', text: 'Il faisait beau ce matin.' })
      const clipCache = fakeClipCache(['l1'])
      clipCache.has = vi.fn().mockResolvedValue(true)
      clipCache.protect = vi.fn()
      const generationQueue = fakeQueue()

      await computeDrillReadiness([line], { clipCache, generationQueue, voice: VOICE })

      const frHash = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Il faisait beau ce matin.' })
      expect(clipCache.protect).toHaveBeenCalledWith(new Set([frHash]))
    })

    it('protects nothing when no Rep is ready — releasing whatever a previous drill protected', async () => {
      const clipCache = fakeClipCache([])
      clipCache.protect = vi.fn()
      const generationQueue = fakeQueue()

      await computeDrillReadiness(REPS, { clipCache, generationQueue, voice: VOICE })

      expect(clipCache.protect).toHaveBeenCalledWith(new Set())
    })

    it('protects nothing when no voice is pinned', async () => {
      const clipCache = fakeClipCache(['p1'])
      clipCache.protect = vi.fn()
      const generationQueue = fakeQueue()

      await computeDrillReadiness(REPS, { clipCache, generationQueue, voice: null })

      expect(clipCache.protect).toHaveBeenCalledWith(new Set())
    })

    it('does not throw when the cache offers no protect() — an older fake, or a cache that opts out', async () => {
      const clipCache = fakeClipCache(['p1'])
      const generationQueue = fakeQueue()

      await expect(
        computeDrillReadiness(REPS, { clipCache, generationQueue, voice: VOICE }),
      ).resolves.toBeDefined()
    })
  })
})
