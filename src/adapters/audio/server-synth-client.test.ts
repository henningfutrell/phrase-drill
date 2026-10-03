import { describe, expect, it, vi } from 'vitest'
import { createServerSynthClient } from './server-synth-client'
import type { SynthError, SynthVoice } from './server-synth-client'

const VOICE: SynthVoice = { provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-123' }
const ACCESS_TOKEN = 'test-access-token-d'

function mp3Response(status: number, byteLength: number, durationMs?: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name === 'x-duration-ms' && durationMs !== undefined ? String(durationMs) : null) },
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(byteLength)),
    json: () => Promise.resolve({}),
  } as unknown as Response
}

function errorResponse(status: number, headers: Record<string, string> = {}): Response {
  return {
    ok: false,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    json: () => Promise.resolve({}),
  } as unknown as Response
}

function makeClient(overrides: {
  accessToken?: string
  fetchImpl?: ReturnType<typeof vi.fn<typeof fetch>>
} = {}) {
  const fetchImpl = overrides.fetchImpl ?? vi.fn<typeof fetch>()
  const getAccessToken = vi.fn().mockResolvedValue(overrides.accessToken ?? ACCESS_TOKEN)
  const client = createServerSynthClient({ getAccessToken, fetchImpl })
  return { client, fetchImpl, getAccessToken }
}

