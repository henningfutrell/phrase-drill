import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClipPlayer, UNLOCK_SOURCE_FOR_TEST } from './clip-player'
import type { AudioElementLike } from './clip-player'
import type { Clip, ClipCache } from '../storage/clip-cache'
import { computeClipHash } from '../storage/clip-cache'
import type { Voice } from '../../domain'

const VOICE: Voice = { provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-1' }

function bytesOf(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer
}

function fakeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    hash: 'unused',
    bytes: bytesOf('audio'),
    mime: 'audio/mpeg',
    durationMs: 1000,
    createdAt: 1,
    ...overrides,
  }
}

type FakeAudioElement = AudioElementLike & {
  listeners: Record<string, Array<() => void>>
  emit(type: string): void
  playCalls: number
  pauseCalls: number
}

/** A fake `<audio>` element — no real media pipeline in jsdom, per AGENTS.md. */
function fakeAudioElement(overrides: { play?: () => Promise<void>; pause?: () => void } = {}): FakeAudioElement {
  const listeners: Record<string, Array<() => void>> = {}
  const el: FakeAudioElement = {
    src: '',
    playCalls: 0,
    pauseCalls: 0,
    listeners,
    play: () => {
      el.playCalls += 1
      return overrides.play ? overrides.play() : Promise.resolve()
    },
    pause: () => {
      el.pauseCalls += 1
      overrides.pause?.()
    },
    addEventListener(type: string, listener: () => void) {
      listeners[type] ??= []
      listeners[type]!.push(listener)
    },
    removeEventListener(type: string, listener: () => void) {
      listeners[type] = (listeners[type] ?? []).filter((l) => l !== listener)
    },
    emit(type: string) {
      for (const l of [...(listeners[type] ?? [])]) l()
    },
  }
  return el
}

/**
 * Polls with a real timer until `condition` holds. Needed because
 * `speak()` crosses a genuine async boundary (`crypto.subtle.digest` for
 * the clip hash runs off-microtask-queue, verified empirically — a fixed
 * number of `await Promise.resolve()` hops is not enough to reach the
 * point where the element's listener is attached), so tests that need to
 * observe or interact with `speak()` mid-flight cannot rely on microtask
 * counting.
 */
