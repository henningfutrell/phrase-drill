import type { DraftPhrase, ScanError, ScanReader } from '../../domain'
import { type PreparedImage, prepareImageForUpload } from './image-prep'

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
} as const

export interface ClaudeScanReaderDeps {
  /** Reads the Anthropic API key from wherever it is stored. Null when absent. */
  getApiKey(): Promise<string | null>
  /** Re-encodes and downscales the photo before upload. Defaults to the canvas-based encoder. */
  prepareImage?: (image: Blob) => Promise<PreparedImage>
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/** The Claude vision adapter for ScanReader. The only place that holds the API key or issues the request. */
export function createClaudeScanReader(deps: ClaudeScanReaderDeps): ScanReader {
  const prepareImage = deps.prepareImage ?? prepareImageForUpload
  const fetchImpl = deps.fetchImpl ?? fetch

  return {
    async read(image, signal) {
      const apiKey = await deps.getApiKey()
      if (!apiKey) {
        return Promise.reject(unauthorized())
      }

      let prepared: PreparedImage
      try {
        prepared = await prepareImage(image)
      } catch (err) {
        return Promise.reject(unreadable(`could not prepare image: ${describe(err)}`))
      }

      let response: Response
      try {
        response = await fetchImpl(API_URL, {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify({
            model: MODEL,
            max_tokens: 4096,
            output_config: {
              format: { type: 'json_schema', schema: DRAFT_PHRASES_SCHEMA },
            },
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: prepared.mediaType,
                      data: prepared.base64,
                    },
                  },
                  { type: 'text', text: PROMPT },
                ],
              },
            ],
          }),
        })
      } catch (err) {
        return Promise.reject(networkError(describe(err)))
      }

      if (response.status === 401 || response.status === 403) {
        return Promise.reject(unauthorized())
      }

      if (!response.ok) {
        return Promise.reject(networkError(`Claude API responded ${response.status}`))
      }

      let body: unknown
      try {
        body = await response.json()
      } catch (err) {
        return Promise.reject(unreadable(`response was not valid JSON: ${describe(err)}`))
      }

      return parseDraftPhrases(body)
    },
  }
}

function parseDraftPhrases(body: unknown): DraftPhrase[] {
  const textBlock = findTextBlock(body)
  if (textBlock === undefined) {
    throw unreadable('model response had no text content block')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(textBlock)
  } catch {
    throw unreadable('model response text was not valid JSON')
  }

  const phrases = isRecord(parsed) ? parsed.phrases : undefined
  if (!Array.isArray(phrases)) {
    throw unreadable('model response did not contain a phrases array')
  }

  return phrases.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.french !== 'string' || typeof entry.english !== 'string') {
      throw unreadable(`phrase at index ${index} was not a valid french/english pair`)
    }
    return { french: entry.french, english: entry.english }
  })
}

function findTextBlock(body: unknown): string | undefined {
  if (!isRecord(body) || !Array.isArray(body.content)) {
    return undefined
  }
  const block = body.content.find(
    (b): b is { type: 'text'; text: string } => isRecord(b) && b.type === 'text' && typeof b.text === 'string',
  )
  return block?.text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function unauthorized(): ScanError {
  return { kind: 'unauthorized' }
}

function unreadable(detail: string): ScanError {
  return { kind: 'unreadable', detail }
}

function networkError(detail: string): ScanError {
  return { kind: 'network', detail }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
