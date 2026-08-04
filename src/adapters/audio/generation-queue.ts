import type { Language, Phrase } from '../../domain'
import { computeClipHash, type ClipCache } from '../storage/clip-cache'
import type { Voice } from '../storage/settings-store'
import type { SynthClient, SynthError } from './server-synth-client'

/** Bounded automatic retries for a `network` failure before giving up.
 * "Never retry forever" (T019 §3) applies to every failure kind, not only
 * unauthorized/quota — a dead network is not distinguishable in advance from
 * a permanently unreachable one. */
const DEFAULT_MAX_ATTEMPTS = 3

/**
 * How many requests this device will have outstanding at once (T035).
 *
 * Four, matching `server/bounded-queue.js`'s ElevenLabs concurrency: there is
 * no point holding more connections open than the thing at the other end will
 * work on. Before this the queue held none back — a cold 1,000-Phrase library
 * issued 2,000 requests simultaneously, measured (`docs/scale.md` §2).
 */
const DEFAULT_MAX_CONCURRENT = 4

/**
 * How many times one Clip will wait out our own server's rate limit before
 * giving up (T035).
 *
 * Generous, because waiting is the correct answer and the wait is short — the
 * limiter refills one token per second, so fifty waits is a Clip that has
 * been losing races for the better part of a minute while others drained. It
 * exists at all because "never retry forever" applies here too: a limiter
 * stuck at zero (a second device sweeping the same session, say) must end the
 * sweep, not spin on it until the battery is flat.
 */
const DEFAULT_MAX_RATE_LIMIT_WAITS = 50

/**
 * The visible state of one Phrase's generation, combined across its two
 * Clips (worse of the two wins): `generating` while in flight, `ready` once
 * both Clips are cached, `unauthorized`/`quota` per `SynthError` (never
 * retried), `failed` once retries are exhausted — network retries or waits
 * on our own server's rate limit alike.
 *
 * There is deliberately no `rate-limited` state here. Being paced is not an
 * outcome: it is the queue working. A Phrase that is waiting its turn is
 * `generating`, which is what it is, and only a Phrase that ran out of turns
 * is `failed`.
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
  /** Requests in flight at once. Default 4. */
  readonly maxConcurrent?: number
  /** Waits on our own server's rate limit before one Clip gives up. Default 50. */
  readonly maxRateLimitWaits?: number
  /** The visible-state seam: called whenever a Phrase's combined status changes. */
  onStatusChange?(phraseId: string, status: GenerationStatus): void
  readonly now?: () => number
  /** The delay seam. Injected in tests so a half-hour drain can be driven in milliseconds. */
  sleep?(ms: number): Promise<void>
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
  /**
   * Resolves when nothing enqueued is still outstanding — already resolved if
   * nothing is.
   *
   * A bounded queue has an idle state whether or not anyone asks about it;
   * this exposes the one it already tracks rather than reaching inside for it.
   * Its present caller is the test suite, which needs a way to say "the sweep
   * has finished" that does not mean "N microtask turns have passed" — that
   * was a real race (T056), failing about one run in twelve, and adding
   * concurrency and backoff here would only have widened it.
   */
  whenIdle(): Promise<void>
}

/**
 * `SpeechPort`'s companion on the write side: turns a saved Phrase into two
 * cached Clips. Adapter-side per T019 §4 — the domain never sees this. Skips
 * a Clip already in the cache, dedupes concurrent requests for the same
 * content hash, bounds how many requests it has in flight, and never lets one
 * Phrase's failure affect another's.
 *
 * **How it treats our own server's rate limit (T035).** A 429 from this app's
 * server is not a failure of the Clip; it is the server saying "not yet", with
 * a `Retry-After`. So the whole queue holds off until that moment — not just
 * the request that hit it, because the limiter is per session and every other
 * request in flight would be refused for the same reason — and then carries
 * on. A provider quota exhaustion (402) stays terminal, because waiting does
 * not buy credits.
 */
