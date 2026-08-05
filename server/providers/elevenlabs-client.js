import { withRetry } from '../retry.js'

const API_URL = 'https://api.elevenlabs.io/v1/text-to-speech'

/**
 * The output format requested from ElevenLabs, and the divisor the duration
 * estimate below assumes — kept side by side on purpose, so the two can never
 * drift apart silently (F6 audit, defect 1).
 *
 * `output_format=mp3_44100_128` is 128 kbps CBR MP3: 128,000 bits/s ÷ 8 =
 * 16,000 bytes/s = 16 bytes/ms. This used to be *unrequested* — `callOnce`
 * sent no `output_format` at all, and 16 bytes/ms only happened to be right
 * because it is ElevenLabs' documented default when the parameter is
 * omitted. A tier change, an account setting, or an API revision moving that
 * default would have silently made every clip's duration wrong, with nothing
 * to detect it. Asking for it by name makes the bitrate the estimate assumes
 * the bitrate that was actually requested — a contract, not a coincidence.
 *
 * **Not part of the Clip content address.** `computeClipHash`
 * (`../clip-hash.js`) is `provider|modelId|voiceId|lang|text` — the wire
 * format requested for one call is not the content being addressed, and
 * folding it in would orphan every clip already stored under the old hash.
 */
const OUTPUT_FORMAT = 'mp3_44100_128'
const MP3_BYTES_PER_MS_AT_128KBPS = 16 // must match OUTPUT_FORMAT above

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
          // 'network' covers both a transport failure reaching ElevenLabs and
          // a failure reading its response body (F6 audit, defect 3) — both
          // are transient by nature, unlike 'not-configured' (a bad key) or
          // an unrecognized non-ok status, neither of which a retry can fix.
          isRetryable: (err) => err.kind === 'quota' || err.kind === 'network',
        }),
      )
    },
  }
}

async function callOnce({ apiKey, fetchImpl, text, voiceId, modelId }) {
  let response
  try {
    response = await fetchImpl(`${API_URL}/${voiceId}?output_format=${OUTPUT_FORMAT}`, {
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

  // The read, not just the request, must be inside error handling (F6 audit,
  // defect 3): a mid-stream truncation surfaces here, after a response that
  // looked entirely fine at the HTTP level. Left outside, it used to reject
  // with no `.kind`, fall through `statusForProviderError`'s `default: 502`,
  // and never retry — though it is exactly the transient failure `withRetry`
  // exists for. Same 'network' kind as a transport failure above, so it gets
  // the same, now-retryable, treatment.
  let bytes
  try {
    bytes = Buffer.from(await response.arrayBuffer())
  } catch {
    throw providerError('network', 'network error reading ElevenLabs response body')
  }
  return { bytes, durationMs: Math.round(bytes.byteLength / MP3_BYTES_PER_MS_AT_128KBPS) }
}

function providerError(kind, message) {
  const err = new Error(message)
  err.kind = kind
  return err
}
