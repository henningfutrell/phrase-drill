import type { Language } from '../../domain'

/**
 * The pinned voice, as read from settings (`SettingsStore.Voice`, minus the
 * `provider` field this module has no use for — it always speaks through
 * this server's `/api/tts`, which is itself ElevenLabs-backed today).
 * Passed in by the caller rather than read from settings here: the caller
 * (the clip cache, later) already needs the voice to build its
 * content-address, so this module stays a pure "given these bytes, hit the
 * endpoint" seam with no settings access of its own.
 */
export interface SynthVoice {
  readonly modelId: string
  readonly voiceId: string
}

export interface SynthResult {
  readonly bytes: ArrayBuffer
  readonly durationMs: number
}

/**
 * Why a synth call could not produce a Clip. Shaped exactly like
 * `ScanError` (`unauthorized` / network-ish failure) so the UI has one
 * "ask Henning" vocabulary across both provider-backed adapters. `quota`
 * replaces `ScanError`'s `unreadable` — there is no analogous "response made
 * no sense" case here; a bad response is a `network` failure instead.
 */
export type SynthError = { kind: 'unauthorized' } | { kind: 'quota' } | { kind: 'network'; detail: string }

export interface SynthClient {
  /** Synthesize `text` (in `lang`) with the given voice. Resolves to MP3 bytes and an estimated duration. */
  synthesize(text: string, lang: Language, voice: SynthVoice, signal?: AbortSignal): Promise<SynthResult>
}

export interface ServerSynthClientDeps {
  /** Reads the device's library key from wherever it is stored (T041 — never a provider key). */
  getLibraryKey(): Promise<string>
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/**
 * The `SynthClient` implementation for T041: talks to this app's own
 * `/api/tts`, same-origin, authenticated with the device's library key
 * (`Authorization: Bearer <key>`) — never an ElevenLabs key, which the
 * device no longer holds at all. Replaces
 * `eleven-labs-synth-client.ts` as the sole thing `generation-queue.ts` and
 * the composition root depend on; nothing downstream of the `SynthClient`
 * port needed to change to make this swap (`docs/design.md`,
 * `generation-queue.ts`, `drill-readiness.ts`, `clip-player.ts` are all
 * untouched).
 *
 * `lang` is accepted for interface symmetry with the vision adapter — the
 * server-side ElevenLabs call still doesn't need it (see the provider's own
 * comment for why).
 */
export function createServerSynthClient(deps: ServerSynthClientDeps): SynthClient {
  const fetchImpl = deps.fetchImpl ?? fetch

  return {
    async synthesize(text, _lang, voice, signal) {
      const libraryKey = await deps.getLibraryKey()

      let response: Response
      try {
        response = await fetchImpl('/api/tts', {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${libraryKey}`,
          },
          body: JSON.stringify({ text, voiceId: voice.voiceId, modelId: voice.modelId }),
        })
      } catch (err) {
        return Promise.reject(networkError(describe(err)))
      }

      if (response.status === 401 || response.status === 503) {
        return Promise.reject(unauthorized())
      }

      if (response.status === 429) {
        return Promise.reject(quota())
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

function networkError(detail: string): SynthError {
  return { kind: 'network', detail }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