export function createGenerationQueue(deps: GenerationQueueDeps): GenerationQueue {
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const maxRateLimitWaits = deps.maxRateLimitWaits ?? DEFAULT_MAX_RATE_LIMIT_WAITS
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const statuses = new Map<string, GenerationStatus>()
  const inFlightHashes = new Set<string>()
  const withSlot = createConcurrencyLimit(deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT)
  const idle = createIdleLatch()

  /** The moment the whole queue may talk to the server again — moved forward
   * by whichever request last learned it is being paced. */
  let resumeAt = 0

  function setStatus(phraseId: string, status: GenerationStatus): void {
    statuses.set(phraseId, status)
    deps.onStatusChange?.(phraseId, status)
  }

  async function waitOutRateLimit(): Promise<void> {
    const remaining = resumeAt - now()
    if (remaining > 0) await sleep(remaining)
  }

  /** One Clip, from the first request to a settled outcome. Holds a
   * concurrency slot for the whole of its retrying, so a paused queue really
   * is paused rather than letting the next Clip take its place and be refused
   * in turn. */
  async function requestClip(text: string, lang: Language, voice: Voice, hash: string): Promise<GenerationStatus> {
    let networkAttempts = 0
    let rateLimitWaits = 0

    for (;;) {
      await waitOutRateLimit()
      try {
        const result = await deps.synthClient.synthesize(text, lang, {
          provider: voice.provider,
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
        const error = err as SynthError
        if (error.kind === 'unauthorized') return { kind: 'unauthorized' }
        if (error.kind === 'quota') return { kind: 'quota' } // the provider is out of credits: waiting changes nothing
        if (error.kind === 'rate-limited') {
          if (rateLimitWaits >= maxRateLimitWaits) return { kind: 'failed' }
          rateLimitWaits++
          resumeAt = Math.max(resumeAt, now() + error.retryAfterMs)
          continue
        }
        // kind === 'network': retry, bounded — a dropped connection is
        // usually transient, but this must never become an unbounded loop.
        networkAttempts++
        if (networkAttempts >= maxAttempts) return { kind: 'failed' }
      }
    }
  }

  async function generateOne(text: string, lang: Language, voice: Voice): Promise<GenerationStatus> {
    const hash = await computeClipHash({
      provider: voice.provider,
      modelId: voice.modelId,
      voiceId: voice.voiceId,
      lang,
      text,
    })
    // Both checks stay outside the concurrency slot: a Clip already cached
    // costs no request, and making it queue behind four that do would turn a
    // warm library's sweep into a slow one for no reason.
    if (await deps.clipCache.has(hash)) return { kind: 'ready' }
    if (inFlightHashes.has(hash)) return { kind: 'generating' }

    inFlightHashes.add(hash)
    try {
      return await withSlot(() => requestClip(text, lang, voice, hash))
    } finally {
      inFlightHashes.delete(hash)
    }
  }

  return {
    enqueue(phrase) {
      idle.begin() // synchronous, so `whenIdle()` called straight after this already knows
      void (async () => {
        try {
          const voice = await deps.getVoice()
          if (!voice) return // no voice pinned: nothing to generate against, no default invented

          setStatus(phrase.id, { kind: 'generating' })
          const [french, english] = await Promise.all([
            generateOne(phrase.french, 'fr-FR', voice),
            generateOne(phrase.english, 'en-US', voice),
          ])
          setStatus(phrase.id, combine(french, english))
        } finally {
          idle.end()
        }
      })()
    },

    statusFor(phraseId) {
      return statuses.get(phraseId)
    },

    whenIdle: idle.whenIdle,
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

/** Runs at most `limit` tasks at once; the rest wait their turn. */
function createConcurrencyLimit(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: Array<() => void> = []

  return async function withSlot<T>(task: () => Promise<T>): Promise<T> {
    // `while`, not `if`: a woken waiter re-checks, because another caller can
    // take the freed slot in the turn between the wake and the resume.
    while (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve))
    active++
    try {
      return await task()
    } finally {
      active--
      waiting.shift()?.()
    }
  }
}

/** Counts outstanding work and lets callers await its reaching zero. */
function createIdleLatch(): { begin(): void; end(): void; whenIdle(): Promise<void> } {
  let outstanding = 0
  let waiting: Array<() => void> = []

  return {
    begin() {
      outstanding++
    },
    end() {
      outstanding--
      if (outstanding > 0) return
      const woken = waiting
      waiting = []
      for (const resolve of woken) resolve()
    },
    whenIdle() {
      if (outstanding === 0) return Promise.resolve()
      return new Promise<void>((resolve) => waiting.push(resolve))
    },
  }
}
