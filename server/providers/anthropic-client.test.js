// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createAnthropicProvider } from './anthropic-client.js'
import { createBoundedQueue } from '../bounded-queue.js'

function queue() {
  return createBoundedQueue({ concurrency: 2 })
}

function okResponse(phrases) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ phrases }) }],
    }),
  }
}

describe('createAnthropicProvider', () => {
  it('throws not-configured without an apiKey, and never calls fetch', async () => {
    const fetchImpl = vi.fn()
    const provider = createAnthropicProvider({ apiKey: null, fetchImpl, queue: queue() })
    await expect(provider.scan({ base64: 'AAAA', mediaType: 'image/jpeg' })).rejects.toMatchObject({
      kind: 'not-configured',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('posts with the key in the x-api-key header, never in the URL or body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse([{ french: 'bonjour', english: 'hello' }]))
    const provider = createAnthropicProvider({ apiKey: 'sk-secret', fetchImpl, queue: queue() })
    await provider.scan({ base64: 'AAAA', mediaType: 'image/jpeg' })

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).not.toContain('sk-secret')
    expect(init.body).not.toContain('sk-secret')
    expect(init.headers['x-api-key']).toBe('sk-secret')
  })

  it('parses the phrases array out of the model response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse([
        { french: 'bonjour', english: 'hello' },
        { french: 'merci', english: 'thank you' },
      ]),
    )
    const provider = createAnthropicProvider({ apiKey: 'k', fetchImpl, queue: queue() })
    const phrases = await provider.scan({ base64: 'AAAA', mediaType: 'image/jpeg' })
    expect(phrases).toEqual([
      { french: 'bonjour', english: 'hello' },
      { french: 'merci', english: 'thank you' },
    ])
  })

  it('returns an empty array when the model reports no phrases', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse([]))
    const provider = createAnthropicProvider({ apiKey: 'k', fetchImpl, queue: queue() })
    await expect(provider.scan({ base64: 'AAAA', mediaType: 'image/jpeg' })).resolves.toEqual([])
  })

  it('maps 401/403 to not-configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403 })
    const provider = createAnthropicProvider({ apiKey: 'k', fetchImpl, queue: queue(), retries: 0 })
    await expect(provider.scan({ base64: 'AAAA', mediaType: 'image/jpeg' })).rejects.toMatchObject({
      kind: 'not-configured',
    })
  })

  it('maps a persistent 429 to quota after retrying', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429 })
    const provider = createAnthropicProvider({ apiKey: 'k', fetchImpl, queue: queue(), retries: 2, backoffMs: 1 })
    await expect(provider.scan({ base64: 'AAAA', mediaType: 'image/jpeg' })).rejects.toMatchObject({ kind: 'quota' })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('maps a response with no text content block to unreadable', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ content: [] }) })
    const provider = createAnthropicProvider({ apiKey: 'k', fetchImpl, queue: queue() })
    await expect(provider.scan({ base64: 'AAAA', mediaType: 'image/jpeg' })).rejects.toMatchObject({ kind: 'unreadable' })
  })

  it('maps malformed JSON in the text block to unreadable', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: 'not json' }] }),
    })
    const provider = createAnthropicProvider({ apiKey: 'k', fetchImpl, queue: queue() })
    await expect(provider.scan({ base64: 'AAAA', mediaType: 'image/jpeg' })).rejects.toMatchObject({ kind: 'unreadable' })
  })

  it('maps a malformed phrase entry to unreadable', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse([{ french: 'bonjour' }]))
    const provider = createAnthropicProvider({ apiKey: 'k', fetchImpl, queue: queue() })
    await expect(provider.scan({ base64: 'AAAA', mediaType: 'image/jpeg' })).rejects.toMatchObject({ kind: 'unreadable' })
  })

  it('maps other non-ok statuses and network failures to network', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    const provider = createAnthropicProvider({ apiKey: 'k', fetchImpl, queue: queue(), retries: 0 })
    await expect(provider.scan({ base64: 'AAAA', mediaType: 'image/jpeg' })).rejects.toMatchObject({ kind: 'network' })

    const throwingFetch = vi.fn().mockRejectedValue(new Error('offline'))
    const provider2 = createAnthropicProvider({ apiKey: 'k', fetchImpl: throwingFetch, queue: queue(), retries: 0 })
    await expect(provider2.scan({ base64: 'AAAA', mediaType: 'image/jpeg' })).rejects.toMatchObject({ kind: 'network' })
  })
})
