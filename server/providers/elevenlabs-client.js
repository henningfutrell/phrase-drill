import { withRetry } from '../retry.js'

const API_URL = 'https://api.elevenlabs.io/v1/text-to-speech'

/**
 * MP3 bytes per millisecond at ElevenLabs' default output format
 * (128 kbps = 16,000 bytes/s = 16 bytes/ms) — the same estimate the device
 * adapter used to make; it moves here with the call itself.
 */
const MP3_BYTES_PER_MS_AT_128KBPS = 16

/**
 * The only module that holds `ELEVENLABS_API_KEY` or names ElevenLabs'
 * endpoint shape — the server-side swap seam, same discipline the device
 * adapter it replaces (`src/adapters/audio/eleven-labs-synth-client.ts`)
 * used to keep. Every call goes through `queue` (a bounded-concurrency
 * limiter, T041's fix for the "2n simultaneous calls" defect in
 * `docs/scale.md`) and retries a 429 with backoff instead of failing it
 * permanently on the first attempt (the other defect that doc names).
 */
export function createElevenLabsProvider({ apiKey, fetchImpl = fetch, queue, retries = 2, backoffMs = 500 }) {
  return {
    async synthesize({ text, voiceId, modelId }) {
      if (!apiKey) throw providerError('not-configured', 'ELEVENLABS_API_KEY is not set')

      return queue.run(() =>
        withRetry(() => callOnce({ apiKey, fetchImpl, text, voiceId, modelId }), {
          retries,
          baseMs: backoffMs,
          isRetryable: (err) => err.kind === 'quota',
        }),
      )
    },
  }
}

async function callOnce({ apiKey, fetchImpl, text, voiceId, modelId }) {
  let response
  try {
    response = await fetchImpl(`${API_URL}/${voiceId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'xi-api-key': apiKey },
      body: JSON.stringify({ text, model_id: modelId }),
    })
  } catch {
    throw providerError('network', 'network error contacting ElevenLabs')
  }

  if (response.status === 401 || response.status === 403) {
    throw providerError('not-configured', 'ElevenLabs rejected the configured key')
  }
  if (response.status === 429) {
    throw providerError('quota', 'ElevenLabs rate limit')
  }
  if (!response.ok) {
    throw providerError('network', `ElevenLabs responded ${response.status}`)
  }

  const bytes = Buffer.from(await response.arrayBuffer())
  return { bytes, durationMs: Math.round(bytes.byteLength / MP3_BYTES_PER_MS_AT_128KBPS) }
}

function providerError(kind, message) {
  const err = new Error(message)
  err.kind = kind
  return err
}
