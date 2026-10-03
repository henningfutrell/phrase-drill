import type { Language } from '../../domain'

/**
 * The pinned voice, as read from settings (`SettingsStore.Voice`).
 * Passed in by the caller rather than read from settings here: the caller
 * (the clip cache) already needs the voice to build its content-address, so
 * this module stays a pure "given these bytes, hit the endpoint" seam with
 * no settings access of its own.
 *
 * `provider` is carried again as of T063. It used to be dropped here — the
 * ElevenLabs call has no use for it — but the server now derives the shared
 * Clip store's content address from the same five fields the device does,
 * and `provider` is one of them.
 */
export interface SynthVoice {
  readonly provider: string
  readonly modelId: string
  readonly voiceId: string
}

export interface SynthResult {
  readonly bytes: ArrayBuffer
  readonly durationMs: number
}

/**
 * Why a synth call could not produce a Clip.
 *
 * `rate-limited` and `quota` are the two that look alike and are not (T035):
 *
 * - **`rate-limited`** is *this app's own server* pacing us — HTTP 429 with
 *   `Retry-After`. It is a queue, not a wall: the only remedy is to wait the
 *   time it names and ask again, and the caller that gives up instead throws
 *   away work that would have succeeded a second later.
 * - **`quota`** is the *provider* out of credits — HTTP 402. No amount of
 *   waiting fixes it; somebody has to pay. Terminal, and never retried.
 *
 * Collapsing them (both were 429 before) is what marked ~1,940 Phrases of a
 * cold 1,000-Phrase library permanently failed on the first sweep.
 *
 * **`queued`** is HTTP 202: the server accepted the request and is still
 * generating. Neither failure nor audio — ask the same POST again after
 * `retryAfterMs`. Unlike `rate-limited` it speaks for this one request only,
 * so the caller must not make the rest of the queue wait for it.
 *
 * **`unreadable`** is HTTP 422, and terminal like `quota`: the provider
 * produced something unusable, or this phrase hit the server's billing cap
 * for 24 h. Asking again only spends money or is refused, so it is never
 * retried. It is not `network` (which is retried) because it is an answer,
 * not a failure to get one.
 */
export type SynthError =
  | { kind: 'unauthorized' }
  | { kind: 'rate-limited'; retryAfterMs: number }
  | { kind: 'quota' }
  | { kind: 'queued'; retryAfterMs: number }
  | { kind: 'unreadable' }
  | { kind: 'network'; detail: string }

/** Used when a 429 carries no usable `Retry-After`. One second is the
 * smallest wait worth taking; the server always sends the header, so this is
 * the answer to a proxy having eaten it, not the normal path. */
const DEFAULT_RETRY_AFTER_MS = 1000

/** However long a `Retry-After` claims, the sweep is not parked longer than
 * this. A minute is already far past anything this server's limiter can ask
 * for (60 per 60s is one token per second), so a larger number is a bug or a
 * middlebox, not an instruction worth honouring. */
const MAX_RETRY_AFTER_MS = 60_000

/** Used when a 202 carries no usable `Retry-After`. Five seconds is what the
 * server sends; generation takes seconds, so a shorter guess only re-asks
 * before there is anything to find. */
const DEFAULT_QUEUED_RETRY_AFTER_MS = 5000

export interface SynthClient {
  /** Synthesize `text` (in `lang`) with the given voice. Resolves to MP3 bytes and an estimated duration. */
  synthesize(text: string, lang: Language, voice: SynthVoice, signal?: AbortSignal): Promise<SynthResult>
}

export interface ServerSynthClientDeps {
  /** Reads the current session token from wherever it is stored (T050 — never a provider key). */
  getAccessToken(): Promise<string>
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/**
 * The `SynthClient` implementation for T041: talks to this app's own
 * `/api/tts`, same-origin, authenticated with a session token (T050,
 * `Authorization: Bearer <token>`) — never an ElevenLabs key, which the
 * device no longer holds at all. Replaces
 * `eleven-labs-synth-client.ts` as the sole thing `generation-queue.ts` and
 * the composition root depend on; nothing downstream of the `SynthClient`
 * port needed to change to make this swap (`docs/design.md`,
 * `generation-queue.ts`, `drill-readiness.ts`, `clip-player.ts` are all
 * untouched).
 *
 * `lang` goes on the wire as of T063. The ElevenLabs call still does not
 * need it, but the server derives the shared Clip store's content address
 * from `provider|modelId|voiceId|lang|text` — the exact material
 * `clip-cache.ts` uses — and cannot name the clip this device is asking for
 * without every field of it.
 */
export function createServerSynthClient(deps: ServerSynthClientDeps): SynthClient {
  const fetchImpl = deps.fetchImpl ?? fetch

  return {
    async synthesize(text, lang, voice, signal) {
      const accessToken = await deps.getAccessToken()

      let response: Response
      try {
        response = await fetchImpl('/api/tts', {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ text, voiceId: voice.voiceId, modelId: voice.modelId, provider: voice.provider, lang }),
        })
      } catch (err) {
        return Promise.reject(networkError(describe(err)))
      }

      if (response.status === 401 || response.status === 503) {
        return Promise.reject(unauthorized())
      }

      if (response.status === 202) {
        return Promise.reject(queued(response.headers.get('retry-after')))
      }

      if (response.status === 429) {
        return Promise.reject(rateLimited(response.headers.get('retry-after')))
      }

      if (response.status === 402) {
        return Promise.reject(quota())
      }

      if (response.status === 422) {
        return Promise.reject(unreadable())
      }

      if (!response.ok) {
        return Promise.reject(networkError(`server responded ${response.status}`))
      }

      const durationHeader = response.headers.get('x-duration-ms')
      const bytes = await response.arrayBuffer()
      const durationMs = durationHeader !== null ? Number(durationHeader) : NaN
      return { bytes, durationMs: Number.isFinite(durationMs) ? durationMs : 0 }
    },
  }
}

function unauthorized(): SynthError {
  return { kind: 'unauthorized' }
}

function quota(): SynthError {
  return { kind: 'quota' }
}

function unreadable(): SynthError {
  return { kind: 'unreadable' }
}

/** `Retry-After` is seconds (RFC 9110). Anything unparsable, zero, or
 * negative falls back rather than being trusted; anything absurd is capped. */
function rateLimited(header: string | null): SynthError {
  return { kind: 'rate-limited', retryAfterMs: parseRetryAfterMs(header, DEFAULT_RETRY_AFTER_MS) }
}

/** Same parsing as `rateLimited`, for a 202: a different default, the same cap. */
function queued(header: string | null): SynthError {
  return { kind: 'queued', retryAfterMs: parseRetryAfterMs(header, DEFAULT_QUEUED_RETRY_AFTER_MS) }
}

function parseRetryAfterMs(header: string | null, fallbackMs: number): number {
  const seconds = header === null ? NaN : Number(header)
  const requested = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallbackMs
  return Math.min(requested, MAX_RETRY_AFTER_MS)
}

function networkError(detail: string): SynthError {
  return { kind: 'network', detail }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
