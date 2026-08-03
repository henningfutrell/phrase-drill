import { describe, expect, it, vi } from 'vitest'
import { createServerSynthClient } from './server-synth-client'
import type { SynthError, SynthVoice } from './server-synth-client'

const VOICE: SynthVoice = { modelId: 'eleven_multilingual_v2', voiceId: 'voice-123' }
const LIBRARY_KEY = 'd'.repeat(64)

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
  libraryKey?: string
  fetchImpl?: ReturnType<typeof vi.fn<typeof fetch>>
} = {}) {
  const fetchImpl = overrides.fetchImpl ?? vi.fn<typeof fetch>()
  const getLibraryKey = vi.fn().mockResolvedValue(overrides.libraryKey ?? LIBRARY_KEY)
  const client = createServerSynthClient({ getLibraryKey, fetchImpl })
  return { client, fetchImpl, getLibraryKey }
}

describe('createServerSynthClient', () => {
  it('synthesizes text into MP3 bytes, reading duration from the server-supplied header', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(mp3Response(200, 16_000, 1000))
    const { client } = makeClient({ fetchImpl })

    const result = await client.synthesize('Bonjour', 'fr-FR', VOICE)

    expect(result.bytes.byteLength).toBe(16_000)
    expect(result.durationMs).toBe(1000)
  })

  it('posts to the same-origin /api/tts endpoint with text/voiceId/modelId', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(mp3Response(200, 100, 10))
    const { client } = makeClient({ fetchImpl })

    await client.synthesize('Bonjour', 'fr-FR', VOICE)

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/tts')
    const body = JSON.parse(init.body as string) as { text: string; voiceId: string; modelId: string }
    expect(body).toEqual({ text: 'Bonjour', voiceId: 'voice-123', modelId: 'eleven_multilingual_v2' })
  })

  it('sends the library key as a bearer token, never an ElevenLabs key of any kind', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(mp3Response(200, 100, 10))
    const { client } = makeClient({ fetchImpl })

    await client.synthesize('Bonjour', 'fr-FR', VOICE)

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['authorization']).toBe(`Bearer ${LIBRARY_KEY}`)
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
