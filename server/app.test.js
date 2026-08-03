// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.js'
import { createLibraryStore } from './db.js'
import { createRateLimiter } from './rate-limiter.js'
import { createBoundedQueue } from './bounded-queue.js'
import { createElevenLabsProvider } from './providers/elevenlabs-client.js'
import { createAnthropicProvider } from './providers/anthropic-client.js'

const REAL_KEY = 'a'.repeat(64)
const SECRET_ELEVENLABS_KEY = 'xi-live-secret-99999'
const SECRET_ANTHROPIC_KEY = 'anthropic-live-secret-88888'

/** Every log line captured during a test, so tests can assert none contains a secret. */
function collectingLogger() {
  const lines = []
  const write = (line) => lines.push(line)
  return {
    lines,
    info: (msg, fields) => write(JSON.stringify({ level: 'info', msg, ...redactAssertHelper(fields) })),
    warn: (msg, fields) => write(JSON.stringify({ level: 'warn', msg, ...redactAssertHelper(fields) })),
    error: (msg, fields) => write(JSON.stringify({ level: 'error', msg, ...redactAssertHelper(fields) })),
  }
}
function redactAssertHelper(fields) {
  return fields ?? {}
}

function fetchThatFailsWith(status) {
  return async () => ({ ok: false, status })
}

function fetchElevenLabsOk() {
  return async (url, init) => {
    if (init.headers['xi-api-key'] !== SECRET_ELEVENLABS_KEY) throw new Error('wrong key used against fake upstream')
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(1600) }
  }
}

function fetchAnthropicOk(phrases) {
  return async (url, init) => {
    if (init.headers['x-api-key'] !== SECRET_ANTHROPIC_KEY) throw new Error('wrong key used against fake upstream')
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ phrases }) }] }) }
  }
}

