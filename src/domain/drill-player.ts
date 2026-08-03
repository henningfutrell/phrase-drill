import { buildRep, type Rep } from './rep'
import { runStep, type StepPorts } from './step-runner'
import { shuffle, type RandomSource } from './shuffle'
import type { Phrase } from './phrase'

export type DrillStatus = 'playing' | 'paused' | 'stopped'

export type DrillPlayerPorts = StepPorts

export interface DrillPlayerOptions {
  /** Applies Shuffle at Drill start when given; author order otherwise. */
  readonly random?: RandomSource
}

/**
 * The Drill state machine: an ordered sequence of Reps over a snapshot of
 * Phrases, with position and playing/paused/stopped state. In-memory only —
 * discarded when the run ends.
 */
export interface DrillPlayer {
  readonly status: DrillStatus
  readonly position: number
  readonly repCount: number
  start(): Promise<void>
  pause(): void
  resume(): Promise<void>
  /** Skip to the next Phrase, cancelling whatever step is in flight. */
  skip(): Promise<void>
  stop(): void
}

/**
 * Creates a Drill over a snapshot of `phrases` — later edits to the source
 * (e.g. the Deck it came from) never reach a running Drill. Optionally
 * shuffled at this point, per the injected randomness source.
 */
export function createDrillPlayer(
  phrases: readonly Phrase[],
  ports: DrillPlayerPorts,
  options: DrillPlayerOptions = {},
): DrillPlayer {
  return new DrillPlayerEngine(phrases, ports, options)
}

class DrillPlayerEngine implements DrillPlayer {
  private readonly reps: readonly Rep[]
  private _status: DrillStatus = 'stopped'
  private repIndex = 0
  private stepIndex = 0
  private generation = 0
  private running = false
  private stepAbort: AbortController | null = null
  private readonly ports: DrillPlayerPorts

  constructor(
    phrases: readonly Phrase[],
    ports: DrillPlayerPorts,
    options: DrillPlayerOptions,
  ) {
    this.ports = ports
    const snapshot = options.random
      ? shuffle(phrases, options.random)
      : [...phrases]
    this.reps = snapshot.map(buildRep)
  }

  get status(): DrillStatus {
    return this._status
  }

  get position(): number {
    return this.repIndex
  }

  get repCount(): number {
    return this.reps.length
  }

  async start(): Promise<void> {
    if (this._status !== 'stopped') return
    this._status = 'playing'
    await this.runLoop()
  }

  pause(): void {
    if (this._status !== 'playing') return
    this._status = 'paused'
    // Stryker disable next-line OptionalChaining: unreachable null — reaching
    // this line requires _status === 'playing', which (see runLoop) is only
    // ever true synchronously alongside a just-assigned, non-null stepAbort.
    this.stepAbort?.abort()
  }

  async resume(): Promise<void> {
    if (this._status !== 'paused') return
    this._status = 'playing'
    await this.runLoop()
  }

  async skip(): Promise<void> {
    if (this._status === 'stopped') return
    // Stryker disable next-line ConditionalExpression,StringLiteral,EqualityOperator:
    // wasPlaying's only reader is the runLoop() call below, which is itself a
    // no-op whenever this value would matter (see that disable comment) —
    // no test can observe wasPlaying taking any value other than its true one.
    const wasPlaying = this._status === 'playing'
    // Stryker disable next-line AssignmentOperator: generation is read only via
    // equality against a snapshot (line ~130) — any nonzero, monotonic change
    // (+1 or -1) is indistinguishable through that check.
    this.generation += 1
    this.stepAbort?.abort()
    this.repIndex += 1
    this.stepIndex = 0
    if (this.repIndex >= this.reps.length) {
      this._status = 'stopped'
      return
    }
    // Stryker disable next-line ConditionalExpression: whenever wasPlaying is
    // true here, runLoop's own `running` flag is already true (status
    // 'playing' is only ever set immediately before running=true, with no
    // yield point between), so this call is always a no-op via that guard;
    // whenever wasPlaying is false, status here isn't 'playing', so the call
    // is also a no-op via runLoop's own while-condition. Neither branch is
    // observable.
    if (wasPlaying) await this.runLoop()
  }

  stop(): void {
    this._status = 'stopped'
    // Stryker disable next-line AssignmentOperator: see the identical
    // reasoning on skip()'s `generation += 1` above.
    this.generation += 1
    // Unlike pause()/skip(), stop() has no status guard, so stepAbort really
    // can be null here (e.g. calling stop() before any start(), or after a
    // Drill has already run to completion) — this optional chain is
    // load-bearing, covered by "stop() before start() and after natural
    // completion does not throw".
    this.stepAbort?.abort()
  }

  /** Walks Steps from the current position while playing. Re-entrancy-safe. */
  private async runLoop(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      // Stryker disable next-line ConditionalExpression: the `_status ===
      // 'playing'` clause is re-checked at the top of every iteration after
      // this one, but the loop body's own `if (this._status !== 'playing')
      // break` (below) already breaks out before looping back whenever that
      // would be false — so by the time this condition is re-evaluated,
      // status is always already 'playing'. The clause only ever matters on
      // the very first entry, which is always true (start()/resume() set
      // 'playing' immediately before calling runLoop(), synchronously).
      while (this._status === 'playing' && this.repIndex < this.reps.length) {
        const generationAtStart = this.generation
        const step = this.reps[this.repIndex].cadence[this.stepIndex]
        this.stepAbort = new AbortController()
        await runStep(step, this.ports, this.stepAbort.signal)
        this.stepAbort = null
        if (this._status !== 'playing') break
        // Skip already moved the position for this generation — don't double-advance.
        if (this.generation === generationAtStart) this.advanceStep()
      }
      // Stryker disable next-line ConditionalExpression,LogicalOperator: the
      // loop above can only exit here in one of two ways — the while
      // condition went false (which, given the above, only happens because
      // repIndex >= length, with status still 'playing'), or the `break`
      // fired (status !== 'playing', and repIndex is provably < length,
      // since advanceStep() and the loop-condition recheck that could push it
      // to length happen in the same synchronous stretch as the break check,
      // with no yield an external call could land in between). Either way,
      // `status === 'playing'` and `repIndex >= length` already agree, so
      // every mutation of this condition observed here decides nothing.
      if (this._status === 'playing' && this.repIndex >= this.reps.length) {
        this._status = 'stopped'
      }
    } finally {
      this.running = false
    }
  }

  private advanceStep(): void {
    const rep = this.reps[this.repIndex]
    this.stepIndex += 1
    if (this.stepIndex >= rep.cadence.length) {
      this.stepIndex = 0
      this.repIndex += 1
    }
  }
}
