// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createElevenLabsProvider } from './elevenlabs-client.js'
import { createBoundedQueue } from '../bounded-queue.js'

function queue() {
  return createBoundedQueue({ concurrency: 4 })
}

describe('createElevenLabsProvider', () => {
  it('throws not-configured without an apiKey, and never calls fetch', async () => {
    const fetchImpl = vi.fn()
    const provider = createElevenLabsProvider({ apiKey: null, fetchImpl, queue: queue() })
    await expect(provider.synthesize({ text: 'bonjour', voiceId: 'v1', modelId: 'm1' })).rejects.toMatchObject({
      kind: 'not-configured',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('posts to the ElevenLabs endpoint with the key in the xi-api-key header, never in the URL or body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(1600),
    })
    const provider = createElevenLabsProvider({ apiKey: 'sk-secret', fetchImpl, queue: queue() })
    await provider.synthesize({ text: 'bonjour', voiceId: 'v1', modelId: 'm1' })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).not.toContain('sk-secret')
    expect(init.body).not.toContain('sk-secret')
    expect(init.headers['xi-api-key']).toBe('sk-secret')
  })

  it('estimates duration from byte length at 16 bytes/ms', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(1600),
    })
    const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl, queue: queue() })
    const result = await provider.synthesize({ text: 'bonjour', voiceId: 'v1', modelId: 'm1' })
    expect(result.durationMs).toBe(100)
    expect(result.bytes.byteLength).toBe(1600)
  })

  it('maps 401/403 to not-configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401 })
    const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl, queue: queue(), retries: 0 })
    await expect(provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })).rejects.toMatchObject({
      kind: 'not-configured',
    })
  })

  it('maps a persistent 429 to quota after retrying', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429 })
    const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl, queue: queue(), retries: 2, backoffMs: 1 })
    await expect(provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })).rejects.toMatchObject({ kind: 'quota' })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('retries a 429 and succeeds if a later attempt is ok', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(160) })
    const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl, queue: queue(), retries: 2, backoffMs: 1 })
    const result = await provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })
    expect(result.bytes.byteLength).toBe(160)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('maps other non-ok statuses and network failures to network', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl, queue: queue(), retries: 0 })
    await expect(provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })).rejects.toMatchObject({ kind: 'network' })

    const throwingFetch = vi.fn().mockRejectedValue(new Error('offline'))
    const provider2 = createElevenLabsProvider({ apiKey: 'k', fetchImpl: throwingFetch, queue: queue(), retries: 0 })
    await expect(provider2.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })).rejects.toMatchObject({ kind: 'network' })
  })

  it('runs calls through the given bounded queue, capping concurrency', async () => {
    const q = createBoundedQueue({ concurrency: 2 })
    let active = 0
    let maxActive = 0
    const fetchImpl = vi.fn().mockImplementation(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(16) }
    })
    const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl, queue: q })
    await Promise.all(
      Array.from({ length: 5 }, () => provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })),
    )
    expect(maxActive).toBeLessThanOrEqual(2)
  })
})
