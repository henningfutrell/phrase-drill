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

function errorResponse(status: number): Response {
  return {
    ok: false,
    status,
    headers: { get: () => null },
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

  it('rejects with quota on a 429', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(errorResponse(429))
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
