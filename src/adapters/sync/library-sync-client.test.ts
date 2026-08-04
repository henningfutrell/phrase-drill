import { describe, expect, it, vi } from 'vitest'
import { createLibrarySyncClient } from './library-sync-client'
import type { Library } from '../../domain'

const ACCESS_TOKEN = 'test-access-token-f'
const LIBRARY: Library = { format: 'phrase-drill-library', schemaVersion: 1, exportedAt: 1000, decks: [] }

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response
}

function emptyResponse(status: number): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(undefined) } as Response
}

function makeClient(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>) {
  const getAccessToken = vi.fn().mockResolvedValue(ACCESS_TOKEN)
  return { client: createLibrarySyncClient({ getAccessToken, fetchImpl }), getAccessToken }
}

describe('createLibrarySyncClient', () => {
  it('pushes the library as a PUT with the key as a bearer token', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(emptyResponse(204))
    const { client } = makeClient(fetchImpl)

    const result = await client.push(LIBRARY)

    expect(result).toEqual({ ok: true })
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/library')
    expect(init.method).toBe('PUT')
    expect((init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(JSON.parse(init.body as string)).toEqual(LIBRARY)
  })

  it('reports unauthorized on a push rejected with 401', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(emptyResponse(401))
    const { client } = makeClient(fetchImpl)

    await expect(client.push(LIBRARY)).resolves.toEqual({ ok: false, reason: 'unauthorized' })
  })

  it('reports network on a push failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline'))
    const { client } = makeClient(fetchImpl)

    await expect(client.push(LIBRARY)).resolves.toEqual({ ok: false, reason: 'network' })
  })

  it('pulls the library back with the key as a bearer token', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, LIBRARY))
    const { client } = makeClient(fetchImpl)

    const result = await client.pull()

    expect(result).toEqual({ ok: true, library: LIBRARY })
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/library')
    expect((init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`)
  })

  it('reports not-found when nothing has been pushed for this key yet', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(emptyResponse(404))
    const { client } = makeClient(fetchImpl)

    await expect(client.pull()).resolves.toEqual({ ok: false, reason: 'not-found' })
  })

  it('reports unauthorized on a pull rejected with 401', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(emptyResponse(401))
    const { client } = makeClient(fetchImpl)

    await expect(client.pull()).resolves.toEqual({ ok: false, reason: 'unauthorized' })
  })

  it('reports network on a pull failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline'))
    const { client } = makeClient(fetchImpl)

    await expect(client.pull()).resolves.toEqual({ ok: false, reason: 'network' })
  })

  it('reports network when the server sends a body that is not the library — a corrupt row must not throw', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
    } as Response)
    const { client } = makeClient(fetchImpl)

    await expect(client.pull()).resolves.toEqual({ ok: false, reason: 'network' })
  })

  /**
   * The one signal that licenses a repair push (T089). `500
   * {"error":"library-unreadable"}` is `server/app.js` handleLibraryGet
   * saying it read its own row and the row is not a library envelope — a
   * fact about the stored bytes, not about this request. It has to survive
   * the trip into the engine intact, because it is the only thing that tells
   * "there is nothing readable there to lose" apart from "I could not reach
   * what may be a perfectly good copy".
   */
  it('reports server-copy-unreadable when the server says the row it holds is not a library', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(500, { error: 'library-unreadable' }))
    const { client } = makeClient(fetchImpl)

    await expect(client.pull()).resolves.toEqual({ ok: false, reason: 'server-copy-unreadable' })
  })

  it('reports network on any other 500 — a server that fell over says nothing about the row it holds', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(500, { error: 'server-error' }))
    const { client } = makeClient(fetchImpl)

    await expect(client.pull()).resolves.toEqual({ ok: false, reason: 'network' })
  })

  it('reports network on a 500 whose body is not this server’s at all — a proxy error page is not a verdict on her library', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON at position 0')),
    } as Response)
    const { client } = makeClient(fetchImpl)

    await expect(client.pull()).resolves.toEqual({ ok: false, reason: 'network' })
  })

  it('reports network on a 502 or 503 — an upstream hiccup is not a verdict on her library either', async () => {
    for (const status of [502, 503]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(status, { error: 'library-unreadable' }))
      const { client } = makeClient(fetchImpl)

      await expect(client.pull()).resolves.toEqual({ ok: false, reason: 'network' })
    }
  })

  it('reports unauthorized when there is no session to pull with, rather than rejecting', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const client = createLibrarySyncClient({
      getAccessToken: () => Promise.reject(new Error('authentication required')),
      fetchImpl,
    })

    await expect(client.pull()).resolves.toEqual({ ok: false, reason: 'unauthorized' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports unauthorized when there is no session to push with, rather than rejecting', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const client = createLibrarySyncClient({
      getAccessToken: () => Promise.reject(new Error('authentication required')),
      fetchImpl,
    })

    await expect(client.push(LIBRARY)).resolves.toEqual({ ok: false, reason: 'unauthorized' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
