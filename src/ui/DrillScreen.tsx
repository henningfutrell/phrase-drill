import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ClockPort,
  DrillPlayer,
  DrillStatus,
  Language,
  Phrase,
  RandomSource,
  SpeechPort,
  Step,
} from '../domain'
import { createDrillPlayer } from '../domain'
import '../styles/tokens.css'
import './DrillScreen.css'

/**
 * Plain mirror of `DrillReadiness` (adapters/audio/drill-readiness.ts) — no
 * adapter type crosses into UI (AGENTS.md: only App.tsx/main.tsx import from
 * both domain/ and adapters/*). The composition root passes a closure that
 * already has the real deps bound.
 */
export interface DrillReadinessResult {
  readonly ready: readonly Phrase[]
  readonly skippedCount: number
  readonly canStart: boolean
  readonly reason?: 'no-voice' | 'none-ready'
  /** Whether there was a network when readiness was checked — see `blockedCopy`. */
  readonly online: boolean
}

/**
 * Why the Drill will not start, in her words. `none-ready` has two meanings
 * and they need opposite responses, so it has two lines (T036): online, the
 * audio is being made and waiting is right; offline, the audio was cleared to
 * keep the cache under its ceiling and waiting achieves nothing — it comes
 * back with the connection. Saying "still being made" with no network is a
 * promise the app cannot keep, and the one thing it must never leave in doubt
 * is that nothing of hers was lost.
 */
function blockedCopy(reason: 'no-voice' | 'none-ready', online: boolean): string {
  if (reason === 'no-voice') {
    return 'No voice has been chosen yet — pick one in Settings before drilling.'
  }
  return online
    ? "This drill's audio isn't on this phone yet — getting it now. The drill opens by itself as soon as the first phrases are ready."
    : "This drill's audio isn't on this phone right now, and there's no connection to fetch it. " +
        'It comes back on its own when you’re online again — your phrases are safe.'
}

/**
 * How often the screen re-reads readiness while audio is arriving (#4). The
 * re-read is a local index lookup — no network — so this is about how soon
 * she sees the count move, not about load.
 */
const DEFAULT_RECHECK_MS = 3000

function phrasesLabel(count: number): string {
  return `${count} phrase${count === 1 ? '' : 's'}`
}

const BEATS = [0, 1, 2, 3] as const

interface LiveStep {
  readonly beatIndex: number
  readonly utterance?: { text: string; lang: Language }
}

/**
 * Wraps the raw ports so every Step the DrillPlayer executes is observable
 * here. The domain player (`src/domain/drill-player.ts`) exposes only
 * `status`/`position` — no per-step event — so the Beat row and current line
 * this screen must show (docs/design.md §3.1) are reconstructed by
 * intercepting the calls the player already makes through `StepPorts`,
 * rather than by changing the domain.
 *
 * The player replays the in-flight Step on resume: `pause()` aborts it and
 * breaks the run loop without calling `advanceStep()`
 * (`drill-player.ts:85-92,182-189`), and `resume()` re-enters at that same,
 * unchanged position — so `speak()`/`wait()` is called a second time for a
 * Step this screen already counted. A bare counter (`stepCounter += 1` on
 * every call) took that replay for a new Step, running one ahead of the
 * real cadence position for the rest of the Rep.
 *
 * The replay can't be caught by comparing the actual `Step` the domain is
 * on: `StepPorts` never hands one across — `speak(text, lang)` and
 * `wait(ms, signal)` carry only the fields needed to execute it, not the
 * object itself, so there is nothing here to hold a reference to. What is
 * available is `step.kind`, and `buildCadence` (`cadence.ts`) is a fixed,
 * strictly alternating FR/pause/FR/pause/EN/pause/FR/pause — no two
 * adjacent Steps in one Rep ever share a kind. So two `note()` calls in a
 * row reporting the *same* kind, within the same Rep, can only be this
 * replay; the cadence itself never produces that sequence.
 */
