/**
 * **Regenerate** (docs/glossary.md): she taps *Redo audio* because a Clip is
 * broken — truncated, garbled — and the audio is made again.
 *
 * Before this, *Redo audio* called `enqueue`, which skips a Clip the device
 * already holds, and the server's `/api/tts` serves the Clip it stored first
 * to every device forever. A broken Clip was cached on both ends, so the
 * control regenerated nothing and nothing could ever replace it.
 *
 * The contract pinned here: for both sides, in the pinned voice — delete the
 * device's Clip, ask `/api/tts/regenerate` ONCE, and if the answer is "still
 * generating" (202) or the request may have reached the server (network),
 * poll the ordinary `/api/tts`: a second regenerate deletes and bills again.
 * Never during a Drill, never twice for one Clip at once, and never touching
 * the same Phrase's Clips in any other voice.
 */
import { describe, expect, it, vi } from 'vitest'
import { createGenerationQueue, type GenerationStatus } from './generation-queue'
import type { SynthClient, SynthError } from './server-synth-client'
import { computeClipHash, type Clip, type ClipCache } from '../storage/clip-cache'
import type { Voice } from '../../domain'

const VOICE: Voice = { provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-1' }
const OTHER_VOICE: Voice = { provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-2' }
const SYNTH_VOICE = { provider: VOICE.provider, modelId: VOICE.modelId, voiceId: VOICE.voiceId }
const PHRASE = { id: 'p1', french: 'Bonjour', english: 'Hello' }
const BROKEN_BYTES = 3
const NEW_BYTES = 16

function fresh(): { bytes: ArrayBuffer; durationMs: number } {
  return { bytes: new ArrayBuffer(NEW_BYTES), durationMs: 900 }
}
function queued(retryAfterMs = 5000): SynthError {
  return { kind: 'queued', retryAfterMs }
}
function rateLimited(retryAfterMs = 1000): SynthError {
  return { kind: 'rate-limited', retryAfterMs }
}
function network(): SynthError {
  return { kind: 'network', detail: 'Failed to fetch' }
}
function unreadable(): SynthError {
  return { kind: 'unreadable' }
}

/** In-memory ClipCache with its map exposed, so a test can read what the
 * device holds at the moment the server is asked. */
function createFakeClipCache(): ClipCache & { clips: Map<string, Clip> } {
  const clips = new Map<string, Clip>()
  return {
    clips,
    async get(hash) {
      return clips.get(hash)
    },
    async put(clip) {
      clips.set(clip.hash, clip)
    },
    async has(hash) {
      return clips.has(hash)
    },
    async delete(hash) {
      clips.delete(hash)
    },
    async readyPhraseIds() {
      return new Set()
    },
  }
}

/** How many times `mock` was asked for `text` — one side of a Phrase, when
 * the other side's calls are not the subject. */
function callsFor(mock: { mock: { calls: unknown[][] } }, text: string): number {
  return mock.mock.calls.filter((call) => call[0] === text).length
}

/** A synth call that answers `error` the first time it is asked for the
 * French side and new audio every other time — so the English side, running
 * alongside, cannot take the scripted answer instead. */
function onceForBonjour(error: SynthError): SynthClient['synthesize'] {
  let answered = false
  return async (text) => {
    if (text === 'Bonjour' && !answered) {
      answered = true
      return Promise.reject(error)
    }
    return fresh()
  }
}

async function hashOf(voice: Voice, lang: 'fr-FR' | 'en-US', text: string): Promise<string> {
  return computeClipHash({ ...voice, lang, text })
}

/** Both sides of PHRASE cached as broken audio in `voice`. */
async function seedBroken(clipCache: ClipCache, voice: Voice): Promise<{ fr: string; en: string }> {
  const fr = await hashOf(voice, 'fr-FR', PHRASE.french)
  const en = await hashOf(voice, 'en-US', PHRASE.english)
  for (const hash of [fr, en]) {
    await clipCache.put({ hash, bytes: new ArrayBuffer(BROKEN_BYTES), mime: 'audio/mpeg', durationMs: 1, createdAt: 1 })
  }
  return { fr, en }
}

/** Same macrotask drain generation-queue.test.ts uses for "did not happen":
 * a suspended queue's parked work is still outstanding, so `whenIdle()` does
 * not resolve and cannot serve the negative half. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function setup(overrides: {
  synthesize?: SynthClient['synthesize']
  regenerate?: SynthClient['regenerate']
  clipCache?: ReturnType<typeof createFakeClipCache>
  voice?: Voice | null
  maxConcurrent?: number
  onStatusChange?: (phraseId: string, status: GenerationStatus) => void
} = {}) {
  const synthesize = vi.fn<SynthClient['synthesize']>(overrides.synthesize ?? (async () => fresh()))
  const regenerate = vi.fn<SynthClient['regenerate']>(overrides.regenerate ?? (async () => fresh()))
  const clipCache = overrides.clipCache ?? createFakeClipCache()
  const queue = createGenerationQueue({
    synthClient: { synthesize, regenerate },
    clipCache,
    getVoice: async () => (overrides.voice === undefined ? VOICE : overrides.voice),
    maxConcurrent: overrides.maxConcurrent,
    onStatusChange: overrides.onStatusChange,
    sleep: async () => {},
  })
  return { queue, synthesize, regenerate, clipCache }
}

describe('GenerationQueue.regenerate', () => {
  it('replaces both broken Clips in the pinned voice: deletes each, asks the server to regenerate it, caches the new audio', async () => {
    const { queue, synthesize, regenerate, clipCache } = setup()
    const { fr, en } = await seedBroken(clipCache, VOICE)

    queue.regenerate(PHRASE)
    await queue.whenIdle()

    expect(regenerate).toHaveBeenCalledTimes(2)
    expect(regenerate).toHaveBeenCalledWith('Bonjour', 'fr-FR', SYNTH_VOICE)
    expect(regenerate).toHaveBeenCalledWith('Hello', 'en-US', SYNTH_VOICE)
    expect(synthesize).not.toHaveBeenCalled()
    expect(clipCache.clips.get(fr)?.bytes.byteLength).toBe(NEW_BYTES)
    expect(clipCache.clips.get(en)?.bytes.byteLength).toBe(NEW_BYTES)
    expect(queue.statusFor('p1')).toEqual<GenerationStatus>({ kind: 'ready' })
  })

  it('deletes the device Clip before it asks the server, so a refusal never leaves the broken one behind', async () => {
    const clipCache = createFakeClipCache()
    const { fr } = await seedBroken(clipCache, VOICE)
    const heldWhenAsked: boolean[] = []
    const { queue } = setup({
      clipCache,
      regenerate: async (text) => {
        if (text === 'Bonjour') heldWhenAsked.push(clipCache.clips.has(fr))
        return Promise.reject(unreadable())
      },
    })

    queue.regenerate(PHRASE)
    await queue.whenIdle()

    expect(heldWhenAsked).toEqual([false])
    expect(clipCache.clips.has(fr)).toBe(false)
  })

  it('polls a queued (202) Clip with the ordinary synthesize, never a second regenerate', async () => {
    const { queue, synthesize, regenerate } = setup({
      regenerate: async () => Promise.reject(queued(5000)),
      synthesize: onceForBonjour(queued(5000)),
    })

    queue.regenerate(PHRASE)
    await queue.whenIdle()

    expect(callsFor(regenerate, 'Bonjour')).toBe(1)
    expect(callsFor(synthesize, 'Bonjour')).toBe(2)
    expect(synthesize).toHaveBeenCalledWith('Bonjour', 'fr-FR', SYNTH_VOICE)
    expect(queue.statusFor('p1')).toEqual<GenerationStatus>({ kind: 'ready' })
  })

  it('retries a network failure with synthesize — the regenerate may have reached the server, and a second one bills again', async () => {
    const { queue, synthesize, regenerate } = setup({ regenerate: async () => Promise.reject(network()) })

    queue.regenerate(PHRASE)
    await queue.whenIdle()

    expect(callsFor(regenerate, 'Bonjour')).toBe(1)
    expect(callsFor(synthesize, 'Bonjour')).toBe(1)
    expect(queue.statusFor('p1')).toEqual<GenerationStatus>({ kind: 'ready' })
  })

  // Deviation from "every later attempt is synthesize", on purpose: a 429 is
  // the server's rate limiter, which runs BEFORE the handler (server/app.js
  // `handleTts`), so a rate-limited regenerate deleted nothing and queued
  // nothing. Polling /api/tts after it would be served the stored broken Clip
  // and report it ready. A Deck's Redo audio is 2 requests per Phrase against
  // a 60/60s limiter, so this is the common case, not an edge.
  it('asks to regenerate again after a 429 — the limiter refused it before the server did anything', async () => {
    const { queue, synthesize, regenerate } = setup({
      regenerate: onceForBonjour(rateLimited(1000)),
    })

    queue.regenerate(PHRASE)
    await queue.whenIdle()

    expect(callsFor(regenerate, 'Bonjour')).toBe(2)
    expect(synthesize).not.toHaveBeenCalled()
    expect(queue.statusFor('p1')).toEqual<GenerationStatus>({ kind: 'ready' })
  })

  it('fails at once on unreadable (422, including the 24 h billing cap) — no retry of either kind', async () => {
    const { queue, synthesize, regenerate } = setup({ regenerate: async () => Promise.reject(unreadable()) })

    queue.regenerate(PHRASE)
    await queue.whenIdle()

    expect(regenerate).toHaveBeenCalledTimes(2)
    expect(synthesize).not.toHaveBeenCalled()
    expect(queue.statusFor('p1')).toEqual<GenerationStatus>({ kind: 'failed' })
  })

  it('leaves the same Phrase’s Clips in every other voice alone — only the pinned voice is replaced', async () => {
    const clipCache = createFakeClipCache()
    const other = await seedBroken(clipCache, OTHER_VOICE)
    const { queue } = setup({ clipCache })

    queue.regenerate(PHRASE)
    await queue.whenIdle()

    expect(clipCache.clips.get(other.fr)?.bytes.byteLength).toBe(BROKEN_BYTES)
    expect(clipCache.clips.get(other.en)?.bytes.byteLength).toBe(BROKEN_BYTES)
  })

  it('deletes nothing and asks nothing during a Drill, and does both once it ends', async () => {
    const clipCache = createFakeClipCache()
    const { fr, en } = await seedBroken(clipCache, VOICE)
    const { queue, regenerate } = setup({ clipCache })

    queue.suspend()
    queue.regenerate(PHRASE)
    await settle()
    expect(clipCache.clips.has(fr)).toBe(true)
    expect(clipCache.clips.has(en)).toBe(true)
    expect(regenerate).not.toHaveBeenCalled()

    queue.resume()
    await queue.whenIdle()
    expect(regenerate).toHaveBeenCalledTimes(2)
    expect(clipCache.clips.get(fr)?.bytes.byteLength).toBe(NEW_BYTES)
  })

  it('does not delete a Clip that was waiting for a slot when the Drill started — the gate is at the request, not only at the tap', async () => {
    const clipCache = createFakeClipCache()
    const waiting = { id: 'p2', french: 'Merci', english: 'Thanks' }
    const waitingFr = await hashOf(VOICE, 'fr-FR', waiting.french)
    await clipCache.put({ hash: waitingFr, bytes: new ArrayBuffer(BROKEN_BYTES), mime: 'audio/mpeg', durationMs: 1, createdAt: 1 })
    // PHRASE's two sides fill both slots and are held; `waiting` passes the
    // head-of-generateOne gate and queues for a slot behind them.
    const held: Array<() => void> = []
    let holding = true
    const { queue } = setup({
      clipCache,
      maxConcurrent: 2,
      regenerate: () => (holding ? new Promise((resolve) => held.push(() => resolve(fresh()))) : Promise.resolve(fresh())),
    })

    queue.regenerate(PHRASE)
    await settle()
    expect(held).toHaveLength(2)
    queue.regenerate(waiting)
    await settle()

    // The Drill starts, then the two held requests land: their slots pass to
    // `waiting`'s sides while the queue is suspended.
    queue.suspend()
    holding = false
    for (const release of held.splice(0)) release()
    await settle()

    expect(clipCache.clips.get(waitingFr)?.bytes.byteLength).toBe(BROKEN_BYTES)

    queue.resume()
    await queue.whenIdle()
    expect(clipCache.clips.get(waitingFr)?.bytes.byteLength).toBe(NEW_BYTES)
  })

  it('sends one regenerate per Clip when she taps twice before the first finishes', async () => {
    const pending: Array<() => void> = []
    const { queue, regenerate } = setup({
      regenerate: () => new Promise((resolve) => pending.push(() => resolve(fresh()))),
    })

    queue.regenerate(PHRASE)
    queue.regenerate(PHRASE)
    await settle()
    for (const resolve of pending) resolve()
    await queue.whenIdle()

    expect(regenerate).toHaveBeenCalledTimes(2) // French and English, once each
  })

  it('holds a concurrency slot like any generation — a Deck’s Redo audio never has more than maxConcurrent requests out', async () => {
    const pending: Array<() => void> = []
    const { queue, regenerate } = setup({
      maxConcurrent: 1,
      regenerate: () => new Promise((resolve) => pending.push(() => resolve(fresh()))),
    })

    queue.regenerate(PHRASE)
    await settle()
    expect(regenerate).toHaveBeenCalledTimes(1)

    pending.shift()?.()
    await settle()
    pending.shift()?.()
    await queue.whenIdle()
    expect(regenerate).toHaveBeenCalledTimes(2)
  })

  it('reports generating, then the combined outcome', async () => {
    const statuses: GenerationStatus[] = []
    const { queue } = setup({ onStatusChange: (_id, status) => statuses.push(status) })

    queue.regenerate(PHRASE)
    await queue.whenIdle()

    expect(statuses).toEqual<GenerationStatus[]>([{ kind: 'generating' }, { kind: 'ready' }])
  })

  it('does nothing — no delete, no request — when no voice is pinned', async () => {
    const clipCache = createFakeClipCache()
    const { fr } = await seedBroken(clipCache, VOICE)
    const { queue, regenerate, synthesize } = setup({ clipCache, voice: null })

    queue.regenerate(PHRASE)
    await queue.whenIdle()

    expect(clipCache.clips.has(fr)).toBe(true)
    expect(regenerate).not.toHaveBeenCalled()
    expect(synthesize).not.toHaveBeenCalled()
    expect(queue.statusFor('p1')).toBeUndefined()
  })

  it('fails without asking the server when the device will not delete its Clip — no charge for audio it cannot replace', async () => {
    const clipCache = createFakeClipCache()
    clipCache.delete = async () => {
      throw Object.assign(new Error('refused'), { name: 'UnknownError' })
    }
    const { queue, regenerate } = setup({ clipCache })

    queue.regenerate(PHRASE)
    await queue.whenIdle()

    expect(regenerate).not.toHaveBeenCalled()
    expect(queue.statusFor('p1')).toEqual<GenerationStatus>({ kind: 'failed' })
  })
})
