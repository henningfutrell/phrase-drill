import type { Language, Voice } from '../../domain'
import type { SpeechPort } from '../../domain/ports'
import { findCachedClipHash, type ClipCache } from '../storage/clip-cache'

/**
 * The slice of `HTMLAudioElement` this adapter needs — injectable so it is
 * testable without a browser that actually decodes/plays audio (jsdom has no
 * real media pipeline; AGENTS.md "Testing"). A real `<audio>` element
 * satisfies this structurally.
 */
export interface AudioElementLike {
  src: string
  play(): Promise<void>
  pause(): void
  addEventListener(type: 'ended', listener: () => void, options?: { once?: boolean }): void
  removeEventListener(type: 'ended', listener: () => void): void
}

/**
 * A near-silent, effectively zero-length WAV as a data URI — played and
 * immediately paused inside the Drill-start tap to unlock the shared
 * element for iOS Safari (T019 §4 obligation 2: "New video Policies for
 * iOS", https://webkit.org/blog/6784/new-video-policies-for-ios/). 8 silent
 * 8-bit PCM samples, 8kHz mono — 52 bytes.
 *
 * Generated, never hand-edited. The previous constant carried one stray zero
 * byte after the RIFF size field, putting "WAVE" at offset 9 instead of 8;
 * every browser refused to decode it, so `play()` rejected, `unlock()`
 * returned false, and the Drill screen reported "Couldn't start audio on this
 * phone" on every device. A decode failure is indistinguishable from an iOS
 * autoplay refusal at this call site — hence the byte-level test in
 * `clip-player.test.ts` rather than trust.
 */
const SILENT_UNLOCK_SOURCE =
  'data:audio/wav;base64,UklGRiwAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQgAAACAgICAgICAgA=='

/** The unlock source, exposed so a test can read its bytes. Not for callers. */
export const UNLOCK_SOURCE_FOR_TEST = SILENT_UNLOCK_SOURCE

/** Added to `clip.durationMs` before the `ended`-race times out (T019 §4 ob.3). */
const DEFAULT_SLACK_MS = 750

export type UnlockStatus = 'pending' | 'unlocked' | 'failed'

/** What actually went wrong in `unlock()`, for the screen that has to explain it. */
export interface UnlockFailure {
  /** The DOMException name where there is one — `NotAllowedError`, `NotSupportedError`, … */
  readonly name: string
  readonly message: string
}

export interface ClipPlayer extends SpeechPort {
  /**
   * Unlocks the single shared `<audio>` element. Must be called
   * synchronously-close to the Drill-start tap — the user-gesture context
   * does not survive an `await` boundary on iOS. Reports its own result via
   * the return value and `unlockStatus`, rather than failing silently three
   * clips into a Drill.
   *
   * Whether "play a silent source, then pause, on the same element later
   * reused for every real clip" actually keeps the element unlocked for
   * minutes on iOS Safari is this design's central unverified assumption
   * (T019 §4 ob.2, §6 R1) — confirmed or refuted on-device only in T013.
   */
  unlock(): Promise<boolean>
  readonly unlockStatus: UnlockStatus
  /** Set when `unlock()` last returned false. `undefined` before any attempt, or after success. */
  readonly lastUnlockFailure: UnlockFailure | undefined
}

export interface MissingClipInfo {
  readonly text: string
  readonly lang: Language
}

export interface ClipPlayerDeps {
  /** The one shared `<audio>` element, unlocked by `unlock()` and reused for every Clip. */
  readonly element: AudioElementLike
  readonly clipCache: ClipCache
  /**
   * Every voice a cached Clip could be in, in preference order — the pinned
   * voice first (`knownVoices`, T067). Not one voice: a Phrase that has audio
   * must never go silent because a preference changed, so playback takes the
   * pinned voice where a Clip exists in it and otherwise plays the first
   * offered voice that has one.
   */
  readonly voices: readonly Voice[]
  /** ms added to `clip.durationMs` before the `ended`-race times out. Default 750. */
  readonly slackMs?: number
  /**
   * Called when `speak()` is asked for text with no cached Clip. Expected to
   * be rare: unready Phrases are excluded from the Drill before it starts
   * (T019 §3), so this is the safety net for an unexpected state, not the
   * routine path — see `createClipPlayer`'s doc comment for the resolve
   * decision this drives.
   */
  onMissingClip?(info: MissingClipInfo): void
  /**
   * Reports a failure this adapter deliberately swallows (never throws,
   * never surfaces on the Drill screen) so it still leaves a trace in
   * Diagnostics (T039) instead of none at all: a play() rejection after
   * unlock, a Clip missing at play time, and unlock()'s
   * "judged unlocked after a second AbortError" branch. A plain string
   * callback, not a dependency on the diagnostics adapter directly — this
   * stays an `adapters/audio` file, and the composition root (`App.tsx`)
   * wires it to `errorLog.record`. Never passed the phrase text: that is
   * her data, not this adapter's to persist (see the missing-Clip call site).
   *
   * Throttled per failure kind, not called on every occurrence: a Drill
   * speaks constantly, and the diagnostics log is a 50-entry ring buffer
   * (`ERROR_LOG_CAP`) — logging every repeat of the same standing failure
   * would flood it with duplicates and push out everything else. Each kind
   * logs once, then stays quiet until it recovers (a subsequent successful
   * play), at which point the next occurrence logs again.
   */
  onSilentFailure?(message: string): void
}

