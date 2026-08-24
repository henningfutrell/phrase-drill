/**
 * The Route hold (T004): a second, dedicated `<audio>` element that loops an
 * inaudible source for the whole of a Drill so the phone's audio output route
 * never goes idle.
 *
 * Why it exists: a Drill's steady state is a second or two of Clip followed by
 * a 1.5-5 s Pause, and across that Pause the shared Clip element is not merely
 * stopped — `clip-player.ts`'s `finish()` pauses it and then revokes its object
 * URL, so it holds no source at all. A Bluetooth A2DP route that goes idle in
 * that gap is re-acquired with the head of the next Clip already gone, heard in
 * a car as choppiness. This element plays continuously for the whole Drill,
 * with zero `src` assignments and zero `pause()` calls in between.
 *
 * It is deliberately NOT part of `clip-player.ts`. That file's element is torn
 * down and rebuilt on every Step, and its `AudioElementLike` declares only
 * `src`/`duration`/`play`/`pause`/`ended`+`loadedmetadata` — kept minimal on
 * purpose so unrelated structural fakes across the suite still satisfy it. The
 * hold needs `currentTime`, `loop` and `'timeupdate'`; widening that interface
 * would force every one of those fakes to model fields they have no business
 * modelling, and putting two opposite lifecycles in one closure is exactly the
 * cross-talk clip-player's single-owner discipline exists to record.
 *
 * Honest limit, stated rather than claimed away: the mechanism is iOS keeping
 * its own output route active while an element is *playing* — that depends on
 * playback state, not on sample values. The +/-1 samples below only defeat a
 * digital-silence check on the phone side; whether they survive SBC/AAC
 * encoding to a head unit cannot be answered from source. They are cheap
 * insurance, not the mechanism. And whether iOS Safari will play a second
 * element at all is unverified — which is why `stats()` reports how long the
 * hold was held against how long it actually played. If the answer is "it
 * didn't", this degrades to a no-op that says so in the Diagnostic report.
 */

const SAMPLE_RATE = 44100
const CHANNELS = 1
const BITS_PER_SAMPLE = 16

/**
 * Exactly one second. The loop wrap is the one moment the hold can itself
 * produce a gap, so it happens 60 times a minute rather than the ~200 a
 * few-hundred-millisecond source would cost.
 */
const HOLD_FRAMES = SAMPLE_RATE

/**
 * The source's exact length in seconds, derived rather than written as `1`:
 * `onTimeUpdate` needs it to credit a loop wrap, and a magic literal there
 * would go stale the moment the rate or the frame count moved.
 */
export const ROUTE_HOLD_SOURCE_SECONDS = HOLD_FRAMES / SAMPLE_RATE

/**
 * Frames per half cycle of the +/-1 square wave: 4410, i.e. 5 Hz. NOT
 * per-sample. Alternating every sample at 44.1 kHz is a 22.05 kHz square
 * sitting on Nyquist — the resampler and the SBC encoder annihilate it and it
 * can alias into the audible band. 5 Hz is below audibility and below the
 * passband of every car speaker, while the PCM is provably never digitally
 * silent.
 */
const FRAMES_PER_HALF_CYCLE = SAMPLE_RATE / 10

/**
 * A Drill is bounded — 200 Reps at roughly 20 s each is about 67 minutes — so
 * a hold still standing after 90 minutes is a hold whose Drill screen went
 * away without releasing it. That is reachable: a 401 on any /api call
 * re-renders the root over the same container, and React never unmounts the
 * displaced tree, so its cleanup effects may never run. An unreleasable hold
 * would occupy their phone's audio output indefinitely, blocking music,
 * podcasts and navigation audio with no control in the app to end it short of
 * force-quitting — strictly worse than making no change at all. Hence a
 * ceiling, not a hope.
 */
export const ROUTE_HOLD_WATCHDOG_MS = 90 * 60 * 1000

/**
 * Below this, a hold is too short to judge: `'timeupdate'` fires roughly four
 * times a second, so a two-second hold that reported no advance would be
 * noise, not a finding.
 */
const MIN_JUDGED_HOLD_MS = 10_000

/** A hold that played less than half the time it was held did not hold. */
const HEALTHY_ADVANCE_RATIO = 0.5

/**
 * The slice of `HTMLAudioElement` this adapter needs. Its own minimal shape,
 * not `clip-player.ts`'s — see the file comment. `muted` and `volume` are
 * absent deliberately: a muted element does not hold an output route, and iOS
 * Safari treats media `volume` as hardware-controlled and ignores writes to
 * it. The amplitude has to live in the samples, and leaving both off this
 * interface is what makes "never written" a compile-time fact.
 */
export interface RouteHoldElementLike {
  src: string
  loop: boolean
  /** Media clock, in seconds. The only honest evidence the element is playing. */
  readonly currentTime: number
  play(): Promise<void>
  pause(): void
  addEventListener(type: 'timeupdate', listener: () => void): void
  removeEventListener(type: 'timeupdate', listener: () => void): void
}

