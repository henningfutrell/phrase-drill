// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createElevenLabsProvider } from './elevenlabs-client.js'

describe('createElevenLabsProvider', () => {
  it('throws not-configured without an apiKey, and never calls fetch', async () => {
    const fetchImpl = vi.fn()
    const provider = createElevenLabsProvider({ apiKey: null, fetchImpl })
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
    const provider = createElevenLabsProvider({ apiKey: 'sk-secret', fetchImpl })
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
    const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl })
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
    const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl })
    const result = await provider.synthesize({ text: 'bonjour', voiceId: 'v1', modelId: 'm1' })
    expect(result.durationMs).toBe(100)
    expect(result.bytes.byteLength).toBe(1600)
  })

  it('maps 401/403 to not-configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401 })
    const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl })
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
    const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl })
    await expect(provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })).rejects.toMatchObject({
      kind: 'rate-limited',
      retryAfterMs: 1000,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('honours an upstream Retry-After, in seconds', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: (name) => (name === 'retry-after' ? '4' : null) },
    })
    const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl })
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
    const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl })
    await expect(provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })).rejects.toMatchObject({ kind: 'quota' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('maps a transport failure to network', async () => {
    const throwingFetch = vi.fn().mockRejectedValue(new Error('offline'))
    const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl: throwingFetch })
    await expect(provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })).rejects.toMatchObject({ kind: 'network' })
  })

  // A 5xx is the provider failing before it produced audio: not billed, and
  // transient — the runner (`clip-job-runner.js`) is what tries it again.
  it('maps a 5xx to upstream', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl })
    await expect(provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })).rejects.toMatchObject({ kind: 'upstream' })
  })

  /**
   * S5. Retries moved to the clip job runner, which knows what each attempt
   * cost. A provider that also retried would multiply the runner's attempts
   * by its own — the shape of the 2026-09 bill, one layer down.
   */
  it.each([
    ['a transport failure', () => vi.fn().mockRejectedValue(new Error('offline'))],
    ['a 5xx', () => vi.fn().mockResolvedValue({ ok: false, status: 503 })],
    ['a 429', () => vi.fn().mockResolvedValue({ ok: false, status: 429 })],
  ])('makes exactly one call per synthesize on %s — the runner owns retries', async (_name, makeFetch) => {
    const fetchImpl = makeFetch()
    const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl })
    await provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' }).catch(() => {})
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('maps any other non-ok status to rejected-request, and never retries it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 422 })
    const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl })
    await expect(provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })).rejects.toMatchObject({
      kind: 'rejected-request',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  // ElevenLabs bills every 2xx it returns. A failure reading the body AFTER
  // that 2xx is therefore a billed failure: retrying it buys the same audio
  // again at full price (2026-10-02: up to 9 charges per phrase).
  it('classifies a failure reading a 2xx body as billed-failure, and never retries it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => {
        throw new Error('premature close')
      },
    })
    const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl })
    await expect(provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })).rejects.toMatchObject({
      kind: 'billed-failure',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('aborts a fetch that outlives timeoutMs, as a network failure', async () => {
    const fetchImpl = vi.fn().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason))
        }),
    )
    const provider = createElevenLabsProvider({
      apiKey: 'k',
      fetchImpl,
      timeoutMs: 10,
    })
    await expect(provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })).rejects.toMatchObject({
      kind: 'network',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })

  it('gives every synthesis fetch an abort signal by default', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(16) })
    const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl })
    await provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })

  it('asks for audio/mpeg on synthesis and on probe', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(new Uint8Array(16), { status: 200 }))
    const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl })
    await provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })
    await provider.probe()
    expect(fetchImpl.mock.calls[0][1].headers.accept).toBe('audio/mpeg')
    expect(fetchImpl.mock.calls[1][1].headers.accept).toBe('audio/mpeg')
  })

  it('counts every synthesis call, but not probes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl })
    expect(provider.stats().attempts).toBe(0)
    await provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' }).catch(() => {})
    await provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' }).catch(() => {})
    await provider.probe()
    expect(provider.stats().attempts).toBe(2)
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
      const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl })
      const result = await provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })
      expect(result.bytes.byteLength).toBe(1600)
      expect(result.durationMs).toBe(100)
    })

    it('returns the response content-type alongside the bytes', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        new Response(new Uint8Array(1600), { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
      )
      const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl })
      const result = await provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })
      expect(result.contentType).toBe('audio/mpeg')
    })

    it('reports a missing content-type as null, for the caller to reject', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(new Response(new Uint8Array(1600), { status: 200 }))
      const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl })
      const result = await provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })
      expect(result.contentType).toBeNull()
    })

    it('maps 401 quota_exceeded to quota', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(json(401, { detail: { status: 'quota_exceeded' } }))
      const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl })
      await expect(provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })).rejects.toMatchObject({ kind: 'quota' })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it('maps 401 for a bad key to not-configured', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(json(401, { detail: { status: 'invalid_api_key' } }))
      const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl })
      await expect(provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })).rejects.toMatchObject({
        kind: 'not-configured',
      })
    })

    it('maps 429 to rate-limited, carrying Retry-After', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(json(429, { detail: { status: 'too_many_concurrent_requests' } }, { 'retry-after': '3' }))
      const provider = createElevenLabsProvider({ apiKey: 'k', fetchImpl })
      await expect(provider.synthesize({ text: 't', voiceId: 'v', modelId: 'm' })).rejects.toMatchObject({
        kind: 'rate-limited',
        retryAfterMs: 3000,
      })
    })
  })
})
