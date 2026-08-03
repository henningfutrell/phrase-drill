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
})
