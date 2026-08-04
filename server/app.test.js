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

const SECRET_ELEVENLABS_KEY = 'xi-live-secret-99999'
const SECRET_ANTHROPIC_KEY = 'anthropic-live-secret-88888'

// T050: identity is an opaque session token, a database row, not a JWT — no
// signature, no issuer/audience, no JWKS. `app.js` never touches a password
// or a token's bytes itself — it only calls the injected `sessionAuth`
// seam (`login`/`logout`/`verify`) and trusts what it returns (or rejects
// on any thrown error), so these tests fake that seam directly rather than
// running real scrypt/crypto. `server/session-auth.test.js` is what proves
// the real implementation's hashing, token generation, and expiry.
const VALID_TOKEN = 'valid-token-for-sub-1'
const SUB = 'user-1111'
const OTHER_TOKEN = 'valid-token-for-sub-2'
const OTHER_SUB = 'user-2222'
const VALID_USERNAME = 'her'
const VALID_PASSWORD = 'correct-password'

function fakeSessionAuth({
  tokenToClaims = new Map([[VALID_TOKEN, { sub: SUB }], [OTHER_TOKEN, { sub: OTHER_SUB }]]),
  credentials = new Map([[VALID_USERNAME, VALID_PASSWORD]]),
} = {}) {
  const loggedOut = new Set()
  return {
    tokenToClaims,
    async verify(token) {
      if (loggedOut.has(token)) throw new Error('session was logged out')
      const claims = tokenToClaims.get(token)
      if (!claims) throw new Error('invalid or expired token')
      return claims
    },
    async login(username, password) {
      if (credentials.get(username) !== password) return null
      const token = `issued-token-for-${username}`
      const claims = { sub: `user-for-${username}` }
      tokenToClaims.set(token, claims)
      return { token, expiresAt: 999_999 }
    },
    async logout(token) {
      loggedOut.add(token)
    },
  }
}

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

/** Same fake upstream, but for the structured-output shape `/api/translate`
 * expects back (`candidates`, not `phrases`) — kept distinct from
 * `fetchAnthropicOk` because the two routes ask the model different
 * questions and get different response shapes, even though both go through
 * the one `anthropic` provider/queue. */
function fetchAnthropicTranslateOk(candidates) {
  return async (url, init) => {
    if (init.headers['x-api-key'] !== SECRET_ANTHROPIC_KEY) throw new Error('wrong key used against fake upstream')
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ candidates }) }] }) }
  }
}

/** In-memory stand-in for a `pg` pool, same shape `db.test.js` uses — see its own comment. */
function fakePool() {
  let tableCreated = false
  const rows = new Map()
  return {
    async query(text, params = []) {
      const sql = text.trim()
      if (sql.startsWith('CREATE TABLE')) {
        tableCreated = true
        return { rows: [] }
      }
      if (sql.startsWith('SELECT')) {
        if (!tableCreated) throw new Error('relation "libraries" does not exist')
        const row = rows.get(params[0])
        return { rows: row ? [{ data: row.data, updatedAt: row.updatedAt }] : [] }
      }
      if (sql.startsWith('INSERT')) {
        if (!tableCreated) throw new Error('relation "libraries" does not exist')
        const [key, data, updatedAt] = params
        rows.set(key, { data, updatedAt })
        return { rows: [] }
      }
      throw new Error(`fakePool: unrecognized query: ${sql}`)
    },
    async end() {},
  }
}

async function newLibraryStore() {
  const store = createLibraryStore(fakePool())
  await store.init()
  return store
}

