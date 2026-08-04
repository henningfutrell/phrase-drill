import type { Phrase, Voice } from '../../domain'
import type { ClipCache } from '../storage/clip-cache'
import type { GenerationQueue } from './generation-queue'
import { knownVoices } from './voice-catalogue'

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
  /**
   * Whether there was a network when this sweep ran. Carried because since
   * T036 a Clip can be *evicted*, so "this Phrase has no audio" is no longer
   * always "it is being made right now" — offline it means "it was thrown
   * away and cannot come back until there is a connection", and a screen that
   * says the first when the second is true leaves her waiting on nothing.
   */
  readonly online: boolean
}

export interface DrillReadinessDeps {
  readonly clipCache: ClipCache
  readonly generationQueue: GenerationQueue
  /**
   * The pinned voice, or `null` if the owner hasn't chosen one yet — a real
   * state (T024), never defaulted. It decides what an unready Phrase is
   * GENERATED in, and nothing else (T067): readiness is asked over every
   * voice a Clip could be in, so re-pinning cannot make cached audio unready.
   */
  readonly voice: Voice | null
  /** Defaults to `navigator.onLine`. Missing clips are queued only when online. */
  isOnline?(): boolean
}

/**
 * The drill-start readiness sweep (T019 §3): asks which Phrases already have
 * both Clips in ANY voice they could have been generated in (T067), queues
 * generation for the rest — in the pinned voice — when online, and excludes everything not ready from this run. This is the
 * enforcement behind the domain's contract — "every Phrase given to
 * `createDrillPlayer` is playable" — so its `ready` array is exactly what a
 * caller must pass to `createDrillPlayer`. Lives adapter-side, not as a
 * domain port, per T019 §4.
 */
export async function computeDrillReadiness(
  phrases: readonly Phrase[],
  deps: DrillReadinessDeps,
): Promise<DrillReadiness> {
  const isOnline = deps.isOnline ? deps.isOnline() : defaultIsOnline()

  if (!deps.voice) {
    // Nothing to ask the cache about, and nothing to queue: a Phrase can't
    // be content-addressed without a voice, and no default is invented.
    return {
      ready: [],
      skippedCount: phrases.length,
      canStart: false,
      reason: 'no-voice',
      online: isOnline,
    }
  }

  // Every voice a Clip could be in, pinned first (T067). Asking only about
  // the pinned voice is what used to report a fully-generated library as
  // entirely unready the moment she changed her mind, and enqueue all of it.
  const readyIds = await deps.clipCache.readyPhraseIds(phrases, knownVoices(deps.voice))
  const ready = phrases.filter((phrase) => readyIds.has(phrase.id))
  const unready = phrases.filter((phrase) => !readyIds.has(phrase.id))

  if (isOnline) {
    for (const phrase of unready) deps.generationQueue.enqueue(phrase)
  }

  return {
    ready,
    skippedCount: unready.length,
    canStart: ready.length > 0,
    reason: ready.length === 0 ? 'none-ready' : undefined,
    online: isOnline,
  }
}

function defaultIsOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine
}