describe('createServerSynthClient', () => {
  it('synthesizes text into MP3 bytes, reading duration from the server-supplied header', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(mp3Response(200, 16_000, 1000))
    const { client } = makeClient({ fetchImpl })

    const result = await client.synthesize('Bonjour', 'fr-FR', VOICE)

    expect(result.bytes.byteLength).toBe(16_000)
    expect(result.durationMs).toBe(1000)
  })

  // Every field of the content address goes on the wire (T063), including
  // `provider` and `lang`, which the ElevenLabs call itself has no use for.
  // The server derives the Clip key from exactly these five fields; sending
  // four of them would leave the server unable to name the clip the device
  // is asking for.
  it('posts to the same-origin /api/tts endpoint with every field of the content address', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(mp3Response(200, 100, 10))
    const { client } = makeClient({ fetchImpl })

    await client.synthesize('Bonjour', 'fr-FR', VOICE)

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/tts')
    const body = JSON.parse(init.body as string) as Record<string, string>
    expect(body).toEqual({
      text: 'Bonjour',
      voiceId: 'voice-123',
      modelId: 'eleven_multilingual_v2',
      provider: 'elevenlabs',
      lang: 'fr-FR',
    })
  })

  it('sends the language it was asked for, not a fixed one', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(mp3Response(200, 100, 10))
    const { client } = makeClient({ fetchImpl })

    await client.synthesize('Hello', 'en-US', VOICE)

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect((JSON.parse(init.body as string) as { lang: string }).lang).toBe('en-US')
  })

  it('sends the library key as a bearer token, never an ElevenLabs key of any kind', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(mp3Response(200, 100, 10))
    const { client } = makeClient({ fetchImpl })

    await client.synthesize('Bonjour', 'fr-FR', VOICE)

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(headers['xi-api-key']).toBeUndefined()
  })

  it('rejects with unauthorized on a 401 (bad library key)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(errorResponse(401))
    const { client } = makeClient({ fetchImpl })

    await expect(client.synthesize('Bonjour', 'fr-FR', VOICE)).rejects.toEqual({ kind: 'unauthorized' })
  })

  it('rejects with unauthorized on a 503 (server not configured)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(errorResponse(503))
    const { client } = makeClient({ fetchImpl })

    await expect(client.synthesize('Bonjour', 'fr-FR', VOICE)).rejects.toEqual({ kind: 'unauthorized' })
  })

  // T035, the whole point: a 429 is OUR server's limiter saying "slow down",
  // and it carries the wait. It is not the provider running out of credits.
  it('rejects with rate-limited on a 429, carrying the wait the server asked for', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(errorResponse(429, { 'retry-after': '20' }))
    const { client } = makeClient({ fetchImpl })

    await expect(client.synthesize('Bonjour', 'fr-FR', VOICE)).rejects.toEqual({ kind: 'rate-limited', retryAfterMs: 20_000 })
  })

  // The server answers 422 when the provider produced something unusable or
  // this phrase hit the server's 24 h billing cap. Both are terminal: asking
  // again spends money or is refused. It used to fall into `network` and be
  // retried three times.
  it('rejects with unreadable on a 422, distinct from a retryable network failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(errorResponse(422))
    const { client } = makeClient({ fetchImpl })

    await expect(client.synthesize('Bonjour', 'fr-FR', VOICE)).rejects.toEqual({ kind: 'unreadable' })
  })

  // 202 is the server saying "I queued generation and am still working on
  // it": not an error and not audio. The caller asks again after the wait.
  it('rejects with queued on a 202, carrying the wait the server asked for', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(errorResponse(202, { 'retry-after': '5' }))
    const { client } = makeClient({ fetchImpl })

    await expect(client.synthesize('Bonjour', 'fr-FR', VOICE)).rejects.toEqual({ kind: 'queued', retryAfterMs: 5000 })
  })

  it('falls back to five seconds when a 202 carries no usable Retry-After, and caps an absurd one', async () => {
    const missing = makeClient({ fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(errorResponse(202)) })
    await expect(missing.client.synthesize('Bonjour', 'fr-FR', VOICE)).rejects.toEqual({ kind: 'queued', retryAfterMs: 5000 })

    const junk = makeClient({ fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(errorResponse(202, { 'retry-after': 'soon' })) })
    await expect(junk.client.synthesize('Bonjour', 'fr-FR', VOICE)).rejects.toEqual({ kind: 'queued', retryAfterMs: 5000 })

    const zero = makeClient({ fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(errorResponse(202, { 'retry-after': '0' })) })
    await expect(zero.client.synthesize('Bonjour', 'fr-FR', VOICE)).rejects.toEqual({ kind: 'queued', retryAfterMs: 5000 })

    const huge = makeClient({ fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(errorResponse(202, { 'retry-after': '99999' })) })
    await expect(huge.client.synthesize('Bonjour', 'fr-FR', VOICE)).rejects.toEqual({ kind: 'queued', retryAfterMs: 60_000 })
  })

  it('falls back to one second when a 429 carries no Retry-After', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(errorResponse(429))
    const { client } = makeClient({ fetchImpl })

    await expect(client.synthesize('Bonjour', 'fr-FR', VOICE)).rejects.toEqual({ kind: 'rate-limited', retryAfterMs: 1000 })
  })

  it('ignores an unparsable or negative Retry-After rather than waiting forever or not at all', async () => {
    const { client } = makeClient({ fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(errorResponse(429, { 'retry-after': 'soon' })) })
    await expect(client.synthesize('Bonjour', 'fr-FR', VOICE)).rejects.toEqual({ kind: 'rate-limited', retryAfterMs: 1000 })

    const negative = makeClient({ fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(errorResponse(429, { 'retry-after': '-5' })) })
    await expect(negative.client.synthesize('Bonjour', 'fr-FR', VOICE)).rejects.toEqual({ kind: 'rate-limited', retryAfterMs: 1000 })
  })

  it('caps an absurd Retry-After, so a bad header cannot park the sweep for an hour', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(errorResponse(429, { 'retry-after': '99999' }))
    const { client } = makeClient({ fetchImpl })

    await expect(client.synthesize('Bonjour', 'fr-FR', VOICE)).rejects.toEqual({ kind: 'rate-limited', retryAfterMs: 60_000 })
  })

  it('rejects with quota on a 402 — the provider is out of credits, which no amount of waiting fixes', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(errorResponse(402))
    const { client } = makeClient({ fetchImpl })

    await expect(client.synthesize('Bonjour', 'fr-FR', VOICE)).rejects.toEqual({ kind: 'quota' })
  })

  it('rejects with a network SynthError when fetch itself throws', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'))
    const { client } = makeClient({ fetchImpl })

    const error = (await client.synthesize('Bonjour', 'fr-FR', VOICE).catch((e: SynthError) => e)) as SynthError

    expect(error.kind).toBe('network')
  })

  it('rejects with a network SynthError on an unrecognized non-2xx status', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(errorResponse(500))
    const { client } = makeClient({ fetchImpl })

    const error = (await client.synthesize('Bonjour', 'fr-FR', VOICE).catch((e: SynthError) => e)) as SynthError

    expect(error.kind).toBe('network')
  })
})

