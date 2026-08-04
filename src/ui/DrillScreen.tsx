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
}

const BLOCKED_COPY: Record<'no-voice' | 'none-ready', string> = {
  'no-voice': 'No voice has been chosen yet — pick one in Settings before drilling.',
  'none-ready': "This drill's audio isn't ready yet — it's still being made. Try again in a moment.",
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
 */
function instrumentPorts(
  speech: SpeechPort,
  clock: ClockPort,
  getRepIndex: () => number,
  onStep: (info: LiveStep) => void,
): { speech: SpeechPort; clock: ClockPort } {
  let lastRepIndex = -1
  let stepCounter = 0

  function note(step: Step): void {
    const repIndex = getRepIndex()
    if (repIndex !== lastRepIndex) {
      lastRepIndex = repIndex
      stepCounter = 0
    }
    const stepIndex = stepCounter
    stepCounter += 1
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
  | { kind: 'blocked'; reason: 'no-voice' | 'none-ready' }
  | { kind: 'start'; ready: readonly Phrase[]; skippedCount: number; unlockFailure?: UnlockOutcome & { ok: false } }
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
  speech,
  clock,
  random,
  unlock,
  acquireWakeLock,
  releaseWakeLock,
  onExit,
  onOpenSettings,
}: DrillScreenProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' })
  const playerRef = useRef<DrillPlayer | null>(null)
  const [status, setStatus] = useState<DrillStatus>('stopped')
  const [repIndex, setRepIndex] = useState(0)
  const [repCount, setRepCount] = useState(0)
  const [live, setLive] = useState<LiveStep>({ beatIndex: 0 })
  const [interrupted, setInterrupted] = useState(false)
  // The last spoken line, held across pause Steps (which carry no
  // utterance) rather than reset by every Step — a normal render value,
  // not a ref, since it feeds directly into JSX below.
  const [currentUtterance, setCurrentUtterance] = useState<
    { text: string; lang: Language } | undefined
  >(undefined)
  const [, forceRender] = useState(0)

  useEffect(() => {
    let cancelled = false
    void checkReadiness().then((result) => {
      if (cancelled) return
      if (!result.canStart) {
        setPhase({ kind: 'blocked', reason: result.reason ?? 'none-ready' })
      } else {
        setPhase({
          kind: 'start',
          ready: result.ready,
          skippedCount: result.skippedCount,
          unlockFailure: undefined,
        })
      }
    })
    return () => {
      cancelled = true
    }
    // Runs once: re-checking readiness is a fresh mount (a new Drill), not a re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
      onExit()
    }
  }, [onExit, releaseWakeLock])

  async function handleStart(readyPhrases: readonly Phrase[], skippedCount: number) {
    // Unlock first, inside this tap — see the `unlock` prop doc comment.
    const outcome = await unlock()
    if (!outcome.ok) {
      setPhase({ kind: 'start', ready: readyPhrases, skippedCount, unlockFailure: outcome })
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
    playerRef.current = player
    setStatus('playing')
    setRepIndex(0)
    setRepCount(player.repCount)
    setPhase({ kind: 'running', skippedCount })

    await player.start()
    syncFromPlayer()
  }

  function handlePause(): void {
    playerRef.current?.pause()
    syncFromPlayer()
  }

  async function handleResume(): Promise<void> {
    setInterrupted(false)
    void acquireWakeLock?.()
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
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [phase.kind])

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
          {BLOCKED_COPY[phase.reason]}
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
        <p data-testid="drill-phrase-count">{phase.ready.length} phrases</p>
        {phase.skippedCount > 0 && (
          <p data-testid="drill-skipped-count" className="drill-skipped">
            {phase.skippedCount} phrase{phase.skippedCount === 1 ? '' : 's'} have no audio yet —
            skipped
          </p>
        )}
        <button
          type="button"
          data-testid="drill-start"
          className="btn-primary"
          onClick={() => void handleStart(phase.ready, phase.skippedCount)}
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