describe('server app (integration, fake upstreams)', () => {
  let server
  let baseUrl
  let libraryStore
  let distDir
  let logger

  async function boot({ elevenLabsFetch = fetchElevenLabsOk(), anthropicFetch = fetchAnthropicOk([]) } = {}) {
    libraryStore = await newLibraryStore()
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
      loginLimiter: createRateLimiter({ capacity: 5, refillMs: 60_000 }),
      translateLimiter: createRateLimiter({ capacity: 3, refillMs: 60_000 }),
      distDir,
      logger,
      sessionAuth: fakeSessionAuth(),
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
    await libraryStore.close()
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
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
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
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'x'.repeat(20_000), voiceId: 'v1', modelId: 'm1' }),
      })
      expect(res.status).toBe(413)
    })

    it('rejects an invalid request body with 400', async () => {
      await boot()
      const res = await fetch(`${baseUrl}/api/tts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: '' }),
      })
      expect(res.status).toBe(400)
    })

    it('returns 503 not-configured when the upstream key is missing, without ever leaking the (absent) key', async () => {
      libraryStore = await newLibraryStore()
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
        loginLimiter: createRateLimiter({ capacity: 5, refillMs: 60_000 }),
        translateLimiter: createRateLimiter({ capacity: 3, refillMs: 60_000 }),
        distDir,
        logger,
        sessionAuth: fakeSessionAuth(),
      })
      server = createServer(handleRequest)
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      baseUrl = `http://127.0.0.1:${server.address().port}`

      const res = await fetch(`${baseUrl}/api/tts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'bonjour', voiceId: 'v1', modelId: 'm1' }),
      })
      expect(res.status).toBe(503)
    })

    it('returns 429 when the upstream reports quota exhaustion after retrying', async () => {
      await boot({ elevenLabsFetch: fetchThatFailsWith(429) })
      const res = await fetch(`${baseUrl}/api/tts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'bonjour', voiceId: 'v1', modelId: 'm1' }),
      })
      expect(res.status).toBe(429)
    })

    it('enforces the per-key rate limit', async () => {
      await boot()
      const request = () =>
        fetch(`${baseUrl}/api/tts`, {
          method: 'POST',
          headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
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
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'image/jpeg' },
        body: Buffer.from([0xff, 0xd8, 0xff, 0xdb]),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ phrases: [{ french: 'bonjour', english: 'hello' }] })
    })

    it('rejects an oversized image with 413', async () => {
      await boot()
      const res = await fetch(`${baseUrl}/api/scan`, {
        method: 'POST',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'image/jpeg' },
        body: Buffer.alloc(7 * 1024 * 1024, 1),
      })
      expect(res.status).toBe(413)
    })

    it('rejects an empty body with 400', async () => {
      await boot()
      const res = await fetch(`${baseUrl}/api/scan`, {
        method: 'POST',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: Buffer.alloc(0),
      })
      expect(res.status).toBe(400)
    })
  })

  describe('POST /api/translate', () => {
    it('returns candidates for a valid request', async () => {
      await boot({
        anthropicFetch: fetchAnthropicTranslateOk([
          { text: 'Tu peux venir?', register: 'tu' },
          { text: 'Pouvez-vous venir?', register: 'vous' },
        ]),
      })
      const res = await fetch(`${baseUrl}/api/translate`, {
        method: 'POST',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Can you come?', direction: 'en-to-fr', deckName: 'friends' }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        candidates: [
          { text: 'Tu peux venir?', register: 'tu' },
          { text: 'Pouvez-vous venir?', register: 'vous' },
        ],
      })
    })

    it('rejects a request missing text with 400', async () => {
      await boot()
      const res = await fetch(`${baseUrl}/api/translate`, {
        method: 'POST',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ direction: 'en-to-fr', deckName: 'home' }),
      })
      expect(res.status).toBe(400)
    })

    it('rejects an invalid direction with 400', async () => {
      await boot()
      const res = await fetch(`${baseUrl}/api/translate`, {
        method: 'POST',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello', direction: 'sideways', deckName: 'home' }),
      })
      expect(res.status).toBe(400)
    })

    it('rejects an oversized body with 413', async () => {
      await boot()
      const res = await fetch(`${baseUrl}/api/translate`, {
        method: 'POST',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'x'.repeat(20_000), direction: 'en-to-fr', deckName: 'home' }),
      })
      expect(res.status).toBe(413)
    })

    it('enforces the per-key rate limit', async () => {
      await boot({ anthropicFetch: fetchAnthropicTranslateOk([{ text: 'Bonjour' }]) })
      const request = () =>
        fetch(`${baseUrl}/api/translate`, {
          method: 'POST',
          headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'hello', direction: 'en-to-fr', deckName: 'home' }),
        })
      await request()
      await request()
      await request()
      const fourth = await request()
      expect(fourth.status).toBe(429)
    })

    it('returns 503 when the upstream key is missing', async () => {
      libraryStore = await newLibraryStore()
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
        loginLimiter: createRateLimiter({ capacity: 5, refillMs: 60_000 }),
        translateLimiter: createRateLimiter({ capacity: 3, refillMs: 60_000 }),
        distDir,
        logger,
        sessionAuth: fakeSessionAuth(),
      })
      server = createServer(handleRequest)
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      baseUrl = `http://127.0.0.1:${server.address().port}`

      const res = await fetch(`${baseUrl}/api/translate`, {
        method: 'POST',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello', direction: 'en-to-fr', deckName: 'home' }),
      })
      expect(res.status).toBe(503)
    })

    it('never logs the phrase text alongside anything identifying', async () => {
      await boot({ anthropicFetch: fetchAnthropicTranslateOk([{ text: 'Bonjour tout le monde' }]) })
      const secretPhrase = 'a very particular english phrase she typed'
      await fetch(`${baseUrl}/api/translate`, {
        method: 'POST',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: secretPhrase, direction: 'en-to-fr', deckName: 'home' }),
      })
      for (const line of logger.lines) {
        expect(line).not.toContain(secretPhrase)
      }
    })
  })

  describe('library sync', () => {
    it('GET returns 404 before anything has been pushed', async () => {
      await boot()
      const res = await fetch(`${baseUrl}/api/library`, { headers: { authorization: `Bearer ${VALID_TOKEN}` } })
      expect(res.status).toBe(404)
    })

    it('round-trips PUT then GET, and a different key sees nothing', async () => {
      await boot()
      const payload = { format: 'phrase-drill-library', schemaVersion: 1, decks: [{ id: 'd1', name: 'Café' }] }
      const put = await fetch(`${baseUrl}/api/library`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      expect(put.status).toBe(204)

      const get = await fetch(`${baseUrl}/api/library`, { headers: { authorization: `Bearer ${VALID_TOKEN}` } })
      expect(get.status).toBe(200)
      expect(await get.json()).toEqual(payload)

      const getOther = await fetch(`${baseUrl}/api/library`, { headers: { authorization: `Bearer ${OTHER_TOKEN}` } })
      expect(getOther.status).toBe(404)
    })

    it('rejects a PUT body missing the required envelope shape', async () => {
      await boot()
      const res = await fetch(`${baseUrl}/api/library`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ nonsense: true }),
      })
      expect(res.status).toBe(400)
    })

    it('rejects an oversized library payload with 413', async () => {
      await boot()
      const res = await fetch(`${baseUrl}/api/library`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
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
          headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'bonjour', voiceId: 'v1', modelId: 'm1' }),
        }),
        fetch(`${baseUrl}/api/scan`, {
          method: 'POST',
          headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'image/jpeg' },
          body: Buffer.from([0xff, 0xd8]),
        }),
        fetch(`${baseUrl}/api/translate`, {
          method: 'POST',
          headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'hello', direction: 'en-to-fr', deckName: 'home' }),
        }),
        fetch(`${baseUrl}/api/library`, { headers: { authorization: `Bearer ${VALID_TOKEN}` } }),
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
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
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

  describe('POST /api/login', () => {
    it('returns a token and expiry for correct credentials, no auth header required', async () => {
      await boot()
      const res = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: VALID_USERNAME, password: VALID_PASSWORD }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.token).toBeTruthy()
      expect(body.expiresAt).toBeTypeOf('number')
    })

    it('the issued token authenticates subsequent /api/* calls', async () => {
      await boot()
      const login = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: VALID_USERNAME, password: VALID_PASSWORD }),
      })
      const { token } = await login.json()

      const res = await fetch(`${baseUrl}/api/library`, { headers: { authorization: `Bearer ${token}` } })
      expect(res.status).toBe(404) // authenticated, just nothing pushed yet — proves it wasn't a 401
    })

    it('returns 401 for a wrong password, with a body identical to a nonexistent username', async () => {
      await boot()
      const wrongPassword = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: VALID_USERNAME, password: 'not-the-password' }),
      })
      const noSuchUser = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'nobody-registered', password: 'anything' }),
      })
      expect(wrongPassword.status).toBe(401)
      expect(noSuchUser.status).toBe(401)
      expect(await wrongPassword.json()).toEqual(await noSuchUser.json())
    })

    it('rejects a malformed request body with 400', async () => {
      await boot()
      const res = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 123 }),
      })
      expect(res.status).toBe(400)
    })

    it('rate-limits hard, keyed by username, well before a real brute force gets anywhere', async () => {
      await boot()
      const attempt = () =>
        fetch(`${baseUrl}/api/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: VALID_USERNAME, password: 'wrong-every-time' }),
        })
      for (let i = 0; i < 5; i++) {
        const res = await attempt()
        expect(res.status).toBe(401)
      }
      const sixth = await attempt()
      expect(sixth.status).toBe(429)
    })

    it('never logs the password, on success or failure', async () => {
      await boot()
      await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: VALID_USERNAME, password: VALID_PASSWORD }),
      })
      await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: VALID_USERNAME, password: 'a-guessed-password' }),
      })
      for (const line of logger.lines) {
        expect(line).not.toContain(VALID_PASSWORD)
        expect(line).not.toContain('a-guessed-password')
      }
    })
  })

  describe('POST /api/logout', () => {
    it('deletes the session so the token no longer authenticates, and responds 204', async () => {
      await boot()
      const login = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: VALID_USERNAME, password: VALID_PASSWORD }),
      })
      const { token } = await login.json()

      const logout = await fetch(`${baseUrl}/api/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(logout.status).toBe(204)

      const after = await fetch(`${baseUrl}/api/library`, { headers: { authorization: `Bearer ${token}` } })
      expect(after.status).toBe(401)
    })

    it('is a harmless no-op with no bearer token at all', async () => {
      await boot()
      const res = await fetch(`${baseUrl}/api/logout`, { method: 'POST' })
      expect(res.status).toBe(204)
    })
  })
})
