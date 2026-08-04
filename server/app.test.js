// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.js'
import { createLibraryStore, createClipStore } from './db.js'
import { fakeLibraryPool, fakeClipPool } from './pool.test-support.js'
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

/**
 * The fake ElevenLabs upstream, counting its own calls. `calls` is the whole
 * point of T063: the shared Clip store exists so that the same phrase in the
 * same voice is paid for once, on any device, ever — and the only way to
 * assert that is on the provider's call count, not on the response bodies
 * (which are identical either way).
 */
function fetchElevenLabsOk() {
  const impl = async (url, init) => {
    if (init.headers['xi-api-key'] !== SECRET_ELEVENLABS_KEY) throw new Error('wrong key used against fake upstream')
    impl.calls += 1
    // Distinguishable bytes per call, so a test can tell a replayed cached
    // clip from a freshly generated one.
    const bytes = new Uint8Array(1600)
    bytes[0] = impl.calls
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer }
  }
  impl.calls = 0
  return impl
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

async function newLibraryStore() {
  const store = createLibraryStore(fakeLibraryPool())
  await store.init()
  return store
}

async function newClipStore(options) {
  const store = createClipStore(fakeClipPool(), options)
  await store.init()
  return store
}

/** Every field `/api/tts` needs to derive the content address (T063). */
function ttsBody(overrides = {}) {
  return JSON.stringify({ text: 'bonjour', voiceId: 'v1', modelId: 'm1', provider: 'elevenlabs', lang: 'fr-FR', ...overrides })
}

