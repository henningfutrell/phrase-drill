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

  // Defect 1 (F6 audit): the duration estimate assumes 128 kbps MP3 only
  // because that happens to be ElevenLabs' undocumented default when
  // `output_format` is omitted from the request. Pin it explicitly so the
  // bitrate the estimate assumes is the bitrate that was actually requested.
  it('requests output_format explicitly, pinned to the bitrate the duration estimate assumes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(1600),
    })
    const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl, queue: queue() })
    await provider.synthesize({ text: 'bonjour', voiceId: 'v1', modelId: 'm1' })

    const [url] = fetchImpl.mock.calls[0]
    expect(url).toContain('output_format=mp3_44100_128')
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

  /**
   * Corrected 2026-09-02: a persistent 429 is `rate-limited`, not `quota`.
   * The device never retries `quota` by design, so calling a rate limit a
   * quota marked Phrases permanently unready for a failure that clears on
   * its own. It carries the wait it asks for, defaulting to a second when
   * the response has no usable `Retry-After`.
   */
  it('maps a persistent 429 to rate-limited, with the wait it asks for', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429 })
    const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl, queue: queue(), retries: 2, backoffMs: 1 })
    await expect(provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })).rejects.toMatchObject({
      kind: 'rate-limited',
      retryAfterMs: 1000,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('honours an upstream Retry-After, in seconds', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: (name) => (name === 'retry-after' ? '4' : null) },
    })
    const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl, queue: queue(), retries: 0 })
    await expect(provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })).rejects.toMatchObject({
      kind: 'rate-limited',
      retryAfterMs: 4000,
    })
  })

  /**
   * The half a status code cannot carry: ElevenLabs answers an exhausted
   * account with 401 and the body says which 401 it is. `quota` here is
   * terminal on purpose — a wait does not buy credit — so it must not be
   * reached by anything a wait would fix.
   */
  it('maps 401 quota_exceeded to quota, and never retries it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ detail: { status: 'quota_exceeded' } }),
    })
    const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl, queue: queue(), retries: 2, backoffMs: 1 })
    await expect(provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })).rejects.toMatchObject({ kind: 'quota' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
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

  // Defect 3 (F6 audit): a mid-stream truncation used to reject *outside*
  // `callOnce`'s try/catch, with no `.kind`, so it fell through
  // `statusForProviderError`'s `default: 502` and was never retried — though
  // it is exactly the transient failure `withRetry` exists for.
  it('classifies a failure reading the response body as network, not an unclassified error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => {
        throw new Error('premature close')
      },
    })
    const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl, queue: queue(), retries: 0 })
    await expect(provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })).rejects.toMatchObject({
      kind: 'network',
    })
  })

  it('retries a failure reading the response body, and succeeds if a later attempt reads fine', async () => {
    let calls = 0
    const fetchImpl = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => {
        calls++
        if (calls === 1) throw new Error('premature close')
        return new ArrayBuffer(1600)
      },
    }))
    const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl, queue: queue(), retries: 1, backoffMs: 1 })
    const result = await provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })
    expect(result.bytes.byteLength).toBe(1600)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
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

  /**
   * Against the platform's own `Response`, not a plain-object fake. A real
   * body can be read once: the fakes above have no `bodyUsed`, so they let
   * a stray `json()` before `arrayBuffer()` pass, and that is exactly how
   * every fresh synthesis came to fail as 'network' in production
   * (2026-10-02) while `probe()`, which never reads a 200 body, said 'ok'.
   */
  describe('with a real fetch Response', () => {
    const json = (status, body, headers = {}) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

    it('returns the audio bytes of a 200 MP3 reply', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        new Response(new Uint8Array(1600), { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
      )
      const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl, queue: queue(), retries: 0 })
      const result = await provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })
      expect(result.bytes.byteLength).toBe(1600)
      expect(result.durationMs).toBe(100)
    })

    it('maps 401 quota_exceeded to quota', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(json(401, { detail: { status: 'quota_exceeded' } }))
      const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl, queue: queue(), retries: 2, backoffMs: 1 })
      await expect(provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })).rejects.toMatchObject({ kind: 'quota' })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it('maps 401 for a bad key to not-configured', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(json(401, { detail: { status: 'invalid_api_key' } }))
      const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl, queue: queue(), retries: 0 })
      await expect(provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })).rejects.toMatchObject({
        kind: 'not-configured',
      })
    })

    it('maps 429 to rate-limited, carrying Retry-After', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(json(429, { detail: { status: 'too_many_concurrent_requests' } }, { 'retry-after': '3' }))
      const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl, queue: queue(), retries: 0 })
      await expect(provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })).rejects.toMatchObject({
        kind: 'rate-limited',
        retryAfterMs: 3000,
      })
    })
  })
})