describe('server app (integration, fake upstreams)', () => {
  let server
  let baseUrl
  let libraryStore
  let distDir
  let logger

  function boot({ elevenLabsFetch = fetchElevenLabsOk(), anthropicFetch = fetchAnthropicOk([]) } = {}) {
    libraryStore = createLibraryStore(':memory:')
    distDir = mkdtempSync(join(tmpdir(), 'phrase-drill-dist-'))
    mkdirSync(join(distDir, 'assets'), { recursive: true })
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>phrase-drill</title>')
    writeFileSync(join(distDir, 'assets', 'app.js'), 'console.log("app")')

    logger = collectingLogger()
    const elevenLabs = createElevenLabsProvider({
      apiKey: SECRET_ELEVENLABS_KEY,
      fetchImpl: elevenLabsFetch,
      queue: createBoundedQueue({ concurrency: 4 }),
      retries: 1,
      backoffMs: 1,
    })
    const anthropic = createAnthropicProvider({
      apiKey: SECRET_ANTHROPIC_KEY,
      fetchImpl: anthropicFetch,
      queue: createBoundedQueue({ concurrency: 2 }),
      retries: 1,
      backoffMs: 1,
    })

    const handleRequest = createApp({
      libraryStore,
      elevenLabs,
      anthropic,
      ttsLimiter: createRateLimiter({ capacity: 3, refillMs: 60_000 }),
      scanLimiter: createRateLimiter({ capacity: 3, refillMs: 60_000 }),
      libraryLimiter: createRateLimiter({ capacity: 3, refillMs: 60_000 }),
      distDir,
      logger,
    })

    server = createServer(handleRequest)
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`
        resolve()
      })
    })
  }

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve))
    libraryStore.close()
    rmSync(distDir, { recursive: true, force: true })
  })

  it('GET /api/health returns ok with no auth required', async () => {
    await boot()
    const res = await fetch(`${baseUrl}/api/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('rejects /api/* requests without a valid bearer token', async () => {
    await boot()
    const noAuth = await fetch(`${baseUrl}/api/library`)
    expect(noAuth.status).toBe(401)

    const badAuth = await fetch(`${baseUrl}/api/library`, { headers: { authorization: 'Bearer not-hex' } })
    expect(badAuth.status).toBe(401)
  })

  it('serves the built PWA for a static path and falls back to index.html for unknown paths', async () => {
    await boot()
    const asset = await fetch(`${baseUrl}/assets/app.js`)
    expect(asset.status).toBe(200)
    expect(await asset.text()).toContain('console.log')

    const fallback = await fetch(`${baseUrl}/some/client/route`)
    expect(fallback.status).toBe(200)
    expect(await fallback.text()).toContain('phrase-drill')
  })

  it('blocks path traversal from escaping distDir', async () => {
    await boot()
    const res = await fetch(`${baseUrl}/../../../../etc/passwd`)
    // A traversal-looking path either 404s (rejected before resolution) or falls
    // back to index.html — it must never return anything outside distDir.
    const text = await res.text()
    expect(text).not.toContain('root:')
  })

  describe('POST /api/tts', () => {
    it('returns audio bytes for a valid request, and never lets the ElevenLabs key appear in the response', async () => {
      await boot()
      const res = await fetch(`${baseUrl}/api/tts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${REAL_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'bonjour', voiceId: 'v1', modelId: 'm1' }),
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('audio/mpeg')
      const buf = Buffer.from(await res.arrayBuffer())
      expect(buf.byteLength).toBe(1600)
      expect(buf.toString('latin1')).not.toContain(SECRET_ELEVENLABS_KEY)
    })

    it('rejects an oversized body with 413', async () => {
      await boot()
      const res = await fetch(`${baseUrl}/api/tts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${REAL_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'x'.repeat(20_000), voiceId: 'v1', modelId: 'm1' }),
      })
      expect(res.status).toBe(413)
    })

    it('rejects an invalid request body with 400', async () => {
      await boot()
      const res = await fetch(`${baseUrl}/api/tts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${REAL_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: '' }),
      })
      expect(res.status).toBe(400)
    })

    it('returns 503 not-configured when the upstream key is missing, without ever leaking the (absent) key', async () => {
      libraryStore = createLibraryStore(':memory:')
      distDir = mkdtempSync(join(tmpdir(), 'phrase-drill-dist-'))
      writeFileSync(join(distDir, 'index.html'), '<!doctype html>')
      logger = collectingLogger()
      const elevenLabs = createElevenLabsProvider({ apiKey: null, queue: createBoundedQueue({ concurrency: 4 }) })
      const anthropic = createAnthropicProvider({ apiKey: null, queue: createBoundedQueue({ concurrency: 2 }) })
      const handleRequest = createApp({
        libraryStore,
        elevenLabs,
        anthropic,
        ttsLimiter: createRateLimiter({ capacity: 3, refillMs: 60_000 }),
        scanLimiter: createRateLimiter({ capacity: 3, refillMs: 60_000 }),
        libraryLimiter: createRateLimiter({ capacity: 3, refillMs: 60_000 }),
        distDir,
        logger,
      })
      server = createServer(handleRequest)
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      baseUrl = `http://127.0.0.1:${server.address().port}`

      const res = await fetch(`${baseUrl}/api/tts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${REAL_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'bonjour', voiceId: 'v1', modelId: 'm1' }),
      })
      expect(res.status).toBe(503)
    })

    it('returns 429 when the upstream reports quota exhaustion after retrying', async () => {
      await boot({ elevenLabsFetch: fetchThatFailsWith(429) })
      const res = await fetch(`${baseUrl}/api/tts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${REAL_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'bonjour', voiceId: 'v1', modelId: 'm1' }),
      })
      expect(res.status).toBe(429)
    })

    it('enforces the per-key rate limit', async () => {
      await boot()
      const request = () =>
        fetch(`${baseUrl}/api/tts`, {
          method: 'POST',
          headers: { authorization: `Bearer ${REAL_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'bonjour', voiceId: 'v1', modelId: 'm1' }),
        })
      await request()
      await request()
      await request()
      const fourth = await request()
      expect(fourth.status).toBe(429)
    })
  })

  describe('POST /api/scan', () => {
    it('returns parsed phrases for a valid image upload', async () => {
      await boot({ anthropicFetch: fetchAnthropicOk([{ french: 'bonjour', english: 'hello' }]) })
      const res = await fetch(`${baseUrl}/api/scan`, {
        method: 'POST',
        headers: { authorization: `Bearer ${REAL_KEY}`, 'content-type': 'image/jpeg' },
        body: Buffer.from([0xff, 0xd8, 0xff, 0xdb]),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ phrases: [{ french: 'bonjour', english: 'hello' }] })
    })

    it('rejects an oversized image with 413', async () => {
      await boot()
      const res = await fetch(`${baseUrl}/api/scan`, {
        method: 'POST',
        headers: { authorization: `Bearer ${REAL_KEY}`, 'content-type': 'image/jpeg' },
        body: Buffer.alloc(7 * 1024 * 1024, 1),
      })
      expect(res.status).toBe(413)
    })

    it('rejects an empty body with 400', async () => {
      await boot()
      const res = await fetch(`${baseUrl}/api/scan`, {
        method: 'POST',
        headers: { authorization: `Bearer ${REAL_KEY}` },
        body: Buffer.alloc(0),
      })
      expect(res.status).toBe(400)
    })
  })

  describe('library sync', () => {
    it('GET returns 404 before anything has been pushed', async () => {
      await boot()
      const res = await fetch(`${baseUrl}/api/library`, { headers: { authorization: `Bearer ${REAL_KEY}` } })
      expect(res.status).toBe(404)
    })

    it('round-trips PUT then GET, and a different key sees nothing', async () => {
      await boot()
      const payload = { format: 'phrase-drill-library', schemaVersion: 1, decks: [{ id: 'd1', name: 'Café' }] }
      const put = await fetch(`${baseUrl}/api/library`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${REAL_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      expect(put.status).toBe(204)

      const get = await fetch(`${baseUrl}/api/library`, { headers: { authorization: `Bearer ${REAL_KEY}` } })
      expect(get.status).toBe(200)
      expect(await get.json()).toEqual(payload)

      const otherKey = 'b'.repeat(64)
      const getOther = await fetch(`${baseUrl}/api/library`, { headers: { authorization: `Bearer ${otherKey}` } })
      expect(getOther.status).toBe(404)
    })

    it('rejects a PUT body missing the required envelope shape', async () => {
      await boot()
      const res = await fetch(`${baseUrl}/api/library`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${REAL_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ nonsense: true }),
      })
      expect(res.status).toBe(400)
    })

    it('rejects an oversized library payload with 413', async () => {
      await boot()
      const res = await fetch(`${baseUrl}/api/library`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${REAL_KEY}`, 'content-type': 'application/json' },
        body: Buffer.alloc(9 * 1024 * 1024, 1),
      })
      expect(res.status).toBe(413)
    })
  })

  describe('secrets never leak', () => {
    it('no response body or header, across every route, ever contains either provider key', async () => {
      await boot({
        elevenLabsFetch: fetchElevenLabsOk(),
        anthropicFetch: fetchAnthropicOk([{ french: 'bonjour', english: 'hello' }]),
      })

      const responses = await Promise.all([
        fetch(`${baseUrl}/api/health`),
        fetch(`${baseUrl}/api/tts`, {
          method: 'POST',
          headers: { authorization: `Bearer ${REAL_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'bonjour', voiceId: 'v1', modelId: 'm1' }),
        }),
        fetch(`${baseUrl}/api/scan`, {
          method: 'POST',
          headers: { authorization: `Bearer ${REAL_KEY}`, 'content-type': 'image/jpeg' },
          body: Buffer.from([0xff, 0xd8]),
        }),
        fetch(`${baseUrl}/api/library`, { headers: { authorization: `Bearer ${REAL_KEY}` } }),
        fetch(`${baseUrl}/api/tts`, { headers: { authorization: 'Bearer bad' } }),
        fetch(`${baseUrl}/nonexistent-page`),
      ])

      for (const res of responses) {
        const headerText = JSON.stringify([...res.headers.entries()])
        expect(headerText).not.toContain(SECRET_ELEVENLABS_KEY)
        expect(headerText).not.toContain(SECRET_ANTHROPIC_KEY)
        const bodyBuf = Buffer.from(await res.arrayBuffer())
        const bodyText = bodyBuf.toString('latin1')
        expect(bodyText).not.toContain(SECRET_ELEVENLABS_KEY)
        expect(bodyText).not.toContain(SECRET_ANTHROPIC_KEY)
      }
    })

    it('no captured log line contains either provider key, including on an upstream failure', async () => {
      await boot({ elevenLabsFetch: fetchThatFailsWith(500) })
      await fetch(`${baseUrl}/api/tts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${REAL_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'bonjour', voiceId: 'v1', modelId: 'm1' }),
      })
      for (const line of logger.lines) {
        expect(line).not.toContain(SECRET_ELEVENLABS_KEY)
        expect(line).not.toContain(SECRET_ANTHROPIC_KEY)
      }
      // The real production logger (server/logger.js) is the one that performs
      // redaction; this collectingLogger only proves the app never *passes*
      // a raw secret into a log field to begin with (see logger.test.js for
      // the redaction guarantee itself).
      expect(logger.lines.length).toBeGreaterThan(0)
    })
  })
})