describe('server app (integration, fake upstreams)', () => {
  let server
  let baseUrl
  let libraryStore
  let distDir
  let logger
  let clipStore
  /** The counting fake upstream this boot wired in — `.calls` is what the T063 tests assert on. */
  let elevenLabsUpstream

  async function boot({ elevenLabsFetch = fetchElevenLabsOk(), anthropicFetch = fetchAnthropicOk([]) } = {}) {
    elevenLabsUpstream = elevenLabsFetch
    libraryStore = await newLibraryStore()
    clipStore = await newClipStore()
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
      clipStore,
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
        body: ttsBody(),
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
        body: ttsBody({ text: 'x'.repeat(20_000) }),
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
      clipStore = await newClipStore()
      distDir = mkdtempSync(join(tmpdir(), 'phrase-drill-dist-'))
      writeFileSync(join(distDir, 'index.html'), '<!doctype html>')
      logger = collectingLogger()
      const elevenLabs = createElevenLabsProvider({ apiKey: null, queue: createBoundedQueue({ concurrency: 4 }) })
      const anthropic = createAnthropicProvider({ apiKey: null, queue: createBoundedQueue({ concurrency: 2 }) })
      const handleRequest = createApp({
        libraryStore,
        clipStore,
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
        body: ttsBody(),
      })
      expect(res.status).toBe(503)
    })

    // T035: 402, not 429. "The provider is out of credits" and "you are
    // asking this server too fast" are different facts with different
    // remedies, and collapsing them onto one status is what made a whole
    // library's worth of Phrases die on our own limiter.
    it('returns 402 when the upstream reports quota exhaustion after retrying', async () => {
      await boot({ elevenLabsFetch: fetchThatFailsWith(429) })
      const res = await fetch(`${baseUrl}/api/tts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body: ttsBody(),
      })
      expect(res.status).toBe(402)
      expect(await res.json()).toEqual({ error: 'quota' })
      expect(res.headers.get('retry-after')).toBe(null)
    })

    it('enforces the per-key rate limit, and says how long to wait', async () => {
      await boot()
      const request = () =>
        fetch(`${baseUrl}/api/tts`, {
          method: 'POST',
          headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
          body: ttsBody(),
        })
      await request()
      await request()
      await request()
      const fourth = await request()
      expect(fourth.status).toBe(429)
      expect(await fourth.json()).toEqual({ error: 'rate-limited' })
      // capacity 3 per 60s in this harness: one token back every 20s.
      expect(Number(fourth.headers.get('retry-after'))).toBe(20)
    })
  })

  describe('POST /api/tts — the shared Clip store (T063)', () => {
    function tts(body, token = VALID_TOKEN) {
      return fetch(`${baseUrl}/api/tts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
      })
    }

    // THE acceptance test. Every device used to pay to generate the same
    // audio again: the content address was computed on the device and never
    // sent anywhere, so the server had no way to know it had made this exact
    // clip before. Two identical requests, one provider call.
    it('calls the provider exactly once for two identical requests', async () => {
      await boot()

      const first = await tts(ttsBody())
      const second = await tts(ttsBody())

      expect(elevenLabsUpstream.calls).toBe(1)
      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
    })

    it('replays the stored bytes on the second request, not a fresh generation', async () => {
      await boot()

      const firstBytes = Buffer.from(await (await tts(ttsBody())).arrayBuffer())
      const secondRes = await tts(ttsBody())
      const secondBytes = Buffer.from(await secondRes.arrayBuffer())

      expect(secondBytes.equals(firstBytes)).toBe(true)
      expect(secondRes.headers.get('content-type')).toBe('audio/mpeg')
      expect(secondRes.headers.get('x-duration-ms')).toBe('100')
    })

    // The store is content-addressed, not per-user: the whole point is that
    // a *second device* — and, at this scale, a second account — does not pay
    // again for audio the server already holds. Nothing is disclosed by that:
    // to reach a stored clip you must already know its exact provider, model,
    // voice, language and text.
    it('serves a clip generated for one session to a different session', async () => {
      await boot()

      await tts(ttsBody(), VALID_TOKEN)
      await tts(ttsBody(), OTHER_TOKEN)

      expect(elevenLabsUpstream.calls).toBe(1)
    })

    it('calls the provider again when any field of the content address differs', async () => {
      await boot()

      await tts(ttsBody())
      await tts(ttsBody({ text: 'salut' }))
      await tts(ttsBody({ lang: 'en-US' }))

      expect(elevenLabsUpstream.calls).toBe(3)
    })

    // A cache hit is still an authenticated request doing a database read and
    // streaming audio back, so it spends a token like any other. Stated
    // outright because the opposite is tempting and wrong: making hits free
    // would put an un-metered path behind a bearer token.
    it('charges a cache hit against the rate limit, same as a miss', async () => {
      await boot() // ttsLimiter capacity is 3 in this harness

      await tts(ttsBody())
      await tts(ttsBody())
      await tts(ttsBody())
      const fourth = await tts(ttsBody())

      expect(fourth.status).toBe(429)
      expect(elevenLabsUpstream.calls).toBe(1)
    })

    it('rejects a request that omits the fields the content address is derived from', async () => {
      await boot()

      const noProvider = await tts(JSON.stringify({ text: 'bonjour', voiceId: 'v1', modelId: 'm1', lang: 'fr-FR' }))
      const noLang = await tts(JSON.stringify({ text: 'bonjour', voiceId: 'v1', modelId: 'm1', provider: 'elevenlabs' }))

      expect(noProvider.status).toBe(400)
      expect(noLang.status).toBe(400)
      expect(elevenLabsUpstream.calls).toBe(0)
    })

    // The device already paid for these bytes; a store that is down or full
    // must not turn a successful generation into a failed request.
    it('still returns the audio when writing it to the store fails', async () => {
      await boot()
      clipStore.put = async () => {
        throw new Error('disk full')
      }

      const res = await tts(ttsBody())

      expect(res.status).toBe(200)
      expect(Buffer.from(await res.arrayBuffer()).byteLength).toBe(1600)
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
        clipStore,
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

    /**
     * Version skew (T060). Her phone runs the bundle it last installed, not
     * the one just deployed, so for a window there is an OLD client pushing
     * against a NEW envelope. An old client's `exportAll()` cannot carry a
     * field it has never heard of, so its push would silently strip the
     * Tombstones off the server copy — and every deleted Deck would come
     * back on the next sync. The server refuses that push instead: her old
     * device simply does not sync until it updates, and nothing of hers is
     * destroyed in the meantime.
     */
    it('refuses a push from a client older than the stored envelope, and keeps the stored one intact', async () => {
      await boot()
      const current = {
        format: 'phrase-drill-library',
        schemaVersion: 5,
        exportedAt: 2,
        decks: [{ id: 'd1', name: 'Café', phrases: [], createdAt: 1, updatedAt: 1 }],
        mixes: [],
        tombstones: [{ id: 'gone', kind: 'deck', deletedAt: 9 }],
      }
      const first = await fetch(`${baseUrl}/api/library`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(current),
      })
      expect(first.status).toBe(204)

      const fromOldClient = {
        format: 'phrase-drill-library',
        schemaVersion: 4,
        exportedAt: 3,
        decks: [{ id: 'gone', name: 'Deleted elsewhere', phrases: [], createdAt: 1, updatedAt: 1 }],
        mixes: [],
      }
      const stale = await fetch(`${baseUrl}/api/library`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(fromOldClient),
      })
      expect(stale.status).toBe(409)

      const get = await fetch(`${baseUrl}/api/library`, { headers: { authorization: `Bearer ${VALID_TOKEN}` } })
      expect(await get.json()).toEqual(current)
    })

    it('accepts a push at the same schema version as the stored envelope', async () => {
      await boot()
      const envelope = { format: 'phrase-drill-library', schemaVersion: 5, exportedAt: 1, decks: [], mixes: [], tombstones: [] }
      for (const exportedAt of [1, 2]) {
        const res = await fetch(`${baseUrl}/api/library`, {
          method: 'PUT',
          headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ ...envelope, exportedAt }),
        })
        expect(res.status).toBe(204)
      }
    })

    it('rejects a PUT whose tombstones field is present but not an array', async () => {
      await boot()
      const res = await fetch(`${baseUrl}/api/library`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ format: 'phrase-drill-library', schemaVersion: 5, decks: [], tombstones: 'nope' }),
      })
      expect(res.status).toBe(400)
    })

    /**
     * T067 — the pinned voice rides in the envelope as its own named field,
     * so it follows her to a new phone. The server stores the envelope
     * verbatim; all it owes the field is the same shallow check `mixes` and
     * `tombstones` get, so a malformed one is refused at the door rather
     * than handed to the other device.
     */
    it('stores and returns the pinned voice an envelope carries', async () => {
      await boot()
      const voice = { provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-1' }
      const envelope = { format: 'phrase-drill-library', schemaVersion: 6, exportedAt: 1, decks: [], mixes: [], tombstones: [], voice }
      const put = await fetch(`${baseUrl}/api/library`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
      })
      expect(put.status).toBe(204)

      const get = await fetch(`${baseUrl}/api/library`, { headers: { authorization: `Bearer ${VALID_TOKEN}` } })
      expect((await get.json()).voice).toEqual(voice)
    })

    it('accepts an envelope with no voice field at all — absent means no voice recorded, never invalid', async () => {
      await boot()
      const res = await fetch(`${baseUrl}/api/library`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ format: 'phrase-drill-library', schemaVersion: 6, exportedAt: 1, decks: [] }),
      })
      expect(res.status).toBe(204)
    })

    it('rejects a PUT whose voice field is present but not an object', async () => {
      await boot()
      const res = await fetch(`${baseUrl}/api/library`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ format: 'phrase-drill-library', schemaVersion: 6, decks: [], voice: 'Rachel' }),
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

    /**
     * T071, against AUDIT-T068 finding 10: the stored library was replaced
     * wholesale with no prior version kept, so a client bug or a
     * half-migrated device could push an empty envelope and destroy the only
     * off-device copy.
     *
     * The defence built is **recoverability, not refusal**. The server cannot
     * tell a bug from her genuinely deleting a deck, and — decisively — the
     * deployed client maps every status it does not recognise to `network`
     * and retries it forever (`library-sync-client.ts`), so a new refusal
     * status would present as a sync that says "waiting" and never
     * completes. That is finding 2's silent death, bought with finding 10's
     * money. So every well-formed push is still accepted, and the version it
     * replaced is kept.
     */
    async function putLibrary(body, token = VALID_TOKEN) {
      return fetch(`${baseUrl}/api/library`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    }

    function library(decks, extra = {}) {
      return {
        format: 'phrase-drill-library',
        schemaVersion: 6,
        exportedAt: 1,
        decks: decks.map((id) => ({ id, name: id, phrases: [], createdAt: 1, updatedAt: 1 })),
        mixes: [],
        tombstones: [],
        ...extra,
      }
    }

    it('keeps the replaced version when a push would destroy the stored library', async () => {
      await boot()
      expect((await putLibrary(library(['d1', 'd2']))).status).toBe(204)

      // The bad push: a valid envelope carrying nothing. Accepted, 204.
      expect((await putLibrary(library([], { exportedAt: 2 }))).status).toBe(204)

      const get = await fetch(`${baseUrl}/api/library`, { headers: { authorization: `Bearer ${VALID_TOKEN}` } })
      expect((await get.json()).decks).toEqual([])

      // ...and what it destroyed is still on the server, recoverable.
      const versions = await libraryStore.versions(SUB)
      expect(versions.length).toBe(1)
      expect(JSON.parse(versions[0].data).decks.map((d) => d.id)).toEqual(['d1', 'd2'])
    })

    it('never lets one key see or restore another key’s archived versions', async () => {
      await boot()
      await putLibrary(library(['d1']))
      await putLibrary(library(['d2'], { exportedAt: 2 }))
      await putLibrary(library(['other']), OTHER_TOKEN)

      expect((await libraryStore.versions(SUB)).length).toBe(1)
      expect(await libraryStore.versions(OTHER_SUB)).toEqual([])
    })

    /**
     * The other half of the same rule: a defence that cannot be got past is
     * its own failure. She deletes a deck, that push shrinks the library, and
     * it must land — no refusal, no confirmation step she cannot reach, and
     * the deletion must survive a re-read.
     */
    it('accepts a legitimate deletion and keeps it deleted', async () => {
      await boot()
      expect((await putLibrary(library(['keep', 'bin']))).status).toBe(204)

      const afterDelete = library(['keep'], { exportedAt: 2, tombstones: [{ id: 'bin', kind: 'deck', deletedAt: 5 }] })
      expect((await putLibrary(afterDelete)).status).toBe(204)

      const get = await fetch(`${baseUrl}/api/library`, { headers: { authorization: `Bearer ${VALID_TOKEN}` } })
      expect(get.status).toBe(200)
      expect(await get.json()).toEqual(afterDelete)
    })

    it('accepts a deletion that empties the library, however many times it is repeated', async () => {
      await boot()
      await putLibrary(library(['d1', 'd2']))
      for (const exportedAt of [2, 3]) {
        expect((await putLibrary(library([], { exportedAt }))).status).toBe(204)
      }
      // Read through the store, not a fourth HTTP call — the library limiter
      // is wired to 3/window in these tests.
      expect(JSON.parse((await libraryStore.get(SUB)).data).decks).toEqual([])
    })

    /**
     * T071, against AUDIT-T068 finding 10's second half. `res.end(row.data)`
     * streamed the stored TEXT back unvalidated; the device called
     * `response.json()` on a 200, it threw, and the sync engine died for the
     * whole session while the UI still said "syncing".
     *
     * 500 is the honest answer — the fault is the server's — and the client
     * already maps it to `network`, which is a *handled* result it retries,
     * not an exception. The row itself is the last copy, so it is neither
     * deleted nor overwritten here.
     */
    it('answers 500 library-unreadable instead of streaming back a stored row that will not parse', async () => {
      await boot()
      const corrupt = '{"format":"phrase-drill-library","schemaVersion":6,"decks":['
      await libraryStore.put(SUB, corrupt, Date.now())

      const res = await fetch(`${baseUrl}/api/library`, { headers: { authorization: `Bearer ${VALID_TOKEN}` } })
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'library-unreadable' })

      // Still there, byte for byte — the read path never repairs, deletes or
      // rewrites the only copy it has.
      expect((await libraryStore.get(SUB)).data).toBe(corrupt)
    })

    it('answers 500 library-unreadable for a stored row that parses but is not a library envelope', async () => {
      await boot()
      await libraryStore.put(SUB, JSON.stringify({ hello: 'world' }), Date.now())

      const res = await fetch(`${baseUrl}/api/library`, { headers: { authorization: `Bearer ${VALID_TOKEN}` } })
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'library-unreadable' })
    })

    it('logs the unreadable row as an error, so it is visible without waiting for her to report it', async () => {
      await boot()
      await libraryStore.put(SUB, 'not json at all', Date.now())
      await fetch(`${baseUrl}/api/library`, { headers: { authorization: `Bearer ${VALID_TOKEN}` } })

      expect(logger.lines.some((line) => line.includes('"level":"error"') && line.includes('unreadable'))).toBe(true)
    })

    it('still lets a client replace a corrupt stored row, and archives the corrupt bytes first', async () => {
      await boot()
      await libraryStore.put(SUB, 'not json at all', Date.now())

      // `storedSchemaVersion` answers 0 for an unparseable row, deliberately,
      // so a corrupt row can never lock her out of syncing (T060). The
      // corrupt bytes are still the only record of what went wrong, so they
      // go into the history rather than being dropped on the floor.
      expect((await putLibrary(library(['d1']))).status).toBe(204)
      const versions = await libraryStore.versions(SUB)
      expect(versions[0].data).toBe('not json at all')
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
          body: ttsBody(),
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
        body: ttsBody(),
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
      // Every rate-limited response carries the wait, not just /api/tts —
      // one helper writes them all (T035).
      expect(Number(sixth.headers.get('retry-after'))).toBe(12)
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