function instrumentPorts(
  speech: SpeechPort,
  clock: ClockPort,
  getRepIndex: () => number,
  onStep: (info: LiveStep) => void,
): { speech: SpeechPort; clock: ClockPort } {
  let lastRepIndex = -1
  let stepCounter = 0
  let lastKind: Step['kind'] | null = null

  function note(step: Step): void {
    const repIndex = getRepIndex()
    if (repIndex !== lastRepIndex) {
      lastRepIndex = repIndex
      stepCounter = 0
      lastKind = null
    }
    let stepIndex: number
    if (step.kind === lastKind) {
      // Two same-kind Steps in a row within one Rep never happens in the
      // real cadence (see doc comment) — this is resume replaying the Step
      // already counted last call. Reuse its position.
      stepIndex = stepCounter - 1
    } else {
      stepIndex = stepCounter
      stepCounter += 1
      lastKind = step.kind
    }
    onStep({
      beatIndex: Math.floor(stepIndex / 2),
      utterance: step.kind === 'utterance' ? { text: step.text, lang: step.lang } : undefined,
    })
  }

  return {
    speech: {
      speak(text, lang) {
        note({ kind: 'utterance', text, lang })
        return speech.speak(text, lang)
      },
      cancel() {
        speech.cancel()
      },
    },
    clock: {
      wait(ms, signal) {
        note({ kind: 'pause', ms })
        return clock.wait(ms, signal)
      },
    },
  }
}

export interface DrillScreenProps {
  /** Deck or Mix name (docs/design.md §3.1 header). */
  readonly title: string
  /** Runs the readiness gate (T024) — the composition root binds the real Phrases/deps. */
  readonly checkReadiness: () => Promise<DrillReadinessResult>
  /**
   * Re-reads readiness without asking for anything (#4): what the first
   * check queued keeps arriving, and this is how the screen sees it. Called
   * every `recheckEveryMs` while online, before Start, and while something
   * is still missing — so a long Deck opens as soon as its first phrases are
   * here, rather than telling her to come back. Omitted, nothing re-checks.
   */
  readonly recheckReadiness?: () => Promise<DrillReadinessResult>
  readonly recheckEveryMs?: number
  readonly speech: SpeechPort
  readonly clock: ClockPort
  /** Applies Shuffle at Drill start — omitted only in tests that don't care. */
  readonly random?: RandomSource
  /**
   * Unlocks the shared audio element. Called first, synchronously from the
   * Start-tap handler, before anything else runs (T023, T019 §4 ob.2) — the
   * user-gesture context does not survive an `await` boundary on iOS, and
   * this ordering is the only thing this screen can do to preserve it.
   */
  readonly unlock: () => Promise<UnlockOutcome>
  readonly acquireWakeLock?: () => Promise<void>
  readonly releaseWakeLock?: () => Promise<void>
  /**
   * Starts the Route hold (T004): a second `<audio>` element looping an
   * inaudible source so the phone's Bluetooth output route does not go idle
   * across a Pause. Synchronous on purpose, and deliberately NOT the
   * `() => Promise<void>` shape of the Wake Lock pair above — it has to run
   * inside the Start tap, and an awaitable start invites the one `await`
   * that loses the gesture on iOS.
   *
   * Kept out of `unlock` on purpose too: `unlock`'s failure is rendered to
   * her verbatim as "Audio didn't start", and a hold that failed while the
   * Clip element unlocked fine would tell her audio didn't start when it did.
   */
  readonly holdAudioRoute?: () => void
  readonly releaseAudioRoute?: () => void
  /**
   * Generation suspension (docs/glossary.md): stops the Clip-generation
   * queue issuing anything for the whole of a Drill — the Start tap until
   * the run stops, a Pause included. Four concurrent HTTPS fetches, the MP3
   * bodies behind them, and the IndexedDB writes that follow all compete
   * with the audio she is listening to on a phone on cellular — and none of
   * that work is for the Drill that is playing, since only `ready` Phrases
   * enter one.
   *
   * The queue's `suspend()` is an idempotent boolean and never a counter,
   * because this screen takes suspension from two places — the Start tap,
   * synchronously, and the effect that watches the running phase — and
   * releases it from one. Two takes against one release is what makes every
   * release path load-bearing, including the unlock failure that never
   * reaches the running phase at all.
   */
  readonly suspendGeneration?: () => void
  readonly resumeGeneration?: () => void
  /** Back to whatever screen launched this Drill (Deck detail or Mix). */
  readonly onExit: () => void
  /** Only used for the 'no-voice' blocked reason. */
  readonly onOpenSettings?: () => void
}

/** What `unlock` reports back. `ok` false carries the reason the screen states verbatim. */
export type UnlockOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly name: string; readonly message: string }

