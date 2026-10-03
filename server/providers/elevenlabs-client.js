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
 * What `probe()` sends: one character, in the pinned model, to a voice from
 * the app's own catalogue (`src/adapters/audio/voice-catalogue.ts` — Rachel).
 * A probe has to go down the paid path to be worth anything, so it is made
 * as small as a paid call can be. The voice matters only in that it must
 * exist; nothing keys a Clip off a probe.
 */
const PROBE_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'
const PROBE_MODEL_ID = 'eleven_multilingual_v2'
const PROBE_TEXT = '.'

/**
 * How long one synthesis attempt may take, connect to last body byte. An
 * unbounded fetch holds one of the queue's four slots forever on a stalled
 * connection, and the device waits with it. 30s is far past a phrase's normal
 * latency. An abort is 'network' (nothing was received, so retryable); one
 * that lands mid-body, after a 2xx, is a 'billed-failure' like any other.
 */
const DEFAULT_TIMEOUT_MS = 30_000

/** The wait used when a 429 carries no usable `Retry-After` (one second). */
const DEFAULT_RETRY_AFTER_MS = 1000

/**
 * The only module that holds `ELEVENLABS_API_KEY` or names ElevenLabs'
 * endpoint shape — the server-side swap seam, same discipline the device
 * adapter it replaces (`src/adapters/audio/eleven-labs-synth-client.ts`)
 * used to keep. Every call goes through `queue` (a bounded-concurrency
 * limiter, T041's fix for the "2n simultaneous calls" defect in
 * `docs/scale.md`) and retries a 429 with backoff instead of failing it
 * permanently on the first attempt (the other defect that doc names).
 */
