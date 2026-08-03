import { describe, expect, it, vi } from 'vitest'
import { createServerScanReader } from './server-scan-reader'
import type { ScanError } from '../../domain'

const PREPARED = { base64: 'ZmFrZS1qcGVn', mediaType: 'image/jpeg' }
const LIBRARY_KEY = 'e'.repeat(64)

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response
}

function makeReader(overrides: {
  libraryKey?: string
  fetchImpl?: ReturnType<typeof vi.fn<typeof fetch>>
} = {}) {
  const fetchImpl = overrides.fetchImpl ?? vi.fn<typeof fetch>()
  const getLibraryKey = vi.fn().mockResolvedValue(overrides.libraryKey ?? LIBRARY_KEY)
  const prepareImage = vi.fn().mockResolvedValue(PREPARED)
  const reader = createServerScanReader({ getLibraryKey, prepareImage, fetchImpl })
  return { reader, fetchImpl, getLibraryKey, prepareImage }
}

describe('createServerScanReader', () => {
  it('reads a successful scan into Draft Phrases', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        phrases: [
          { french: 'Bonjour', english: 'Hello' },
          { french: 'Merci', english: 'Thank you' },
        ],
      }),
    )
    const { reader } = makeReader({ fetchImpl })

    const result = await reader.read(new Blob())

    expect(result).toEqual([
      { french: 'Bonjour', english: 'Hello' },
      { french: 'Merci', english: 'Thank you' },
    ])
  })

  it('resolves to an empty array for a page with no phrases, not a failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { phrases: [] }))
    const { reader } = makeReader({ fetchImpl })

    const result = await reader.read(new Blob())

    expect(result).toEqual([])
  })

  it('posts to the same-origin /api/scan endpoint with the image as the raw body', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { phrases: [] }))
    const { reader } = makeReader({ fetchImpl })

    await reader.read(new Blob())

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/scan')
    expect(init.headers as Record<string, string>).toMatchObject({ 'content-type': 'image/jpeg' })
  })

  it('sends the library key as a bearer token, never an Anthropic key of any kind', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { phrases: [] }))
    const { reader } = makeReader({ fetchImpl })

    await reader.read(new Blob())

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['authorization']).toBe(`Bearer ${LIBRARY_KEY}`)
    expect(headers['x-api-key']).toBeUndefined()
    expect(headers['anthropic-dangerous-direct-browser-access']).toBeUndefined()
  })

  it('rejects with unauthorized on a 401 (bad library key)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(401, { error: 'unauthorized' }))
    const { reader } = makeReader({ fetchImpl })

    await expect(reader.read(new Blob())).rejects.toEqual({ kind: 'unauthorized' })
  })

  it('rejects with unauthorized on a 503 (server not configured)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(503, { error: 'not-configured' }))
    const { reader } = makeReader({ fetchImpl })

    await expect(reader.read(new Blob())).rejects.toEqual({ kind: 'unauthorized' })
  })

  it('rejects with unreadable on a 422 from the server', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(422, { error: 'unreadable' }))
    const { reader } = makeReader({ fetchImpl })

    const error = (await reader.read(new Blob()).catch((e: ScanError) => e)) as ScanError

    expect(error.kind).toBe('unreadable')
  })

  it('rejects with a network ScanError when fetch itself fails', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'))
    const { reader } = makeReader({ fetchImpl })

    const error = (await reader.read(new Blob()).catch((e: ScanError) => e)) as ScanError

    expect(error.kind).toBe('network')
  })

  it('never includes the library key in a thrown error', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(500, { error: 'boom' }))
    const { reader } = makeReader({ fetchImpl })

    const error = (await reader.read(new Blob()).catch((e: ScanError) => e)) as ScanError

    expect(JSON.stringify(error)).not.toContain(LIBRARY_KEY)
  })
})
