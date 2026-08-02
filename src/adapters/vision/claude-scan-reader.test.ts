import { describe, expect, it, vi } from 'vitest'
import { createClaudeScanReader } from './claude-scan-reader'
import type { ScanError } from '../../domain'

const PREPARED = { base64: 'ZmFrZS1qcGVn', mediaType: 'image/jpeg' }

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response
}

function messagesEnvelope(phrases: Array<{ french: string; english: string }>) {
  return {
    id: 'msg_1',
    content: [{ type: 'text', text: JSON.stringify({ phrases }) }],
  }
}

function makeReader(overrides: {
  apiKey?: string | null
  fetchImpl?: ReturnType<typeof vi.fn<typeof fetch>>
} = {}) {
  const fetchImpl = overrides.fetchImpl ?? vi.fn<typeof fetch>()
  const apiKey = overrides.apiKey === undefined ? 'sk-ant-real-key' : overrides.apiKey
  const getApiKey = vi.fn().mockResolvedValue(apiKey)
  const prepareImage = vi.fn().mockResolvedValue(PREPARED)
  const reader = createClaudeScanReader({ getApiKey, prepareImage, fetchImpl })
  return { reader, fetchImpl, getApiKey, prepareImage }
}

describe('createClaudeScanReader', () => {
  it('reads a successful scan into Draft Phrases', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, messagesEnvelope([
        { french: 'Bonjour', english: 'Hello' },
        { french: 'Merci', english: 'Thank you' },
      ])),
    )
    const { reader } = makeReader({ fetchImpl })

    const result = await reader.read(new Blob())

    expect(result).toEqual([
      { french: 'Bonjour', english: 'Hello' },
      { french: 'Merci', english: 'Thank you' },
    ])
  })

  it('resolves to an empty array for a page with no phrases, not a failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, messagesEnvelope([])))
    const { reader } = makeReader({ fetchImpl })

    const result = await reader.read(new Blob())

    expect(result).toEqual([])
  })

  it('rejects with unauthorized when no key is stored, without calling fetch', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const { reader } = makeReader({ apiKey: null, fetchImpl })

    await expect(reader.read(new Blob())).rejects.toEqual({ kind: 'unauthorized' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects with unauthorized on a 401 from the API', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
    )
    const { reader } = makeReader({ fetchImpl })

    await expect(reader.read(new Blob())).rejects.toEqual({ kind: 'unauthorized' })
  })

  it('rejects with a network ScanError when fetch itself fails', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'))
    const { reader } = makeReader({ fetchImpl })

    const error = (await reader.read(new Blob()).catch((e: ScanError) => e)) as ScanError

    expect(error.kind).toBe('network')
  })

  it('rejects with unreadable when the model response is not the expected shape', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, { id: 'msg_1', content: [{ type: 'text', text: 'not json' }] }),
    )
    const { reader } = makeReader({ fetchImpl })

    const error = (await reader.read(new Blob()).catch((e: ScanError) => e)) as ScanError

    expect(error.kind).toBe('unreadable')
  })

  it('never includes the API key in a thrown error', async () => {
    const secretKey = 'sk-ant-super-secret-value'
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(500, { error: 'boom' }))
    const { reader } = makeReader({ apiKey: secretKey, fetchImpl })

    const error = (await reader.read(new Blob()).catch((e: ScanError) => e)) as ScanError

    expect(JSON.stringify(error)).not.toContain(secretKey)
  })

  it('sends the browser-direct header and the key only in x-api-key, never in the URL', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, messagesEnvelope([])))
    const { reader } = makeReader({ fetchImpl, apiKey: 'sk-ant-real-key' })

    await reader.read(new Blob())

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).not.toContain('sk-ant-real-key')
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-ant-real-key')
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true')
  })
})