/**
 * What the hold can say about itself. Two clocks compared: `totalHeldMs` is
 * wall clock between `hold()` and `release()`, `advancedMs` is media clock.
 * Equal means a second element really did play for the whole Drill; far apart
 * means iOS stopped it and the hypothesis is refuted. Neither number requires
 * them to describe anything.
 */
export interface RouteHoldStats {
  /** Attempts, including every re-hold after a Resume. */
  readonly starts: number
  /** Whether the last `play()` resolved. `null` = never attempted. */
  readonly playResolved: boolean | null
  /**
   * Why the last `play()` rejected. `NotAllowedError` (iOS refused a second
   * element) and `NotSupportedError` (the source is undecodable) call for
   * opposite fixes and must never be collapsed into one verdict.
   */
  readonly lastError?: { readonly name: string; readonly message: string }
  readonly totalHeldMs: number
  readonly advancedMs: number
  readonly watchdogFired: boolean
}

export interface RouteHold {
  /**
   * Synchronous on purpose, and not a promise. This runs inside the
   * Start-Drill tap, and an awaitable start invites the one `await` that
   * loses the gesture on iOS.
   */
  hold(): void
  release(): void
  stats(): RouteHoldStats
}

export interface RouteHoldDeps {
  readonly element: RouteHoldElementLike
  /**
   * Reports a failure this adapter deliberately swallows — it never throws
   * and never surfaces on the Drill screen, because a hold failing is not a
   * reason to tell their audio didn't start when it did. A plain string
   * callback, not a dependency on the diagnostics adapter: this stays an
   * `adapters/audio` file and the composition root wires it to
   * `errorLog.record`, exactly as it does for `ClipPlayerDeps`.
   *
   * Throttled per failure kind for the same reason clip-player throttles
   * its own: the diagnostics log is a 50-entry ring buffer, and a standing
   * failure repeated once per Drill would evict every real one. Each kind
   * reports once and stays quiet until it recovers.
   */
  onSilentFailure?(message: string): void
}

/**
 * Builds the keepalive source. Generated, never hand-edited, and never
 * literal-typed: the released unlock-source defect was one stray zero byte
 * after the RIFF size field, putting `WAVE` at offset 9 instead of 8, which
 * every browser refused to decode. Two rules make that class unconstructible
 * and both are asserted by `route-hold.test.ts` — `byteRate`/`blockAlign` are
 * computed from rate/channels/bits, and both size fields are computed from
 * the buffer's real length rather than an intended one.
 *
 * 44.1 kHz because that is what the Clips are (`elevenlabs-client.js`'s
 * `mp3_44100_128`): starting the hold then never forces the output session to
 * renegotiate its rate mid-Drill, and a session reconfiguration is itself a
 * glitch source. 16-bit signed because a +/-1 LSB is -90.3 dBFS; the existing
 * 8-bit unsigned unlock source cannot be made inaudible, one LSB there being
 * roughly -48 dBFS.
 */
export function createRouteHoldWav(): Uint8Array<ArrayBuffer> {
  const bytesPerFrame = (BITS_PER_SAMPLE / 8) * CHANNELS
  const buffer = new ArrayBuffer(44 + HOLD_FRAMES * bytesPerFrame)
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)

  const writeAscii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index)
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size for PCM
  view.setUint16(20, 1, true) // WAVE_FORMAT_PCM
  view.setUint16(22, CHANNELS, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * bytesPerFrame, true) // byteRate, derived
  view.setUint16(32, bytesPerFrame, true) // blockAlign, derived
  view.setUint16(34, BITS_PER_SAMPLE, true)
  writeAscii(36, 'data')
  view.setUint32(40, bytes.length - 44, true)

  for (let frame = 0; frame < HOLD_FRAMES; frame += 1) {
    const positive = Math.floor(frame / FRAMES_PER_HALF_CYCLE) % 2 === 0
    view.setInt16(44 + frame * bytesPerFrame, positive ? 1 : -1, true)
  }

  return bytes
}

/**
 * One object URL for the app's life, built the first time a hold is
 * constructed and never revoked while one exists. Module-scoped rather than
 * per-port so a remount cannot leak a second 88 KB blob, and an object URL
 * rather than an inlined data URI because 88 KB of base64 is 117 KB of bundle
 * for nothing.
 */
let sourceUrl: string | undefined

