import type { Phrase } from '../../domain'
import type { ClipCache } from '../storage/clip-cache'
import type { Voice } from '../storage/settings-store'
import type { GenerationQueue } from './generation-queue'

/** Why a Drill cannot start, or why it is starting smaller than the Deck it came from. */
export type DrillReadinessReason = 'no-voice' | 'none-ready'

export interface DrillReadiness {
  /** The Phrases this Drill may run over — every one already has both Clips cached. */
  readonly ready: readonly Phrase[]
  /** How many Phrases were excluded — the count the drill screen states plainly (T019 §3). */
  readonly skippedCount: number
  /** `false` means the Drill cannot start at all; `reason` says why. */
  readonly canStart: boolean
  readonly reason?: DrillReadinessReason
}

export interface DrillReadinessDeps {
  readonly clipCache: ClipCache
  readonly generationQueue: GenerationQueue
  /** The pinned voice, or `null` if the owner hasn't chosen one yet — a real
   * state (T024), never defaulted. */
  readonly voice: Voice | null
  /** Defaults to `navigator.onLine`. Missing clips are queued only when online. */
  isOnline?(): boolean
}

/**
 * The drill-start readiness sweep (T019 §3): asks which Phrases already have
 * both Clips under the pinned voice, queues generation for the rest when
 * online, and excludes everything not ready from this run. This is the
 * enforcement behind the domain's contract — "every Phrase given to
 * `createDrillPlayer` is playable" — so its `ready` array is exactly what a
 * caller must pass to `createDrillPlayer`. Lives adapter-side, not as a
 * domain port, per T019 §4.
 */
export async function computeDrillReadiness(
  phrases: readonly Phrase[],
  deps: DrillReadinessDeps,
): Promise<DrillReadiness> {
  if (!deps.voice) {
    // Nothing to ask the cache about, and nothing to queue: a Phrase can't
    // be content-addressed without a voice, and no default is invented.
    return { ready: [], skippedCount: phrases.length, canStart: false, reason: 'no-voice' }
  }

  const readyIds = await deps.clipCache.readyPhraseIds(phrases, deps.voice)
  const ready = phrases.filter((phrase) => readyIds.has(phrase.id))
  const unready = phrases.filter((phrase) => !readyIds.has(phrase.id))

  const isOnline = deps.isOnline ? deps.isOnline() : defaultIsOnline()
  if (isOnline) {
    for (const phrase of unready) deps.generationQueue.enqueue(phrase)
  }

  return {
    ready,
    skippedCount: unready.length,
    canStart: ready.length > 0,
    reason: ready.length === 0 ? 'none-ready' : undefined,
  }
}

function defaultIsOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine
}