export function createElevenLabsProvider({
  apiKey,
  fetchImpl = fetch,
  queue,
  retries = 2,
  backoffMs = 500,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  // Every synthesis attempt, retries included, never probes: ElevenLabs
  // bills per attempt that gets a 2xx, so `/api/status` needs this number
  // to set against the clips actually stored. In-process, like its siblings.
  let attempts = 0

  return {
    /** Read by `/api/status`. */
    stats: () => ({ attempts }),

    async synthesize({ text, voiceId, modelId }) {
      if (!apiKey) throw providerError('not-configured', 'ELEVENLABS_API_KEY is not set')

      return queue.run(() =>
        withRetry(
          () => {
            attempts += 1
            return callOnce({
              apiKey,
              fetchImpl,
              text,
              voiceId,
              modelId,
              timeoutMs,
            })
          },
          {
            retries,
            baseMs: backoffMs,
            // Retried only where ElevenLabs cannot have billed us: 'network'
            // (nothing came back, or the attempt timed out), 'upstream' (a
            // 5xx) and 'rate-limited'. NOT 'billed-failure' — a failure after
            // a 2xx, which ElevenLabs charges for — nor 'not-configured' (a
            // bad key) nor 'rejected-request' (a 4xx a retry cannot fix).
            // 'rate-limited' replaced 'quota' here on 2026-09-02: a 429 is
            // transient and worth another attempt, while an account genuinely
            // out of credit is not — retrying a bill only spends battery.
            isRetryable: (err) => err.kind === 'rate-limited' || err.kind === 'network' || err.kind === 'upstream',
          },
        ),
      )
    },

    /**
     * Asks ElevenLabs whether the key this process holds still works, and
     * why not when it does not.
     *
     * **Down the synthesis path, not a metadata endpoint.** The key is
     * scoped to synthesis only — `GET /v1/voices` answers 401
     * `missing_permissions` (verified 2026-08-02, `voice-catalogue.ts`) — so
     * a subscription or voices call cannot tell a dead key from an
     * under-privileged one. One character against the endpoint the app
     * actually uses answers the question that was asked, and costs one
     * character of their credit, which is why `/api/status` caches it.
     *
     * **The body decides, not the status.** An exhausted account and a bad
     * key are both 401; `detail.status` is `quota_exceeded` for the first and
     * `invalid_api_key` (or similar) for the second, and the two need
     * different actions from a human. Reported verbatim rather than
     * re-worded, because the provider's own word is the fact and any synonym
     * of ours is a guess about their taxonomy.
     *
     * Never throws and never retries: a verdict, including
     * `credential: 'unreachable'`, is the answer. Retrying would turn one
     * probe into several charges against the thing being measured.
     */
    async probe({ voiceId = PROBE_VOICE_ID, modelId = PROBE_MODEL_ID, text = PROBE_TEXT } = {}) {
      if (!apiKey)
        return {
          configured: false,
          credential: 'unknown',
          detail: 'ELEVENLABS_API_KEY is not set',
        }

      let response
      try {
        response = await fetchImpl(`${API_URL}/${voiceId}?output_format=${OUTPUT_FORMAT}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'audio/mpeg',
            'xi-api-key': apiKey,
          },
          body: JSON.stringify({ text, model_id: modelId }),
        })
      } catch {
        return {
          configured: true,
          credential: 'unreachable',
          detail: 'network error contacting ElevenLabs',
        }
      }

      if (response.ok)
        return {
          configured: true,
          credential: 'ok',
          detail: `HTTP ${response.status}`,
        }

      const detail = (await readProviderStatus(response)) ?? `HTTP ${response.status}`
      if (detail === 'quota_exceeded') return { configured: true, credential: 'no-credit', detail }
      if (response.status === 401 || response.status === 403) {
        return { configured: true, credential: 'rejected', detail }
      }
      if (response.status === 429) return { configured: true, credential: 'rate-limited', detail }
      return { configured: true, credential: 'unreachable', detail }
    },
  }
}

/**
 * ElevenLabs' own word for what went wrong, out of an error body shaped
 * `{"detail": {"status": "quota_exceeded", ...}}` — or `{"detail": "..."}`,
 * which some of their errors use instead.
 *
 * Returns `undefined` rather than throwing on anything unexpected: the
 * caller has a status code to fall back on, and a probe that failed to read
 * an error body must not become an error of its own. Only the `status` word
 * is taken — never `message`, which can quote request content.
 */
async function readProviderStatus(response) {
  try {
    const body = await response.json()
    const detail = body?.detail
    if (typeof detail === 'string') return detail
    if (typeof detail?.status === 'string') return detail.status
    return undefined
  } catch {
    return undefined
  }
}

async function callOnce({ apiKey, fetchImpl, text, voiceId, modelId, timeoutMs }) {
  let response
  try {
    response = await fetchImpl(`${API_URL}/${voiceId}?output_format=${OUTPUT_FORMAT}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'audio/mpeg',
        'xi-api-key': apiKey,
      },
      body: JSON.stringify({ text, model_id: modelId }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw providerError('network', 'network error contacting ElevenLabs')
  }

  // The body decides, not the status. ElevenLabs answers an exhausted
  // account with **401 `quota_exceeded`** and a rate limit with **429**, so
  // the status alone cannot tell "somebody must pay" from "ask again in a
  // second" — and those two reach the device as a terminal verdict and a
  // wait respectively. Read only on this error branch: a body can be read
  // once, and on a 200 it is the audio. Reading it as JSON first consumed
  // it and failed every synthesis as 'network' (2026-10-02).
  if (response.status === 401 || response.status === 403) {
    if ((await readProviderStatus(response)) === 'quota_exceeded') {
      throw providerError('quota', 'ElevenLabs reports the account is out of credit')
    }
    throw providerError('not-configured', 'ElevenLabs rejected the configured key')
  }
  if (response.status === 429) {
    // Not `quota` (which it was until 2026-09-02, and which the device never
    // retries): a 429 is this provider pacing us, and the remedy is the wait
    // it names. `retryAfterMs` rides along so the device is told how long
    // rather than guessing.
    throw rateLimitedError(retryAfterMsFrom(response))
  }
  // A 5xx is the provider failing before it produced audio — transient, and
  // not billed. Any other non-ok status (a 400/404/422 for a request we
  // built wrong) is the same answer every time: 'rejected-request', which
  // `statusForProviderError` leaves at 502 and `isRetryable` never retries.
  if (response.status >= 500) {
    throw providerError('upstream', `ElevenLabs responded ${response.status}`)
  }
  if (!response.ok) {
    throw providerError('rejected-request', `ElevenLabs responded ${response.status}`)
  }

  // The read, not just the request, must be inside error handling (F6 audit,
  // defect 3): a mid-stream truncation surfaces here, after a response that
  // looked entirely fine at the HTTP level. It is NOT 'network': ElevenLabs
  // bills every 2xx it sends, so this failure has already been paid for and
  // a retry pays again for the same audio (2026-10-02: up to 9 charges per
  // phrase). 'billed-failure' is terminal, and `/api/status` counts it.
  let bytes
  try {
    bytes = Buffer.from(await response.arrayBuffer())
  } catch {
    throw providerError('billed-failure', 'failed reading the body of a billed ElevenLabs response')
  }
  return {
    bytes,
    durationMs: Math.round(bytes.byteLength / MP3_BYTES_PER_MS_AT_128KBPS),
    // What ElevenLabs said it sent, for the caller to check against what it
    // asked for (`clip-validation.js`); null when the header is absent.
    contentType: response.headers?.get?.('content-type') ?? null,
  }
}

function providerError(kind, message) {
  const err = new Error(message)
  err.kind = kind
  return err
}

/**
 * A rate limit, carrying how long to wait. Separate from `providerError`
 * because `retryAfterMs` is load-bearing: `app.js` puts it in the response's
 * `Retry-After`, and the device parks exactly that long
 * (`server-synth-client.ts`) instead of guessing or giving up.
 */
function rateLimitedError(retryAfterMs) {
  const err = new Error(`ElevenLabs is rate limiting this key; retry in ${retryAfterMs}ms`)
  err.kind = 'rate-limited'
  err.retryAfterMs = retryAfterMs
  return err
}

/**
 * The wait an upstream 429 asks for, in ms. `Retry-After` in seconds is the
 * RFC 9110 field; a second is the floor, because a `Retry-After: 0` is an
 * invitation to hammer, and `DEFAULT_RETRY_AFTER_MS` covers a response with
 * no usable header — including a fake in a test and a middlebox that ate it.
 * Tolerates a response with no `headers` at all rather than throwing inside
 * an error path.
 */
function retryAfterMsFrom(response) {
  const raw = response.headers?.get?.('retry-after')
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_RETRY_AFTER_MS
  return Math.max(1000, Math.round(seconds * 1000))
}