export function createRouteHold({ element, onSilentFailure }: RouteHoldDeps): RouteHold {
  sourceUrl ??= URL.createObjectURL(new Blob([createRouteHoldWav()], { type: 'audio/wav' }))
  // Assigned here, at composition, never inside the tap. index.html's own
  // comment on the unlock element records why: an element given a `src` and
  // played in the same breath, with its load still pending, can miss the
  // gesture window entirely. By the time the user taps Start, this one has been
  // loaded for as long as the app has been open.
  element.src = sourceUrl

  let holding = false
  let starts = 0
  let playResolved: boolean | null = null
  let lastError: { name: string; message: string } | undefined
  let settledHeldMs = 0
  let advancedMs = 0
  let watchdogFired = false
  let heldSince: number | null = null
  let advancedAtHoldStart = 0
  let lastMediaTime = 0
  // Held as its own canceller rather than a timer handle, so nothing here
  // has to name whichever of `number`/`Timeout` this platform's setTimeout
  // returns.
  let cancelWatchdog: (() => void) | null = null
  // Per-kind throttles, mirroring clip-player's.
  let playFailureLogged = false
  let noAdvanceLogged = false

  function onTimeUpdate(): void {
    const now = element.currentTime
    if (now > lastMediaTime) {
      advancedMs += (now - lastMediaTime) * 1000
    } else if (now < lastMediaTime) {
      // A loop wrap. `'timeupdate'` fires roughly four times a second against
      // a one-second source, so a wrap falls between two samples on every
      // single cycle: what actually played is the tail of the old cycle plus
      // the head of the new one. Crediting nothing here — as this did when it
      // shipped — loses about 250 ms per wrap, once per second of wall clock,
      // and makes a perfectly healthy hold report `played` at three quarters
      // of `held`. That number is the only evidence that iOS played the
      // second element at all, so an under-read is a confident falsehood.
      const credit = ROUTE_HOLD_SOURCE_SECONDS - lastMediaTime + now
      // A seek should never happen — nothing writes `currentTime` — so a
      // credit outside one source length is nonsense, not playback. Discard
      // it rather than let it inflate the one number being measured.
      if (credit > 0 && credit <= ROUTE_HOLD_SOURCE_SECONDS) advancedMs += credit * 1000
    }
    lastMediaTime = now
  }

  /** Ends the current hold and returns how long it actually ran. */
  function stopHolding(): number {
    holding = false
    element.removeEventListener('timeupdate', onTimeUpdate)
    element.pause()
    cancelWatchdog?.()
    cancelWatchdog = null
    const heldMs = heldSince === null ? 0 : Date.now() - heldSince
    heldSince = null
    settledHeldMs += heldMs
    return heldMs
  }

  return {
    hold(): void {
      // A second hold while already holding is a no-op, not a second play():
      // one element, one owner, and `starts` stays an honest count of
      // attempts so a Resume after an iOS suspend is visible as one.
      if (holding) return
      holding = true
      starts += 1
      heldSince = Date.now()
      advancedAtHoldStart = advancedMs
      lastMediaTime = element.currentTime
      element.loop = true
      element.addEventListener('timeupdate', onTimeUpdate)

      const timer = setTimeout(() => {
        if (!holding) return
        watchdogFired = true
        const heldMs = stopHolding()
        onSilentFailure?.(
          `watchdog stopped the hold after ${Math.round(heldMs)}ms with no release — a Drill screen was probably discarded mid-run`,
        )
      }, ROUTE_HOLD_WATCHDOG_MS)
      cancelWatchdog = () => clearTimeout(timer)

      void element.play().then(
        () => {
          playResolved = true
          lastError = undefined
          playFailureLogged = false
        },
        (error: unknown) => {
          playResolved = false
          const name = error instanceof Error ? error.name : 'UnknownError'
          const message = error instanceof Error ? error.message : String(error)
          lastError = { name, message }
          if (playFailureLogged) return
          playFailureLogged = true
          onSilentFailure?.(
            `play() rejected (${name}: ${message}) — the audio route is not being held`,
          )
        },
      )
    },

    release(): void {
      if (!holding) return
      const heldMs = stopHolding()
      const advancedThisHold = advancedMs - advancedAtHoldStart

      // The one persisted finding worth a slot in a 50-entry ring buffer: the
      // hold was held and the media clock did not keep up, which means the
      // element was not really playing and the whole mechanism is refuted.
      // Gated, so fifty routine drills cannot evict every real failure. A
      // rejected play() has already reported itself above, and repeating it
      // here would say the same thing twice.
      if (lastError !== undefined || noAdvanceLogged) return
      if (heldMs < MIN_JUDGED_HOLD_MS) return
      if (advancedThisHold >= heldMs * HEALTHY_ADVANCE_RATIO) return
      noAdvanceLogged = true
      onSilentFailure?.(
        `held ${Math.round(heldMs)}ms but currentTime advanced only ${Math.round(advancedThisHold)}ms — the element is not actually playing`,
      )
    },

    stats(): RouteHoldStats {
      return {
        starts,
        playResolved,
        lastError,
        totalHeldMs: settledHeldMs + (heldSince === null ? 0 : Date.now() - heldSince),
        advancedMs,
        watchdogFired,
      }
    },
  }
}