type Phase =
  | { kind: 'checking' }
  | { kind: 'blocked'; reason: 'no-voice' | 'none-ready'; online: boolean }
  | {
      kind: 'start'
      ready: readonly Phrase[]
      skippedCount: number
      online: boolean
      unlockFailure?: UnlockOutcome & { ok: false }
    }
  | { kind: 'running'; skippedCount: number }

/**
 * The Drill screen (docs/design.md §3.1) — a Deck or Mix run end to end,
 * hands-free, arm's length, spoken aloud. Owns the readiness gate (T024),
 * the one-tap unlock (T023), the Wake Lock for the run's duration, and the
 * interrupted-by-screen-lock state. Does not reimplement `createDrillPlayer`
 * or the Cadence — it drives the existing domain player and reconstructs the
 * step-by-step UI from the ports it hands that player.
 */
export function DrillScreen({
  title,
  checkReadiness,
  recheckReadiness,
  recheckEveryMs = DEFAULT_RECHECK_MS,
  speech,
  clock,
  random,
  unlock,
  acquireWakeLock,
  releaseWakeLock,
  holdAudioRoute,
  releaseAudioRoute,
  suspendGeneration,
  resumeGeneration,
  onExit,
  onOpenSettings,
}: DrillScreenProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' })
  const playerRef = useRef<DrillPlayer | null>(null)
  // Mirrors `starting` below, checked synchronously (T001 hardening). React
  // state is only current as of the last render, so two taps landing in the
  // same synchronous tick both read `starting` as `false` from the same
  // render's closure — a ref is written and read outside render, so the
  // second tap sees the first's write immediately. Not a fix for any
  // observed symptom: a real tap is a discrete DOM event React flushes
  // synchronously, so a phone cannot deliver two in one tick. Belt-and-
  // braces because it costs nothing.
  const startingRef = useRef(false)
  const [status, setStatus] = useState<DrillStatus>('stopped')
  const [repIndex, setRepIndex] = useState(0)
  const [repCount, setRepCount] = useState(0)
  const [live, setLive] = useState<LiveStep>({ beatIndex: 0 })
  const [interrupted, setInterrupted] = useState(false)
  // True only for the span of this tap's own unlock() call (T001) — guards
  // the Start Drill button against a second tap re-entering handleStart
  // while the first is still awaiting unlock, and is always cleared
  // afterwards (success or failure) so a genuine failure leaves the button
  // tappable again, per the error copy's own "Tap Start Drill to try again."
  const [starting, setStarting] = useState(false)
  // The last spoken line, held across pause Steps (which carry no
  // utterance) rather than reset by every Step — a normal render value,
  // not a ref, since it feeds directly into JSX below.
  const [currentUtterance, setCurrentUtterance] = useState<
    { text: string; lang: Language } | undefined
  >(undefined)
  const [, forceRender] = useState(0)

  /** A readiness answer, as the phase it puts the screen in. An unlock
   * failure already on the start card stays there — a re-check is not a tap. */
  function applyReadiness(result: DrillReadinessResult): void {
    if (!result.canStart) {
      setPhase({ kind: 'blocked', reason: result.reason ?? 'none-ready', online: result.online })
      return
    }
    setPhase((current) => ({
      kind: 'start',
      ready: result.ready,
      skippedCount: result.skippedCount,
      online: result.online,
      unlockFailure: current.kind === 'start' ? current.unlockFailure : undefined,
    }))
  }

  useEffect(() => {
    let cancelled = false
    void checkReadiness().then((result) => {
      if (!cancelled) applyReadiness(result)
    })
    return () => {
      cancelled = true
    }
    // Runs once: re-checking readiness is a fresh mount (a new Drill), not a re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Watching the audio arrive (#4). Only while something is missing, online
  // (offline nothing can arrive), and before Start: once the Drill runs, its
  // Phrases are fixed. Not while a Start tap is in flight, so the list she
  // tapped is the list that plays.
  const watching =
    !!recheckReadiness &&
    !starting &&
    ((phase.kind === 'blocked' && phase.reason === 'none-ready' && phase.online) ||
      (phase.kind === 'start' && phase.skippedCount > 0 && phase.online))
  useEffect(() => {
    if (!watching || !recheckReadiness) return
    let cancelled = false
    const timer = setTimeout(() => {
      void recheckReadiness().then((result) => {
        if (!cancelled && !startingRef.current) applyReadiness(result)
      })
    }, recheckEveryMs)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // Re-armed by each new answer: `phase` is a fresh object every time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching, phase])

  // The Drill screen going away mid-run. Not reachable from any control on
  // this screen — the running phase renders Skip/Pause/Stop only — but a 401
  // on any /api call re-renders the root to the login screen (main.tsx's
  // `onUnauthorized`), and that must not leave the Route hold playing for the
  // rest of the app's life. Keyed on nothing and read through a ref: the prop
  // is a fresh arrow on every App render (App.tsx wires it the way it wires
  // acquireWakeLock), so an effect keyed on it would release the hold
  // mid-Drill on any unrelated re-render. This cleanup does run, since
  // `root-renderer.ts` memoizes one React root per container, so `showLogin()`
  // genuinely unmounts this tree instead of displacing it. That makes the
  // hold's own watchdog the belt rather than the braces — kept, not relied on.
  const releaseAudioRouteRef = useRef(releaseAudioRoute)
  // Generation suspension's pair, held the same way and for the same reason
  // (see their prop doc): App.tsx wires them as fresh arrows too, so the
  // effect below can key on `phase.kind` and nothing else.
  const suspendGenerationRef = useRef(suspendGeneration)
  const resumeGenerationRef = useRef(resumeGeneration)
  useEffect(() => {
    releaseAudioRouteRef.current = releaseAudioRoute
    suspendGenerationRef.current = suspendGeneration
    resumeGenerationRef.current = resumeGeneration
  })
  useEffect(() => () => releaseAudioRouteRef.current?.(), [])

  // Generation suspension for the whole of the running phase — the second of
  // its two takes, and the only one that registers a release. Keyed on
  // `phase.kind` alone: App re-renders during a Drill (the sync engine's
  // snapshot subscription, a write failure, settings), and keying on the
  // callbacks' identities would fire cleanup → resume() → body → suspend()
  // on every one of those, letting the parked Clips into the network
  // mid-Drill.
  useEffect(() => {
    if (phase.kind !== 'running') return
    suspendGenerationRef.current?.()
    return () => resumeGenerationRef.current?.()
  }, [phase.kind])

  /** Pulls status/position off the player after any control call, and exits
   * cleanly the moment the Drill has actually stopped (manual Stop, a Skip
   * past the last Rep, or simply running out of Reps). */
  const syncFromPlayer = useCallback(() => {
    const player = playerRef.current
    if (!player) return
    setStatus(player.status)
    setRepIndex(player.position)
    setRepCount(player.repCount)
    if (player.status === 'stopped') {
      playerRef.current = null
      void releaseWakeLock?.()
      releaseAudioRoute?.()
      onExit()
    }
  }, [onExit, releaseWakeLock, releaseAudioRoute])

  async function handleStart(readyPhrases: readonly Phrase[], skippedCount: number, online: boolean) {
    // Guards against a second tap re-entering this method while the first
    // is still awaiting unlock() (T001) — the ref is the real guard (see its
    // doc comment); `starting`/`disabled` below is the visible half.
    if (startingRef.current) return
    startingRef.current = true
    setStarting(true)
    try {
      // Unlock first, inside this tap — see the `unlock` prop doc comment.
      // Called, not awaited, so the Route hold's own play() still lands in
      // this gesture: unlock() reaches `element.src = …; element.play()`
      // synchronously (clip-player.ts `attemptUnlock`), so the shared Clip
      // element claims the gesture first and the hold second — the order
      // that matters if iOS honours only one play() per tap, since silent
      // audio is worse than choppy audio.
      const unlocking = unlock()
      holdAudioRoute?.()
      // Generation suspension's first take, inside the tap. The running-phase
      // effect above cannot do this job alone: `setPhase` below is scheduled
      // rather than flushed, and `player.start()` runs straight through to
      // the first `speak()` in the same synchronous stretch, so the effect
      // lands a scheduler task after the Drill is already making sound. A
      // boolean write that touches no DOM, so it cannot cost the gesture the
      // two play() calls above depend on.
      suspendGeneration?.()
      const outcome = await unlocking
      if (!outcome.ok) {
        releaseAudioRoute?.()
        // The only release on this path, and it has to be explicit: `phase`
        // goes 'start' → 'start', so the running-phase effect never mounts
        // and no cleanup is ever registered — unmounting the screen would
        // release nothing. The queue is App-lifetime (main.tsx `showApp`),
        // so without this line one refused unlock stops her library filling
        // for as long as the app stays loaded.
        resumeGeneration?.()
        setPhase({ kind: 'start', ready: readyPhrases, skippedCount, online, unlockFailure: outcome })
        return
      }

      void acquireWakeLock?.()
      setCurrentUtterance(undefined)
      setLive({ beatIndex: 0 })
      setInterrupted(false)

      const ports = instrumentPorts(
        speech,
        clock,
        () => playerRef.current?.position ?? 0,
        (info) => {
          if (info.utterance) setCurrentUtterance(info.utterance)
          setLive(info)
        },
      )
      const player = createDrillPlayer(readyPhrases, ports, { random })
      // Not normally reachable — the guard above and the Start button only
      // rendering in the 'start' phase mean `playerRef.current` is null here
      // in ordinary use. Defensive: stop an old player rather than orphan it
      // (leaving it running, silently consuming the ports) if that guard is
      // ever wrong.
      playerRef.current?.stop()
      playerRef.current = player
      setStatus('playing')
      setRepIndex(0)
      setRepCount(player.repCount)
      setPhase({ kind: 'running', skippedCount })

      await player.start()
      syncFromPlayer()
    } finally {
      startingRef.current = false
      setStarting(false)
    }
  }

  function handlePause(): void {
    // Deliberately does NOT resume generation: `phase.kind` stays 'running',
    // so the running-phase effect keeps its take. That is broader than the
    // stated requirement — "no new request while a Drill is playing" — and
    // it is a decision rather than a consequence: she is mid-Drill and about
    // to carry on, and generating through a Pause wakes the very Bluetooth
    // route the Route hold exists to keep warm.
    playerRef.current?.pause()
    syncFromPlayer()
  }

  async function handleResume(): Promise<void> {
    setInterrupted(false)
    void acquireWakeLock?.()
    // Synchronously, inside this tap, for the reason the Start tap does it:
    // iOS suspends media on screen lock, so after an interruption the hold is
    // dead for the rest of the Drill unless a gesture restarts it. Never on a
    // timer — starting a second element mid-Drill is itself a candidate
    // route reconfiguration, so it only ever happens where she asked for it.
    holdAudioRoute?.()
    setStatus('playing')
    await playerRef.current?.resume()
    syncFromPlayer()
  }

  async function handleSkip(): Promise<void> {
    await playerRef.current?.skip()
    syncFromPlayer()
    forceRender((n) => n + 1) // current line / beat row need a paint even if status is unchanged
  }

  function handleStop(): void {
    playerRef.current?.stop()
    syncFromPlayer()
  }

  // The interrupted state (docs/design.md §3.1): iOS suspends playback on
  // screen lock/backgrounding with no web-platform workaround (T001). This
  // freezes the Drill rather than losing position — never verified against
  // real iOS Safari background/foreground timing (T013).
  useEffect(() => {
    if (phase.kind !== 'running') return
    function onVisibilityChange(): void {
      if (document.hidden && playerRef.current?.status === 'playing') {
        playerRef.current.pause()
        setStatus(playerRef.current.status)
        setRepIndex(playerRef.current.position)
        setInterrupted(true)
        // Deliberately unlike the Wake Lock, which is NOT released here.
        // iOS has suspended the element anyway, so a hold still claiming to
        // be held would make the Diagnostic report's held-vs-played numbers
        // a lie — and because an orphaned tree's listeners are still
        // attached, this is what bounds an unreleasable hold to "until she
        // next backgrounds the app". Resume takes it again.
        releaseAudioRoute?.()
        // Generation suspension is deliberately NOT released here, unlike
        // the hold on the line above. iOS has suspended everything anyway,
        // and generation is the one thing left that could wake the radio
        // while the Drill is frozen. Stated rather than left to be found:
        // a Drill left backgrounded holds suspension until she comes back
        // and stops it or plays it out. No watchdog — a timer resuming here
        // would resume mid-Drill, which is exactly what handlePause refuses.
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [phase.kind, releaseAudioRoute])

  if (phase.kind === 'checking') {
    return <main className="drill-screen" data-testid="drill-checking" />
  }

  if (phase.kind === 'blocked') {
    return (
      <main className="drill-screen">
        <button type="button" data-testid="drill-back" className="link-action" onClick={onExit}>
          Back
        </button>
        <p data-testid="drill-blocked" className="drill-blocked">
          {blockedCopy(phase.reason, phase.online)}
        </p>
        {phase.reason === 'no-voice' && onOpenSettings && (
          <button
            type="button"
            data-testid="drill-open-settings"
            className="btn-primary"
            onClick={onOpenSettings}
          >
            Open Settings
          </button>
        )}
      </main>
    )
  }

  if (phase.kind === 'start') {
    return (
      <main className="drill-screen" data-testid="drill-start-card">
        <button type="button" data-testid="drill-back" className="link-action" onClick={onExit}>
          Back
        </button>
        <h1 data-testid="drill-title">{title}</h1>
        <p data-testid="drill-phrase-count">{phrasesLabel(phase.ready.length)}</p>
        {phase.skippedCount > 0 && (
          <p data-testid="drill-skipped-count" className="drill-skipped">
            {phrasesLabel(phase.skippedCount)}{' '}
            {phase.online
              ? recheckReadiness
                ? 'still getting audio — they join this drill as they arrive, until you start'
                : 'have no audio yet — skipped'
              : 'have no audio on this phone — skipped until you’re online'}
          </p>
        )}
        <button
          type="button"
          data-testid="drill-start"
          className="btn-primary"
          disabled={starting}
          onClick={() => void handleStart(phase.ready, phase.skippedCount, phase.online)}
        >
          Start Drill
        </button>
        <p className="drill-warning">
          Keep this screen on and open — the drill stops if your phone locks or you switch apps.
          You&apos;ll get a clear &quot;tap to resume.&quot;
        </p>
        <p className="drill-warning">Plays through the speaker even on silent.</p>
        {phase.unlockFailure && (
          <p data-testid="drill-unlock-error" className="drill-unlock-error">
            Audio didn&apos;t start. Tap Start Drill to try again.
            <br />
            <code data-testid="drill-unlock-error-detail">
              {phase.unlockFailure.name}: {phase.unlockFailure.message || '(no message)'}
            </code>
          </p>
        )}
      </main>
    )
  }

  const currentText = currentUtterance?.text ?? ''
  const showResumeLabel = interrupted && status === 'paused'
  const primaryLabel = showResumeLabel ? 'Tap to resume' : status === 'paused' ? 'Resume' : 'Pause'

  return (
    <main className="drill-screen" data-testid="drill-running">
      <header className="drill-header">
        <p className="drill-header-title" data-testid="drill-running-title">
          {title}
        </p>
      </header>

      {interrupted && (
        <p data-testid="drill-interrupted-banner" className="drill-banner">
          Drill paused when your screen locked.
        </p>
      )}

      <div className="drill-beat-row" data-testid="drill-beat-row">
        {BEATS.map((beat) => {
          const state = beat < live.beatIndex ? 'done' : beat === live.beatIndex ? 'live' : 'upcoming'
          return (
            <span
              key={beat}
              data-testid={`drill-beat-${beat}`}
              data-state={state}
              className={`drill-beat drill-beat--${state}`}
            />
          )
        })}
      </div>

      {/* `key` is the whole point: React reuses one <p> across the cadence, so
          without a changing key the arrival animation (DrillScreen.css) plays
          once and never again. Keying on the text remounts the node each time
          the line changes, which is the only moment in this app that animates. */}
      <p key={currentText} data-testid="drill-current-line" className="drill-current-line">
        {currentText}
      </p>

      <p data-testid="drill-rep-counter" className="drill-rep-counter">
        Rep {Math.min(repIndex + 1, Math.max(repCount, 1))} of {repCount}
      </p>

      <div className="drill-controls">
        <button
          type="button"
          data-testid="drill-skip"
          className="drill-control drill-control--secondary"
          onClick={() => void handleSkip()}
        >
          Skip
        </button>
        <button
          type="button"
          data-testid="drill-pause-resume"
          className="drill-control drill-control--primary"
          onClick={() => {
            if (showResumeLabel || status === 'paused') void handleResume()
            else handlePause()
          }}
        >
          {primaryLabel}
        </button>
        <button
          type="button"
          data-testid="drill-stop"
          className="drill-control drill-control--secondary"
          onClick={handleStop}
        >
          Stop
        </button>
      </div>
    </main>
  )
}