/**
 * Regenerate (docs/glossary.md): the one request that tells the server to
 * throw its stored Clip away and make it again. `/api/tts` alone cannot — it
 * serves the stored Clip, broken or not, to every device forever. Everything
 * but the path is `synthesize`'s: same body, same auth, same answers, so the
 * queue reads one set of outcomes whichever it sent.
 */
describe('createServerSynthClient regenerate', () => {
  it('posts the whole content address to /api/tts/regenerate, bearer-authenticated', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(mp3Response(200, 100, 10))
    const { client } = makeClient({ fetchImpl })

    await client.regenerate('Bonjour', 'fr-FR', VOICE)

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/tts/regenerate')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(JSON.parse(init.body as string)).toEqual({
      text: 'Bonjour',
      voiceId: 'voice-123',
      modelId: 'eleven_multilingual_v2',
      provider: 'elevenlabs',
      lang: 'fr-FR',
    })
  })

  it('resolves a 200 to the new MP3 bytes and the server-supplied duration', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(mp3Response(200, 16_000, 1000))
    const { client } = makeClient({ fetchImpl })

    const result = await client.regenerate('Bonjour', 'fr-FR', VOICE)

    expect(result.bytes.byteLength).toBe(16_000)
    expect(result.durationMs).toBe(1000)
  })

  it('passes the abort signal through to fetch', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(mp3Response(200, 100, 10))
    const { client } = makeClient({ fetchImpl })
    const signal = new AbortController().signal

    await client.regenerate('Bonjour', 'fr-FR', VOICE, signal)

    expect((fetchImpl.mock.calls[0] as [string, RequestInit])[1].signal).toBe(signal)
  })

  it.each<[string, Response, SynthError]>([
    ['202 queued', errorResponse(202, { 'retry-after': '5' }), { kind: 'queued', retryAfterMs: 5000 }],
    ['422 unreadable (includes the 24 h billing cap)', errorResponse(422), { kind: 'unreadable' }],
    ['429 rate-limited', errorResponse(429, { 'retry-after': '20' }), { kind: 'rate-limited', retryAfterMs: 20_000 }],
    ['402 quota', errorResponse(402), { kind: 'quota' }],
    ['401 unauthorized', errorResponse(401), { kind: 'unauthorized' }],
    ['503 unauthorized', errorResponse(503), { kind: 'unauthorized' }],
  ])('maps a %s exactly as synthesize does', async (_label, response, expected) => {
    const { client } = makeClient({ fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response) })

    await expect(client.regenerate('Bonjour', 'fr-FR', VOICE)).rejects.toEqual(expected)
  })

  it('rejects with a network SynthError when fetch throws or the status is unrecognized', async () => {
    const thrown = makeClient({ fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch')) })
    const status = makeClient({ fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(errorResponse(500)) })

    await expect(thrown.client.regenerate('Bonjour', 'fr-FR', VOICE)).rejects.toMatchObject({ kind: 'network' })
    await expect(status.client.regenerate('Bonjour', 'fr-FR', VOICE)).rejects.toMatchObject({ kind: 'network' })
  })
})
