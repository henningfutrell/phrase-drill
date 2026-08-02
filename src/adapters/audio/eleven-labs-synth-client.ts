import type { Language } from '../../domain'

const API_URL = 'https://api.elevenlabs.io/v1/text-to-speech'

/**
 * MP3 bytes per millisecond at ElevenLabs' default output format
 * (`mp3_44100_128`, 128 kbps, undocumented in the response — verified
 * 2026-08-02: a ~36 KB response for a short French phrase). 128 kbps =
 * 16,000 bytes/s = 16 bytes/ms.
 */
const MP3_BYTES_PER_MS_AT_128KBPS = 16

/**
 * The pinned voice, as read from settings (`SettingsStore.Voice`, minus the
 * `provider` field this module has no use for — it always speaks
 * ElevenLabs). Passed in by the caller rather than read from settings here:
 * the caller (the clip cache, later) already needs the voice to build its
 * content-address, so this module stays a pure "given these bytes, hit the
 * API" seam with no settings access of its own beyond the key.
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
 * "ask Henning" vocabulary across both provider adapters. `quota` replaces
 * `ScanError`'s `unreadable` — there is no analogous "response made no
 * sense" case here; a bad response is a `network` failure instead.
 */
export type SynthError = { kind: 'unauthorized' } | { kind: 'quota' } | { kind: 'network'; detail: string }

export interface SynthClient {
  /** Synthesize `text` (in `lang`) with the given voice. Resolves to MP3 bytes and an estimated duration. */
  synthesize(text: string, lang: Language, voice: SynthVoice, signal?: AbortSignal): Promise<SynthResult>
}

export interface ElevenLabsSynthClientDeps {
  /** Reads the ElevenLabs API key from wherever it is stored. Null when absent. */
  getApiKey(): Promise<string | null>
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/**
 * The ElevenLabs adapter for `SynthClient`. The only module in the codebase
 * that names ElevenLabs, its endpoint shape, or its header/error format —
 * the swap seam T019 §6 R5 calls for. If the provider ever changes (Google
 * Chirp 3: HD is the recorded runner-up), this file is the only one that
 * changes.
 *
 * `lang` is accepted for interface symmetry with the vision adapter and
 * because a future multi-language build may need it (ElevenLabs'
 * multilingual model infers language from the text itself today, so it is
 * not sent).
 */
export function createElevenLabsSynthClient(deps: ElevenLabsSynthClientDeps): SynthClient {
  const fetchImpl = deps.fetchImpl ?? fetch

  return {
    async synthesize(text, _lang, voice, signal) {
      const apiKey = await deps.getApiKey()
      if (!apiKey) {
        return Promise.reject(unauthorized())
      }

      let response: Response
      try {
        response = await fetchImpl(`${API_URL}/${voice.voiceId}`, {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            'xi-api-key': apiKey,
          },
          body: JSON.stringify({ text, model_id: voice.modelId }),
        })
      } catch (err) {
        return Promise.reject(networkError(describe(err)))
      }

      if (response.status === 401 || response.status === 403) {
        return Promise.reject(unauthorized())
      }

      if (response.status === 429) {
        return Promise.reject(quota())
      }

      if (!response.ok) {
        return Promise.reject(networkError(`ElevenLabs API responded ${response.status}`))
      }

      const bytes = await response.arrayBuffer()
      return { bytes, durationMs: Math.round(bytes.byteLength / MP3_BYTES_PER_MS_AT_128KBPS) }
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
