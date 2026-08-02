import { describe, expect, it, vi } from 'vitest'
import { createElevenLabsSynthClient } from './eleven-labs-synth-client'
import type { SynthError, SynthVoice } from './eleven-labs-synth-client'

const VOICE: SynthVoice = { modelId: 'eleven_multilingual_v2', voiceId: 'voice-123' }

function mp3Response(status: number, byteLength: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(byteLength)),
    json: () => Promise.resolve({}),
  } as Response
}

function errorResponse(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    json: () => Promise.resolve(body),
  } as Response
}

function makeClient(overrides: {
  apiKey?: string | null
  fetchImpl?: ReturnType<typeof vi.fn<typeof fetch>>
} = {}) {
  const fetchImpl = overrides.fetchImpl ?? vi.fn<typeof fetch>()
  const apiKey = overrides.apiKey === undefined ? 'el-real-key' : overrides.apiKey
  const getApiKey = vi.fn().mockResolvedValue(apiKey)
  const client = createElevenLabsSynthClient({ getApiKey, fetchImpl })
  return { client, fetchImpl, getApiKey }
}

describe('createElevenLabsSynthClient', () => {
  it('synthesizes text into MP3 bytes and an estimated duration', async () => {
    // 16,000 bytes at the documented 128 kbps default output ⇒ 1000 ms.
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(mp3Response(200, 16_000))
    const { client } = makeClient({ fetchImpl })

    const result = await client.synthesize('Bonjour', 'fr-FR', VOICE)

    expect(result.bytes.byteLength).toBe(16_000)
    expect(result.durationMs).toBe(1000)
  })

  it('estimates duration as bytes / 16 (128 kbps MP3, documented fallback)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(mp3Response(200, 36_000))
    const { client } = makeClient({ fetchImpl })

    const result = await client.synthesize('Bonjour, comment allez-vous ?', 'fr-FR', VOICE)

    expect(result.durationMs).toBe(2250)
  })

  it('posts to the voice-scoped endpoint with the multilingual model and the pinned voice', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(mp3Response(200, 100))
    const { client } = makeClient({ fetchImpl })

    await client.synthesize('Bonjour', 'fr-FR', VOICE)

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice-123')
    const body = JSON.parse(init.body as string) as { text: string; model_id: string }
    expect(body).toEqual({ text: 'Bonjour', model_id: 'eleven_multilingual_v2' })
  })

  it('sends the key only in the xi-api-key header, never in the URL or body', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(mp3Response(200, 100))
    const { client } = makeClient({ fetchImpl, apiKey: 'el-real-key' })

    await client.synthesize('Bonjour', 'fr-FR', VOICE)

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).not.toContain('el-real-key')
    expect(init.body as string).not.toContain('el-real-key')
    const headers = init.headers as Record<string, string>
    expect(headers['xi-api-key']).toBe('el-real-key')
    expect(headers['content-type']).toBe('application/json')
  })

  it('rejects with unauthorized when no key is stored, without calling fetch', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const { client } = makeClient({ apiKey: null, fetchImpl })

    await expect(client.synthesize('Bonjour', 'fr-FR', VOICE)).rejects.toEqual({ kind: 'unauthorized' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects with unauthorized on a 401 (missing-permissions key)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      errorResponse(401, {
        detail: {
          type: 'authentication_error',
          code: 'unauthorized',
          status: 'missing_permissions',
          message: 'The API key you used is missing the permission text_to_speech to execute this operation.',
        },
      }),
    )
    const { client } = makeClient({ fetchImpl })

    await expect(client.synthesize('Bonjour', 'fr-FR', VOICE)).rejects.toEqual({ kind: 'unauthorized' })
  })

  it('rejects with quota on a 429', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(errorResponse(429, { detail: { message: 'too many requests' } }))
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
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(errorResponse(500, { detail: 'server error' }))
    const { client } = makeClient({ fetchImpl })

    const error = (await client.synthesize('Bonjour', 'fr-FR', VOICE).catch((e: SynthError) => e)) as SynthError

    expect(error.kind).toBe('network')
  })

  it('never includes the API key in a thrown error', async () => {
    const secretKey = 'el-super-secret-value'
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(errorResponse(500, { detail: 'boom' }))
    const { client } = makeClient({ fetchImpl, apiKey: secretKey })

    const error = (await client.synthesize('Bonjour', 'fr-FR', VOICE).catch((e: SynthError) => e)) as SynthError

    expect(JSON.stringify(error)).not.toContain(secretKey)
  })
})
