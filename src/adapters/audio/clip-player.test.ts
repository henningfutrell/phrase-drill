import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClipPlayer } from './clip-player'
import type { AudioElementLike } from './clip-player'
import type { Clip, ClipCache } from '../storage/clip-cache'
import { computeClipHash } from '../storage/clip-cache'
import type { Voice } from '../storage/settings-store'

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
      const player = createClipPlayer({ element, clipCache: fakeClipCache(), voice: VOICE })

      expect(player.unlockStatus).toBe('pending')
      const ok = await player.unlock()

      expect(ok).toBe(true)
      expect(player.unlockStatus).toBe('unlocked')
      expect(element.playCalls).toBe(1)
      expect(element.pauseCalls).toBe(1)
    })

    it('reports failure, observably, when the gesture-unlock play() rejects', async () => {
      const element = fakeAudioElement({ play: vi.fn().mockRejectedValue(new Error('NotAllowedError')) })
      const player = createClipPlayer({ element, clipCache: fakeClipCache(), voice: VOICE })

      const ok = await player.unlock()

      expect(ok).toBe(false)
      expect(player.unlockStatus).toBe('failed')
    })
  })

  describe('speak', () => {
    it('looks up the Clip by hash of voice+lang+text, plays it through the one injected element', async () => {
      const hash = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Bonjour' })
      const clip = fakeClip({ hash, durationMs: 500 })
      const cache = fakeClipCache({ [hash]: clip })
      const element = fakeAudioElement()
      const player = createClipPlayer({ element, clipCache: cache, voice: VOICE })

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
      const player = createClipPlayer({ element, clipCache: cache, voice: VOICE })

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
      const player = createClipPlayer({ element, clipCache: cache, voice: VOICE, slackMs: 20 })

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
      const player = createClipPlayer({ element, clipCache: cache, voice: VOICE, slackMs: 20 })

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
      const player = createClipPlayer({ element, clipCache: cache, voice: VOICE, onMissingClip })

      await player.speak('Bonjour inconnu', 'fr-FR')

      expect(element.playCalls).toBe(0)
      expect(createObjectURL).not.toHaveBeenCalled()
      expect(onMissingClip).toHaveBeenCalledWith({ text: 'Bonjour inconnu', lang: 'fr-FR' })
    })

    it('resolves rather than hanging when the element rejects play() (e.g. blocked autoplay)', async () => {
      const hash = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Bonjour' })
      const cache = fakeClipCache({ [hash]: fakeClip({ hash, durationMs: 1000 }) })
      const element = fakeAudioElement({ play: vi.fn().mockRejectedValue(new Error('blocked')) })
      const player = createClipPlayer({ element, clipCache: cache, voice: VOICE })

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
      const player = createClipPlayer({ element, clipCache: cache, voice: VOICE })

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
      const player = createClipPlayer({ element, clipCache: fakeClipCache(), voice: VOICE })

      expect(() => player.cancel()).not.toThrow()
      expect(element.pauseCalls).toBe(1)
    })

    it('pauses the element and settles the in-flight speak() immediately', async () => {
      const hash = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Bonjour' })
      const cache = fakeClipCache({ [hash]: fakeClip({ hash, durationMs: 60_000 }) })
      const element = fakeAudioElement()
      const player = createClipPlayer({ element, clipCache: cache, voice: VOICE })

      const done = player.speak('Bonjour', 'fr-FR')
      await waitUntil(() => element.playCalls > 0)

      player.cancel()
      await done

      expect(element.pauseCalls).toBe(1)
      expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    })
  })
})
