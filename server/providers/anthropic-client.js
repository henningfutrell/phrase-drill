import { withRetry } from '../retry.js'

const API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const MODEL = 'claude-opus-5'

const PROMPT = `This photo shows a page of handwritten French phrases. Most
lines pair a French phrase with an English translation; some lines may be
French only.

- If a line has French but no English gloss, translate it into English
  yourself and include the translation.
- If a line is illegible, skip that line only — do not guess at text you
  cannot make out.
- If part of the photo is illegible but other lines are readable, return the
  readable lines. Do not discard them because the rest of the photo is not.
- If the photo contains no phrases at all, return an empty "phrases" array.
  An empty result is a valid, complete answer, not an error.

Return only the structured output, nothing else.`

const DRAFT_PHRASES_SCHEMA = {
  type: 'object',
  properties: {
    phrases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          french: { type: 'string' },
          english: { type: 'string' },
        },
        required: ['french', 'english'],
        additionalProperties: false,
      },
    },
  },
  required: ['phrases'],
  additionalProperties: false,
}

/**
 * The only module that holds `ANTHROPIC_API_KEY` — moved here unchanged
 * from `src/adapters/vision/claude-scan-reader.ts`, which this server route
 * now fronts instead of the device calling Anthropic directly. Same bounded
 * concurrency + backoff-on-429 discipline as the ElevenLabs client.
 */
export function createAnthropicProvider({ apiKey, fetchImpl = fetch, queue, retries = 2, backoffMs = 800 }) {
  return {
    async scan({ base64, mediaType }) {
      if (!apiKey) throw providerError('not-configured', 'ANTHROPIC_API_KEY is not set')

      return queue.run(() =>
        withRetry(() => callOnce({ apiKey, fetchImpl, base64, mediaType }), {
          retries,
          baseMs: backoffMs,
          isRetryable: (err) => err.kind === 'quota',
        }),
      )
    },
  }
}

async function callOnce({ apiKey, fetchImpl, base64, mediaType }) {
  let response
  try {
    response = await fetchImpl(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        output_config: { format: { type: 'json_schema', schema: DRAFT_PHRASES_SCHEMA } },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
              { type: 'text', text: PROMPT },
            ],
          },
        ],
      }),
    })
  } catch {
    throw providerError('network', 'network error contacting Claude')
  }

  if (response.status === 401 || response.status === 403) {
    throw providerError('not-configured', 'Claude rejected the configured key')
  }
  if (response.status === 429) {
    throw providerError('quota', 'Claude rate limit')
  }
  if (!response.ok) {
    throw providerError('network', `Claude responded ${response.status}`)
  }

  let body
  try {
    body = await response.json()
  } catch {
    throw providerError('unreadable', 'response was not valid JSON')
  }
  return parsePhrases(body)
}

function parsePhrases(body) {
  const block = Array.isArray(body?.content)
    ? body.content.find((b) => b && b.type === 'text' && typeof b.text === 'string')
    : undefined
  if (!block) throw providerError('unreadable', 'model response had no text content block')

  let parsed
  try {
    parsed = JSON.parse(block.text)
  } catch {
    throw providerError('unreadable', 'model response text was not valid JSON')
  }

  if (!Array.isArray(parsed?.phrases)) {
    throw providerError('unreadable', 'model response did not contain a phrases array')
  }

  return parsed.phrases.map((entry, index) => {
    if (!entry || typeof entry.french !== 'string' || typeof entry.english !== 'string') {
      throw providerError('unreadable', `phrase at index ${index} was not a valid french/english pair`)
    }
    return { french: entry.french, english: entry.english }
  })
}

function providerError(kind, message) {
  const err = new Error(message)
  err.kind = kind
  return err
}
