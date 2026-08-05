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
  /** Records each call in order, e.g. `['play', 'pause', 'revoke']`, so tests can assert ordering. */
  callLog: string[]
  /** Simulates the browser deciding the real, decoded length of the current source. */
  loadMetadata(durationSeconds: number): void
}

/**
 * A fake `<audio>` element — no real media pipeline in jsdom, per AGENTS.md.
 * Models the two real-element behaviours the adapter's bugs hid behind an
 * inert fake: reassigning `src` while a `play()` is still pending aborts
 * that pending promise (the resource-selection algorithm restarting, per the
 * HTML media spec), and `duration`/`loadedmetadata` exist and reset on a new
 * source until the fake is told otherwise via `loadMetadata()`.
 */
function fakeAudioElement(overrides: { play?: () => Promise<void>; pause?: () => void } = {}): FakeAudioElement {
  const listeners: Record<string, Array<() => void>> = {}
  let srcValue = ''
  let pendingPlayReject: ((error: Error) => void) | null = null
  let durationValue = NaN
  const callLog: string[] = []
  const el: FakeAudioElement = {
    get src() {
      return srcValue
    },
    set src(value: string) {
      if (pendingPlayReject) {
        const reject = pendingPlayReject
        pendingPlayReject = null
        const abort = new Error('The operation was aborted.')
        abort.name = 'AbortError'
        reject(abort)
      }
      srcValue = value
      durationValue = NaN // a fresh source has no decoded metadata yet
    },
    get duration() {
      return durationValue
    },
    playCalls: 0,
    pauseCalls: 0,
    listeners,
    callLog,
    play: () => {
      el.playCalls += 1
      callLog.push('play')
      if (overrides.play) return overrides.play()
      return new Promise<void>((resolve, reject) => {
        pendingPlayReject = reject
        queueMicrotask(() => {
          if (pendingPlayReject === reject) {
            pendingPlayReject = null
            resolve()
          }
        })
      })
    },
    pause: () => {
      el.pauseCalls += 1
      callLog.push('pause')
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
    loadMetadata(durationSeconds: number) {
      durationValue = durationSeconds
      el.emit('loadedmetadata')
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

    it('logs to diagnostics when a second AbortError is judged unlocked anyway, since that judgement could be wrong (T002)', async () => {
      // Same fixture as "does not surface AbortError..." above — play()
      // rejects with AbortError on both the first attempt and the retry.
      // The caller still sees success (unchanged, T001's whole point), but a
      // reader of the diagnostics report should be able to see this
      // judgement was made at all.
      const abort = new Error('The operation was aborted.')
      abort.name = 'AbortError'
      const element = fakeAudioElement({ play: vi.fn().mockRejectedValue(abort) })
      const onSilentFailure = vi.fn()
      const player = createClipPlayer({
        element,
        clipCache: fakeClipCache(),
        voices: [VOICE],
        onSilentFailure,
      })

      const ok = await player.unlock()

      expect(ok).toBe(true)
      expect(player.unlockStatus).toBe('unlocked')
      expect(onSilentFailure).toHaveBeenCalledTimes(1)
      expect(onSilentFailure.mock.calls[0]![0]).toEqual(expect.stringContaining('AbortError'))
    })

    it('settles within a bounded time even when play() never settles, judging the element unlocked so the Drill still starts (T006)', async () => {
      // Models exactly the regression T006 reports live: a media element
      // whose play() never resolves and never rejects. Before this fix
      // nothing here ever timed out, so `unlock()` never settled and the
      // Drill screen's "starting" flag (and the shared in-flight promise
      // below) stayed true forever.
      //
      // Timeout is judged UNLOCKED, not failed — overriding this file's own
      // earlier draft of this test. She is a non-technical user with no one
      // to ask; a Drill that proceeds (possibly silently) is recoverable by
      // her (Stop, try again), a Drill that flatly refuses to start is not.
      // `onSilentFailure` is what keeps the judgement from being invisible.
      const element = fakeAudioElement({ play: () => new Promise<void>(() => {}) })
      const onSilentFailure = vi.fn()
      const player = createClipPlayer({
        element,
        clipCache: fakeClipCache(),
        voices: [VOICE],
        unlockTimeoutMs: 15,
        onSilentFailure,
      })

      const ok = await player.unlock()

      expect(ok).toBe(true)
      expect(player.unlockStatus).toBe('unlocked')
      expect(player.lastUnlockFailure).toBeUndefined()
      expect(onSilentFailure).toHaveBeenCalledTimes(1)
      expect(onSilentFailure.mock.calls[0]![0]).toEqual(expect.stringContaining('timed out'))
    })

    it('starts a fresh attempt on the next call after a timeout — the dead in-flight promise must not be latched forever (T006)', async () => {
      // The half of the regression that makes the freeze permanent: T001's
      // shared in-flight promise, never cleared by a play() that never
      // settles, made every later tap resolve to the same dead promise.
      // Even though a timed-out unlock() already reports success (above), a
      // LATER Drill's own start-tap must still re-attempt for real — reusing
      // a stale in-flight promise forever would mean no later tap ever
      // actually calls play() again.
      let calls = 0
      const element = fakeAudioElement({
        play: () => {
          calls += 1
          return calls === 1 ? new Promise<void>(() => {}) : Promise.resolve()
        },
      })
      const player = createClipPlayer({
        element,
        clipCache: fakeClipCache(),
        voices: [VOICE],
        unlockTimeoutMs: 15,
      })

      const first = await player.unlock()
      expect(first).toBe(true) // timed out, judged unlocked

      const second = await player.unlock()

      expect(second).toBe(true) // this one is a real, fresh success
      expect(player.unlockStatus).toBe('unlocked')
      expect(calls).toBe(2) // play() was actually called again, not skipped
    })

    it('still unlocks normally when play() resolves well within the timeout', async () => {
      const element = fakeAudioElement()
      const player = createClipPlayer({
        element,
        clipCache: fakeClipCache(),
        voices: [VOICE],
        unlockTimeoutMs: 15,
      })

      const ok = await player.unlock()

      expect(ok).toBe(true)
      expect(player.unlockStatus).toBe('unlocked')
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

    it('logs a missing Clip to diagnostics without the phrase text — her data, not the log\'s (T002)', async () => {
      const element = fakeAudioElement()
      const cache = fakeClipCache({})
      const onSilentFailure = vi.fn()
      const player = createClipPlayer({ element, clipCache: cache, voices: [VOICE], onSilentFailure })

      await player.speak('Bonjour inconnu secret', 'fr-FR')

      expect(onSilentFailure).toHaveBeenCalledTimes(1)
      const message = onSilentFailure.mock.calls[0]![0] as string
      expect(message).not.toContain('Bonjour inconnu secret')
      expect(message.toLowerCase()).toContain('missing')
    })

    it('resolves rather than hanging when the element rejects play() (e.g. blocked autoplay)', async () => {
      const hash = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Bonjour' })
      const cache = fakeClipCache({ [hash]: fakeClip({ hash, durationMs: 1000 }) })
      const element = fakeAudioElement({ play: vi.fn().mockRejectedValue(new Error('blocked')) })
      const player = createClipPlayer({ element, clipCache: cache, voices: [VOICE] })

      await player.speak('Bonjour', 'fr-FR')

      expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    })

    it('logs a play failure after unlock to diagnostics, but still resolves quietly (T002)', async () => {
      const hash = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Bonjour' })
      const cache = fakeClipCache({ [hash]: fakeClip({ hash, durationMs: 1000 }) })
      const refusal = new Error('blocked')
      refusal.name = 'NotAllowedError'
      const element = fakeAudioElement({ play: vi.fn().mockRejectedValue(refusal) })
      const onSilentFailure = vi.fn()
      const player = createClipPlayer({ element, clipCache: cache, voices: [VOICE], onSilentFailure })

      await expect(player.speak('Bonjour', 'fr-FR')).resolves.toBeUndefined()

      expect(onSilentFailure).toHaveBeenCalledTimes(1)
      expect(onSilentFailure.mock.calls[0]![0]).toEqual(expect.stringContaining('NotAllowedError'))
    })

    it('does not flood diagnostics with the same repeating play failure across a whole Drill (T002)', async () => {
      const hashA = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Un' })
      const hashB = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Deux' })
      const cache = fakeClipCache({
        [hashA]: fakeClip({ hash: hashA, durationMs: 10 }),
        [hashB]: fakeClip({ hash: hashB, durationMs: 10 }),
      })
      const refusal = new Error('blocked')
      refusal.name = 'NotAllowedError'
      const element = fakeAudioElement({ play: vi.fn().mockRejectedValue(refusal) })
      const onSilentFailure = vi.fn()
      const player = createClipPlayer({ element, clipCache: cache, voices: [VOICE], onSilentFailure })

      await player.speak('Un', 'fr-FR')
      await player.speak('Deux', 'fr-FR')

      expect(onSilentFailure).toHaveBeenCalledTimes(1)
    })

    it('logs a play failure again after a successful play in between (recovery resets the throttle) (T002)', async () => {
      const hashA = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Un' })
      const hashB = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Deux' })
      const cache = fakeClipCache({
        [hashA]: fakeClip({ hash: hashA, durationMs: 10 }),
        [hashB]: fakeClip({ hash: hashB, durationMs: 10 }),
      })
      const refusal = new Error('blocked')
      refusal.name = 'NotAllowedError'
      let shouldFail = true
      const element = fakeAudioElement({
        play: vi.fn().mockImplementation(() => (shouldFail ? Promise.reject(refusal) : Promise.resolve())),
      })
      const onSilentFailure = vi.fn()
      const player = createClipPlayer({ element, clipCache: cache, voices: [VOICE], onSilentFailure })

      await player.speak('Un', 'fr-FR')
      expect(onSilentFailure).toHaveBeenCalledTimes(1)

      shouldFail = false
      const second = player.speak('Deux', 'fr-FR')
      await waitUntil(() => element.playCalls > 1)
      element.emit('ended')
      await second

      shouldFail = true
      await player.speak('Un', 'fr-FR')

      expect(onSilentFailure).toHaveBeenCalledTimes(2)
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

      // Two pause() calls, and both are load-bearing: cancel()'s own
      // (safe-when-idle, covers the case nothing was playing) plus finish()'s
      // (the actual stop-playback fix — see the pacing/lifecycle describe
      // block below). Pausing an already-paused element is harmless.
      expect(element.pauseCalls).toBe(2)
      expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    })
  })

  describe('pacing and lifecycle defects (the reported "plays everything at random times" bug)', () => {
    it('pauses the element when the duration+slack backstop wins the race against ended — a live bug: nothing today stops playback there', async () => {
      const hash = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Bonjour' })
      const cache = fakeClipCache({ [hash]: fakeClip({ hash, durationMs: 10 }) })
      const element = fakeAudioElement()
      const player = createClipPlayer({ element, clipCache: cache, voices: [VOICE], slackMs: 10 })

      const done = player.speak('Bonjour', 'fr-FR')
      await waitUntil(() => element.playCalls > 0)
      // ended never fires; only the backstop timeout resolves this.
      await done

      expect(element.pauseCalls).toBeGreaterThanOrEqual(1)
    })

    it('pauses the element before revoking its blob URL, not after — the source must not be yanked while still in use', async () => {
      const hash = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Bonjour' })
      const cache = fakeClipCache({ [hash]: fakeClip({ hash, durationMs: 10 }) })
      const order: string[] = []
      const element = fakeAudioElement({ pause: () => order.push('pause') })
      revokeObjectURL.mockImplementation(() => order.push('revoke'))
      const player = createClipPlayer({ element, clipCache: cache, voices: [VOICE], slackMs: 10 })

      const done = player.speak('Bonjour', 'fr-FR')
      await waitUntil(() => element.playCalls > 0)
      await done

      expect(order.indexOf('pause')).toBeGreaterThanOrEqual(0)
      expect(order.indexOf('revoke')).toBeGreaterThan(order.indexOf('pause'))
    })

    it('paces itself off the real decoded duration (loadedmetadata), not the fabricated bytes-based estimate', async () => {
      // The server's durationMs is bytes÷16 assuming 128kbps, never checked
      // against a real ElevenLabs call. Here it is deliberately wrong — far
      // too short — the way a misjudged bitrate would make it wrong on a
      // real clip. The real, decoded duration (via loadedmetadata) must win.
      const hash = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Bonjour' })
      const cache = fakeClipCache({ [hash]: fakeClip({ hash, durationMs: 5 }) }) // bogus: 5ms
      const element = fakeAudioElement()
      const player = createClipPlayer({ element, clipCache: cache, voices: [VOICE], slackMs: 20 })

      const done = player.speak('Bonjour', 'fr-FR')
      await waitUntil(() => element.playCalls > 0)
      element.loadMetadata(0.08) // real duration: 80ms — the true length ElevenLabs actually produced

      let settled = false
      void done.then(() => (settled = true))
      // Past the bogus estimate's own backstop (5 + 20 = 25ms) — if the
      // adapter were still trusting durationMs, this would already be
      // resolved and the clip would have been cut off mid-word.
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(settled).toBe(false)

      // ended never fires — only the real-duration backstop (80 + 20 = 100ms
      // from when loadedmetadata fired) resolves this.
      await done
      expect(settled).toBe(true)
    })

    it('pads the fallback backstop well beyond the raw estimate when loadedmetadata never fires — a tight backstop is the bug being fixed', async () => {
      const hash = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Bonjour' })
      const cache = fakeClipCache({ [hash]: fakeClip({ hash, durationMs: 50 }) })
      const element = fakeAudioElement()
      const player = createClipPlayer({ element, clipCache: cache, voices: [VOICE], slackMs: 20 })

      const done = player.speak('Bonjour', 'fr-FR')
      await waitUntil(() => element.playCalls > 0)
      // loadedmetadata never fires — a broken/unusual element.

      let settled = false
      void done.then(() => (settled = true))
      // Past the naive durationMs+slack (50+20=70ms) that today's code uses
      // as the ONLY backstop — proving the fallback is padded rather than
      // firing exactly there.
      await new Promise((resolve) => setTimeout(resolve, 90))
      expect(settled).toBe(false)

      await done
      expect(settled).toBe(true)
    })

    it('cancels an attempt still in the async cache lookup — cancel() must not be a silent no-op before the element is ever touched', async () => {
      const hash = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Bonjour' })
      const cache = fakeClipCache({ [hash]: fakeClip({ hash, durationMs: 1000 }) })
      const element = fakeAudioElement()
      const player = createClipPlayer({ element, clipCache: cache, voices: [VOICE] })

      const done = player.speak('Bonjour', 'fr-FR')
      // Cancel synchronously, before the cache lookups (real IndexedDB round
      // trips in production) have had any chance to resolve — the window
      // `stopCurrent = finish` used to leave uncovered.
      player.cancel()
      await done

      expect(element.playCalls).toBe(0)
      expect(createObjectURL).not.toHaveBeenCalled()
    })

    it('leaves no listener, timer, or URL from a superseded speak() alive when a new one starts without an explicit cancel()', async () => {
      const hashFirst = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Un' })
      const hashSecond = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'Deux' })
      const cache = fakeClipCache({
        [hashFirst]: fakeClip({ hash: hashFirst, durationMs: 60_000 }),
        [hashSecond]: fakeClip({ hash: hashSecond, durationMs: 60_000 }),
      })
      const element = fakeAudioElement()
      const player = createClipPlayer({ element, clipCache: cache, voices: [VOICE] })

      const first = player.speak('Un', 'fr-FR')
      await waitUntil(() => element.playCalls > 0)

      // A second speak() starts without cancel() ever being called — e.g.
      // the drill advancing a step on its own. The first attempt's listener
      // must not survive to catch a later, unrelated `ended`.
      const second = player.speak('Deux', 'fr-FR')
      await first // superseding must resolve the superseded speak(), not hang it
      await waitUntil(() => element.playCalls > 1)

      element.emit('ended') // must resolve ONLY the second attempt
      await second

      expect(revokeObjectURL).toHaveBeenCalledTimes(2)
      expect(element.playCalls).toBe(2)
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