async function waitUntil(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: condition never became true')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

function fakeClipCache(clips: Record<string, Clip> = {}): ClipCache & { puts: Clip[] } {
  const store = new Map(Object.entries(clips))
  return {
    puts: [],
    async get(hash: string) {
      return store.get(hash)
    },
    async put(clip: Clip) {
      store.set(clip.hash, clip)
    },
    async has(hash: string) {
      return store.has(hash)
    },
    async readyPhraseIds() {
      return new Set()
    },
  } as ClipCache & { puts: Clip[] }
}

describe('createClipPlayer', () => {
  let createObjectURL: ReturnType<typeof vi.fn>
  let revokeObjectURL: ReturnType<typeof vi.fn>

  beforeEach(() => {
    createObjectURL = vi.fn().mockReturnValue('blob:fake-url')
    revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('unlock', () => {
    it('plays then immediately pauses the shared element inside the gesture, and reports success', async () => {
      const element = fakeAudioElement()
      const player = createClipPlayer({ element, clipCache: fakeClipCache(), voices: [VOICE] })

      expect(player.unlockStatus).toBe('pending')
      const ok = await player.unlock()

      expect(ok).toBe(true)
      expect(player.unlockStatus).toBe('unlocked')
      expect(element.playCalls).toBe(1)
      expect(element.pauseCalls).toBe(1)
    })

    it('reports failure, observably, when the gesture-unlock play() rejects', async () => {
      const element = fakeAudioElement({ play: vi.fn().mockRejectedValue(new Error('NotAllowedError')) })
      const player = createClipPlayer({ element, clipCache: fakeClipCache(), voices: [VOICE] })

      const ok = await player.unlock()

      expect(ok).toBe(false)
      expect(player.unlockStatus).toBe('failed')
    })

    it('shares one in-flight attempt across concurrent unlock() calls, so neither reports failure (T001)', async () => {
      // Models the real element's spec behaviour: reassigning `src` (or
      // calling `pause()`) while a `play()` is still pending rejects that
      // pending promise with AbortError. A second Start-Drill tap arriving
      // before the first `unlock()` resolves used to re-enter this method,
      // which reassigned `element.src` and called `play()` again — aborting
      // the first attempt and painting an "Audio didn't start" error even
      // though the second attempt succeeded. Two concurrent callers must
      // share one attempt instead of racing the element.
      let pendingReject: ((err: Error) => void) | null = null
      let srcValue = ''
      let playCalls = 0
      const element: AudioElementLike = {
        get src() {
          return srcValue
        },
        set src(value: string) {
          if (pendingReject) {
            const reject = pendingReject
            pendingReject = null
            const abort = new Error('The operation was aborted.')
            abort.name = 'AbortError'
            reject(abort)
          }
          srcValue = value
        },
        play(): Promise<void> {
          playCalls += 1
          return new Promise<void>((resolve, reject) => {
            pendingReject = reject
            queueMicrotask(() => {
              if (pendingReject === reject) {
                pendingReject = null
                resolve()
              }
            })
          })
        },
        pause() {},
        addEventListener() {},
        removeEventListener() {},
      }
      const player = createClipPlayer({ element, clipCache: fakeClipCache(), voices: [VOICE] })

      const [first, second] = await Promise.all([player.unlock(), player.unlock()])

      expect(first).toBe(true)
      expect(second).toBe(true)
      expect(player.unlockStatus).toBe('unlocked')
      expect(player.lastUnlockFailure).toBeUndefined()
      expect(playCalls).toBe(1)
    })

    it('does not surface AbortError as an unlock failure — interrupted is not refused (T001)', async () => {
      const abort = new Error('The operation was aborted.')
      abort.name = 'AbortError'
      const element = fakeAudioElement({ play: vi.fn().mockRejectedValue(abort) })
      const player = createClipPlayer({ element, clipCache: fakeClipCache(), voices: [VOICE] })

      const ok = await player.unlock()

      expect(ok).toBe(true)
      expect(player.unlockStatus).toBe('unlocked')
      expect(player.lastUnlockFailure).toBeUndefined()
    })

    it('still reports NotAllowedError (iOS autoplay refusal) as a failure, distinctly (T001)', async () => {
      const refusal = new Error('blocked')
      refusal.name = 'NotAllowedError'
      const element = fakeAudioElement({ play: vi.fn().mockRejectedValue(refusal) })
      const player = createClipPlayer({ element, clipCache: fakeClipCache(), voices: [VOICE] })

      const ok = await player.unlock()

      expect(ok).toBe(false)
      expect(player.unlockStatus).toBe('failed')
      expect(player.lastUnlockFailure).toEqual({ name: 'NotAllowedError', message: 'blocked' })
    })

    it('still reports NotSupportedError (undecodable source) as a failure, distinctly (T001)', async () => {
      const badSource = new Error('bad source')
      badSource.name = 'NotSupportedError'
      const element = fakeAudioElement({ play: vi.fn().mockRejectedValue(badSource) })
      const player = createClipPlayer({ element, clipCache: fakeClipCache(), voices: [VOICE] })

      const ok = await player.unlock()

      expect(ok).toBe(false)
      expect(player.unlockStatus).toBe('failed')
      expect(player.lastUnlockFailure).toEqual({ name: 'NotSupportedError', message: 'bad source' })
    })
  })

  describe('speak', () => {
    it('looks up the Clip by hash of voice+lang+text, plays it through the one injected element', async () => {
      const hash = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Bonjour' })
      const clip = fakeClip({ hash, durationMs: 500 })
      const cache = fakeClipCache({ [hash]: clip })
      const element = fakeAudioElement()
      const player = createClipPlayer({ element, clipCache: cache, voices: [VOICE] })

      const done = player.speak('Bonjour', 'fr-FR')
      await waitUntil(() => element.playCalls > 0)

      expect(createObjectURL).toHaveBeenCalledTimes(1)
      expect(element.src).toBe('blob:fake-url')
      expect(element.playCalls).toBe(1)

      element.emit('ended')
      await done
    })

    it('resolves on the ended event and revokes the blob URL exactly once', async () => {
      const hash = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Bonjour' })
      const cache = fakeClipCache({ [hash]: fakeClip({ hash, durationMs: 1000 }) })
      const element = fakeAudioElement()
      const player = createClipPlayer({ element, clipCache: cache, voices: [VOICE] })

      const done = player.speak('Bonjour', 'fr-FR')
      await waitUntil(() => element.playCalls > 0)
      element.emit('ended')
      await done

      expect(revokeObjectURL).toHaveBeenCalledTimes(1)
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake-url')
    })

    it('resolves via the duration+slack timeout when ended never fires — one dropped event does not freeze the Drill', async () => {
      const hash = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Bonjour' })
      const cache = fakeClipCache({ [hash]: fakeClip({ hash, durationMs: 20 }) })
      const element = fakeAudioElement()
      const player = createClipPlayer({ element, clipCache: cache, voices: [VOICE], slackMs: 20 })

      const done = player.speak('Bonjour', 'fr-FR')
      await waitUntil(() => element.playCalls > 0)

      let settled = false
      void done.then(() => (settled = true))
      // ended never fires; well before duration+slack (40ms) elapses, still pending.
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(settled).toBe(false)

      // ended still never fires — the timeout alone must resolve it.
      await done

      expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    })

    it('does not double-resolve when ended fires just before the timeout', async () => {
      const hash = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Bonjour' })
      const cache = fakeClipCache({ [hash]: fakeClip({ hash, durationMs: 20 }) })
      const element = fakeAudioElement()
      const player = createClipPlayer({ element, clipCache: cache, voices: [VOICE], slackMs: 20 })

      const done = player.speak('Bonjour', 'fr-FR')
      await waitUntil(() => element.playCalls > 0)
      element.emit('ended')
      await done
      // Give the (should-be-cleared) timeout time it would need to fire if it wasn't.
      await new Promise((resolve) => setTimeout(resolve, 60))

      expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    })

    it('resolves without playing when the Clip is missing, and reports the miss instead of crashing', async () => {
      const element = fakeAudioElement()
      const cache = fakeClipCache({})
      const onMissingClip = vi.fn()
      const player = createClipPlayer({ element, clipCache: cache, voices: [VOICE], onMissingClip })

      await player.speak('Bonjour inconnu', 'fr-FR')

      expect(element.playCalls).toBe(0)
      expect(createObjectURL).not.toHaveBeenCalled()
      expect(onMissingClip).toHaveBeenCalledWith({ text: 'Bonjour inconnu', lang: 'fr-FR' })
    })

    it('resolves rather than hanging when the element rejects play() (e.g. blocked autoplay)', async () => {
      const hash = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Bonjour' })
      const cache = fakeClipCache({ [hash]: fakeClip({ hash, durationMs: 1000 }) })
      const element = fakeAudioElement({ play: vi.fn().mockRejectedValue(new Error('blocked')) })
      const player = createClipPlayer({ element, clipCache: cache, voices: [VOICE] })

      await player.speak('Bonjour', 'fr-FR')

      expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    })

    it('reuses the single injected element across successive clips, swapping src rather than creating new elements', async () => {
      const hashBonjour = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Bonjour' })
      const hashMerci = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Merci' })
      const cache = fakeClipCache({
        [hashBonjour]: fakeClip({ hash: hashBonjour, durationMs: 100 }),
        [hashMerci]: fakeClip({ hash: hashMerci, durationMs: 100 }),
      })
      const element = fakeAudioElement()
      const player = createClipPlayer({ element, clipCache: cache, voices: [VOICE] })

      const first = player.speak('Bonjour', 'fr-FR')
      await waitUntil(() => element.playCalls > 0)
      element.emit('ended')
      await first

      const second = player.speak('Merci', 'fr-FR')
      await waitUntil(() => element.playCalls > 1)
      element.emit('ended')
      await second

      expect(element.playCalls).toBe(2)
      expect(createObjectURL).toHaveBeenCalledTimes(2)
    })
  })

  describe('cancel', () => {
    it('is safe when idle', () => {
      const element = fakeAudioElement()
      const player = createClipPlayer({ element, clipCache: fakeClipCache(), voices: [VOICE] })

      expect(() => player.cancel()).not.toThrow()
      expect(element.pauseCalls).toBe(1)
    })

    it('pauses the element and settles the in-flight speak() immediately', async () => {
      const hash = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Bonjour' })
      const cache = fakeClipCache({ [hash]: fakeClip({ hash, durationMs: 60_000 }) })
      const element = fakeAudioElement()
      const player = createClipPlayer({ element, clipCache: cache, voices: [VOICE] })

      const done = player.speak('Bonjour', 'fr-FR')
      await waitUntil(() => element.playCalls > 0)

      player.cancel()
      await done

      expect(element.pauseCalls).toBe(1)
      expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    })
  })
})

describe('createClipPlayer — the unlock source itself', () => {
  it('is a structurally valid WAV: RIFF magic, WAVE at byte 8, a fmt chunk and a data chunk', () => {
    // Regression. The original constant carried one stray zero byte after the
    // RIFF size field, which pushed "WAVE" to offset 9. Every browser rejected
    // it, `element.play()` rejected, `unlock()` returned false, and the drill
    // screen reported "Couldn't start audio on this phone" on every device —
    // a decode failure wearing the costume of an iOS autoplay-policy failure.
    // The fakes in the tests above resolve `play()` unconditionally, so no
    // test could see it. This one reads the bytes.
    const base64 = UNLOCK_SOURCE_FOR_TEST.replace(/^data:audio\/wav;base64,/, '')
    expect(base64).not.toBe(UNLOCK_SOURCE_FOR_TEST)

    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
    const ascii = (start: number, end: number) =>
      String.fromCharCode(...bytes.subarray(start, end))
    const uint32 = (offset: number) =>
      new DataView(bytes.buffer).getUint32(offset, true)

    expect(ascii(0, 4)).toBe('RIFF')
    expect(ascii(8, 12)).toBe('WAVE')
    expect(ascii(12, 16)).toBe('fmt ')
    expect(uint32(4)).toBe(bytes.length - 8)
    expect(ascii(36, 40)).toBe('data')
    expect(uint32(40)).toBe(bytes.length - 44)
  })
})

/**
 * T067 — a Phrase that has audio must never go silent because a preference
 * changed. Playback prefers the pinned voice where a Clip exists in it, and
 * otherwise plays the first voice in the offered order that has one.
 */
describe('createClipPlayer — playing what exists (T067)', () => {
  let createObjectURL: ReturnType<typeof vi.fn>

  beforeEach(() => {
    createObjectURL = vi.fn().mockReturnValue('blob:fake-url')
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const OTHER: Voice = { ...VOICE, voiceId: 'voice-2' }

  it('plays the Clip in the pinned voice when there is one', async () => {
    const pinnedHash = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Bonjour' })
    const otherHash = await computeClipHash({ ...OTHER, lang: 'fr-FR', text: 'Bonjour' })
    const cache = fakeClipCache({
      [pinnedHash]: fakeClip({ hash: pinnedHash, durationMs: 10 }),
      [otherHash]: fakeClip({ hash: otherHash, durationMs: 20 }),
    })
    const element = fakeAudioElement()
    const player = createClipPlayer({ element, clipCache: cache, voices: [VOICE, OTHER] })

    const done = player.speak('Bonjour', 'fr-FR')
    await waitUntil(() => element.playCalls > 0)
    element.emit('ended')
    await done

    expect(await cache.get(pinnedHash)).toBeDefined()
    expect(element.playCalls).toBe(1)
  })

  it('plays a Clip in another voice when the pinned voice has none — silence is never the answer', async () => {
    const otherHash = await computeClipHash({ ...OTHER, lang: 'fr-FR', text: 'Bonjour' })
    const cache = fakeClipCache({ [otherHash]: fakeClip({ hash: otherHash, durationMs: 10 }) })
    const element = fakeAudioElement()
    const onMissingClip = vi.fn()
    const player = createClipPlayer({ element, clipCache: cache, voices: [VOICE, OTHER], onMissingClip })

    const done = player.speak('Bonjour', 'fr-FR')
    await waitUntil(() => element.playCalls > 0)
    element.emit('ended')
    await done

    expect(element.playCalls).toBe(1)
    expect(onMissingClip).not.toHaveBeenCalled()
  })

  it('reports the Clip missing only when no offered voice has one', async () => {
    const element = fakeAudioElement()
    const onMissingClip = vi.fn()
    const player = createClipPlayer({ element, clipCache: fakeClipCache(), voices: [VOICE, OTHER], onMissingClip })

    await player.speak('Bonjour', 'fr-FR')

    expect(onMissingClip).toHaveBeenCalledWith({ text: 'Bonjour', lang: 'fr-FR' })
    expect(element.playCalls).toBe(0)
  })

  it('takes the offered order, not the cache order, when several voices have the Clip', async () => {
    const firstHash = await computeClipHash({ ...OTHER, lang: 'fr-FR', text: 'Bonjour' })
    const secondHash = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Bonjour' })
    const cache = fakeClipCache({
      [secondHash]: fakeClip({ hash: secondHash, durationMs: 10 }),
      [firstHash]: fakeClip({ hash: firstHash, durationMs: 20 }),
    })
    const gets: string[] = []
    const spyCache = { ...cache, get: async (hash: string) => { gets.push(hash); return cache.get(hash) } }
    const element = fakeAudioElement()
    const player = createClipPlayer({ element, clipCache: spyCache, voices: [OTHER, VOICE] })

    const done = player.speak('Bonjour', 'fr-FR')
    await waitUntil(() => element.playCalls > 0)
    element.emit('ended')
    await done

    expect(gets).toEqual([firstHash])
  })
})
