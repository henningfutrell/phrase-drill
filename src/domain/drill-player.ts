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
    this.stepAbort?.abort()
  }

  async resume(): Promise<void> {
    if (this._status !== 'paused') return
    this._status = 'playing'
    await this.runLoop()
  }

  async skip(): Promise<void> {
    if (this._status === 'stopped') return
    const wasPlaying = this._status === 'playing'
    this.generation += 1
    this.stepAbort?.abort()
    this.repIndex += 1
    this.stepIndex = 0
    if (this.repIndex >= this.reps.length) {
      this._status = 'stopped'
      return
    }
    if (wasPlaying) await this.runLoop()
  }

  stop(): void {
    this._status = 'stopped'
    this.generation += 1
    this.stepAbort?.abort()
  }

  /** Walks Steps from the current position while playing. Re-entrancy-safe. */
  private async runLoop(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
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