/**
 * `SpeechPort` implemented by playing cached Clips (`ClipCache`) through one
 * reused `<audio>`-like element, per T019 §4's adapter obligations. Does not
 * call the synth client — it plays what generation already produced, in
 * whichever offered voice it was produced in (T067).
 *
 * Missing-Clip decision: `speak()` resolves (a silent no-op) rather than
 * rejecting. The domain's step-runner runs the adapter promise's `.finally`
 * without awaiting further (`runUtterance` in `step-runner.ts`), so a
 * rejection here would become an unhandled promise rejection, not a caught
 * error — worse than the state it is meant to report. `onMissingClip` is the
 * side channel a caller can watch instead.
 */
export function createClipPlayer(deps: ClipPlayerDeps): ClipPlayer {
  const { element, clipCache, voices, onMissingClip, onSilentFailure } = deps
  const slackMs = deps.slackMs ?? DEFAULT_SLACK_MS
  let unlockStatus: UnlockStatus = 'pending'
  let lastUnlockFailure: UnlockFailure | undefined
  let stopCurrent: (() => void) | null = null
  // Per-kind throttle for `onSilentFailure` (see its doc comment): true once
  // logged, reset to false on the next successful play so a later, distinct
  // occurrence still surfaces.
  let playFailureLogged = false
  let missingClipLogged = false
  // Shared by every caller mid-attempt (T001): a second Start-Drill tap
  // arriving before the first unlock() resolves used to re-enter this
  // method, reassigning `element.src` and calling `play()` again while the
  // first `play()` was still pending — which the HTML media spec answers by
  // rejecting the first promise with AbortError. Concurrent callers now
  // await the one attempt already in flight instead of racing the element.
  let unlockInFlight: Promise<boolean> | null = null

  /**
   * `retried` distinguishes a fresh AbortError from one seen after the one
   * retry below — see the AbortError branch.
   */
  async function attemptUnlock(retried: boolean): Promise<boolean> {
    try {
      element.src = SILENT_UNLOCK_SOURCE
      await element.play()
      element.pause()
      unlockStatus = 'unlocked'
      lastUnlockFailure = undefined
      return true
    } catch (error) {
      const name = error instanceof Error ? error.name : 'UnknownError'
      if (name === 'AbortError') {
        // A THIRD category, distinct from the two below: AbortError means
        // this play() was INTERRUPTED (something else touched the element
        // mid-flight — historically, a second unlock() call), not that
        // iOS or the source refused it. The element is typically left
        // unlocked by whichever attempt actually completed. One retry
        // turns "typically" into a real answer for the cases that still
        // reach here after the in-flight guard above (e.g. a stray
        // cancel()/speak() on the same shared element); if the retry
        // aborts too, further retries just spin on the same interruption,
        // so treat it as unlocked rather than report a failure that was
        // never a refusal.
        if (!retried) return attemptUnlock(true)
        unlockStatus = 'unlocked'
        lastUnlockFailure = undefined
        onSilentFailure?.(
          `unlock judged the element unlocked after a second AbortError in a row (retry aborted too) — ` +
            `that judgement could be wrong`,
        )
        return true
      }
      // The whole point of naming it: at this call site an iOS autoplay
      // refusal (NotAllowedError) and an undecodable source
      // (NotSupportedError) are the same catch, and they need opposite
      // fixes. Reporting "couldn't start audio on this phone" for both
      // blamed the device for a malformed 52-byte WAV for an entire
      // release. Never collapse them again.
      lastUnlockFailure =
        error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'UnknownError', message: String(error) }
      unlockStatus = 'failed'
      return false
    }
  }

  return {
    get unlockStatus(): UnlockStatus {
      return unlockStatus
    },

    get lastUnlockFailure(): UnlockFailure | undefined {
      return lastUnlockFailure
    },

    async unlock(): Promise<boolean> {
      if (unlockInFlight) return unlockInFlight
      const attempt = attemptUnlock(false).finally(() => {
        unlockInFlight = null
      })
      unlockInFlight = attempt
      return attempt
    },

    async speak(text: string, lang: Language): Promise<void> {
      // Resolved per side, not per Phrase: each of the French and the
      // English plays in the best voice IT has audio in. The two can differ
      // in the rare half-generated case, and audio in two voices is a better
      // answer than silence in one.
      const hash = await findCachedClipHash((h) => clipCache.has(h), voices, lang, text)
      const clip = hash ? await clipCache.get(hash) : undefined
      if (!clip) {
        onMissingClip?.({ text, lang })
        // Never the phrase text — that is her data, not this log's (redact.ts
        // only strips known secrets, not free text). `lang` is enough for a
        // report to say "audio is missing for French" without it.
        if (!missingClipLogged) {
          missingClipLogged = true
          onSilentFailure?.(`Clip missing at play time for a Phrase readiness said was playable (lang ${lang})`)
        }
        return
      }
      missingClipLogged = false

      const url = URL.createObjectURL(new Blob([clip.bytes], { type: clip.mime }))
      await new Promise<void>((resolve) => {
        let settled = false
        const finish = (): void => {
          if (settled) return
          settled = true
          element.removeEventListener('ended', onEnded)
          clearTimeout(timer)
          if (stopCurrent === finish) stopCurrent = null
          URL.revokeObjectURL(url)
          resolve()
        }
        const onEnded = (): void => finish()

        stopCurrent = finish
        element.addEventListener('ended', onEnded, { once: true })
        const timer = setTimeout(finish, clip.durationMs + slackMs)
        element.src = url
        element.play().then(
          () => {
            playFailureLogged = false
          },
          (error: unknown) => {
            if (!playFailureLogged) {
              playFailureLogged = true
              const name = error instanceof Error ? error.name : 'UnknownError'
              const message = error instanceof Error ? error.message : String(error)
              onSilentFailure?.(`play() failed after unlock (${name}: ${message})`)
            }
            finish()
          },
        )
      })
    },

    cancel(): void {
      element.pause()
      stopCurrent?.()
    },
  }
}
