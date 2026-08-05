import type { Phrase, Voice } from '../../domain'
import { findCachedClipHash, type ClipCache } from '../storage/clip-cache'
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
    // Still releases whatever an earlier drill protected (T016) — a run that
    // cannot start protects nothing.
    deps.clipCache.protect?.(new Set())
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
  const voices = knownVoices(deps.voice)
  const readyIds = await deps.clipCache.readyPhraseIds(phrases, voices)
  const ready = phrases.filter((phrase) => readyIds.has(phrase.id))
  const unready = phrases.filter((phrase) => !readyIds.has(phrase.id))

  if (isOnline) {
    for (const phrase of unready) deps.generationQueue.enqueue(phrase)
  }

  // T016 — the defect this sweep itself creates: it queues generation for
  // every unready Phrase for the length of the run, and every generated
  // Clip's `put()` can evict LRU-first. `has()` (just asked, above) does not
  // count as play, so a ready Phrase the run has not reached yet can carry a
  // stale `lastUsedAt` and be evicted out from under a drill that still needs
  // it. This is the one place that knows the run's exact working set —
  // exactly the Phrases in `ready`, in the voice each one actually has a
  // Clip in — so it hands that set to the cache rather than adding a
  // parameter `App.tsx` would have to thread through screens that never
  // otherwise touch the cache.
  await protectWorkingSet(ready, voices, deps.clipCache)

  return {
    ready,
    skippedCount: unready.length,
    canStart: ready.length > 0,
    reason: ready.length === 0 ? 'none-ready' : undefined,
    online: isOnline,
  }
}

/**
 * Resolves each ready Phrase's actual cached hash (fr and en, in whichever
 * offered voice it is really in) and hands the set to `clipCache.protect()`.
 * A no-op when the cache does not offer `protect()` — optional on the port
 * so older fakes and any cache that chooses not to protect stay valid.
 */
async function protectWorkingSet(ready: readonly Phrase[], voices: readonly Voice[], clipCache: ClipCache): Promise<void> {
  if (!clipCache.protect) return
  const has = (hash: string): Promise<boolean> => clipCache.has(hash)
  const hashes = new Set<string>()
  for (const phrase of ready) {
    const [french, english] = await Promise.all([
      findCachedClipHash(has, voices, 'fr-FR', phrase.french),
      findCachedClipHash(has, voices, 'en-US', phrase.english),
    ])
    if (french) hashes.add(french)
    if (english) hashes.add(english)
  }
  clipCache.protect(hashes)
}

function defaultIsOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine
}
