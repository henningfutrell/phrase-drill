import type { Language, Phrase } from '../../domain'
import { computeClipHash, type ClipCache } from '../storage/clip-cache'
import type { Voice } from '../storage/settings-store'
import type { SynthClient, SynthError } from './eleven-labs-synth-client'

/** Bounded automatic retries for a `network` failure before giving up.
 * "Never retry forever" (T019 §3) applies to every failure kind, not only
 * unauthorized/quota — a dead network is not distinguishable in advance from
 * a permanently unreachable one. */
const DEFAULT_MAX_ATTEMPTS = 3

/**
 * The visible state of one Phrase's generation, combined across its two
 * Clips (worse of the two wins): `generating` while in flight, `ready` once
 * both Clips are cached, `unauthorized`/`quota` per `SynthError` (never
 * retried), `failed` once `network` retries are exhausted.
 */
export type GenerationStatus =
  | { kind: 'generating' }
  | { kind: 'ready' }
  | { kind: 'unauthorized' }
  | { kind: 'quota' }
  | { kind: 'failed' }

export interface GenerationQueueDeps {
  readonly synthClient: SynthClient
  readonly clipCache: ClipCache
  /**
   * Read fresh on every `enqueue()` rather than captured once — the pinned
   * voice can change (T026), and a stale voice would content-address clips
   * against a voice nobody chose. `null` means no voice is pinned yet: there
   * is nothing to generate against and no default is invented (T024), so
   * `enqueue` becomes a no-op.
   */
  getVoice(): Promise<Voice | null>
  /** Total attempts (including the first) before a `network` failure gives up. Default 3. */
  readonly maxAttempts?: number
  /** The visible-state seam: called whenever a Phrase's combined status changes. */
  onStatusChange?(phraseId: string, status: GenerationStatus): void
  readonly now?: () => number
}

export interface GenerationQueue {
  /**
   * Queue both Clips (French, English) for a Phrase in the background.
   * Synchronous and never throws — a Phrase's text is saved by the caller
   * before or independent of this call, never gated on it.
   */
  enqueue(phrase: Pick<Phrase, 'id' | 'french' | 'english'>): void
  /** The last known combined status for a Phrase, or `undefined` if it was
   * never queued (including: no voice was pinned when it was). */
  statusFor(phraseId: string): GenerationStatus | undefined
}

/**
 * `SpeechPort`'s companion on the write side: turns a saved Phrase into two
 * cached Clips. Adapter-side per T019 §4 — the domain never sees this. Skips
 * a Clip already in the cache, dedupes concurrent requests for the same
 * content hash, and never lets one Phrase's failure affect another's.
 */
export function createGenerationQueue(deps: GenerationQueueDeps): GenerationQueue {
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const now = deps.now ?? Date.now
  const statuses = new Map<string, GenerationStatus>()
  const inFlightHashes = new Set<string>()

  function setStatus(phraseId: string, status: GenerationStatus): void {
    statuses.set(phraseId, status)
    deps.onStatusChange?.(phraseId, status)
  }

  async function generateOne(text: string, lang: Language, voice: Voice): Promise<GenerationStatus> {
    const hash = await computeClipHash({
      provider: voice.provider,
      modelId: voice.modelId,
      voiceId: voice.voiceId,
      lang,
      text,
    })
    if (await deps.clipCache.has(hash)) return { kind: 'ready' }
    if (inFlightHashes.has(hash)) return { kind: 'generating' }

    inFlightHashes.add(hash)
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          const result = await deps.synthClient.synthesize(text, lang, {
            modelId: voice.modelId,
            voiceId: voice.voiceId,
          })
          await deps.clipCache.put({
            hash,
            bytes: result.bytes,
            mime: 'audio/mpeg',
            durationMs: result.durationMs,
            createdAt: now(),
          })
          return { kind: 'ready' }
        } catch (err) {
          const kind = (err as SynthError).kind
          if (kind === 'unauthorized') return { kind: 'unauthorized' }
          if (kind === 'quota') return { kind: 'quota' }
          // kind === 'network': retry, bounded — a dropped connection is
          // usually transient, but this must never become an unbounded loop.
          if (attempt >= maxAttempts) return { kind: 'failed' }
        }
      }
    } finally {
      inFlightHashes.delete(hash)
    }
  }

  return {
    enqueue(phrase) {
      void (async () => {
        const voice = await deps.getVoice()
        if (!voice) return // no voice pinned: nothing to generate against, no default invented

        setStatus(phrase.id, { kind: 'generating' })
        const [french, english] = await Promise.all([
          generateOne(phrase.french, 'fr-FR', voice),
          generateOne(phrase.english, 'en-US', voice),
        ])
        setStatus(phrase.id, combine(french, english))
      })()
    },

    statusFor(phraseId) {
      return statuses.get(phraseId)
    },
  }
}

/** The worse of two Clip outcomes wins the Phrase's combined status. */
function combine(a: GenerationStatus, b: GenerationStatus): GenerationStatus {
  if (a.kind === 'unauthorized' || b.kind === 'unauthorized') return { kind: 'unauthorized' }
  if (a.kind === 'quota' || b.kind === 'quota') return { kind: 'quota' }
  if (a.kind === 'failed' || b.kind === 'failed') return { kind: 'failed' }
  if (a.kind === 'ready' && b.kind === 'ready') return { kind: 'ready' }
  return { kind: 'generating' }
}
