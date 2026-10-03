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
import { createClipJobRunner } from './clip-job-runner.js'
import { createMemoryClipJobStore } from './clip-job-store.test-support.js'
import { validateClip } from './clip-validation.js'
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
const VALID_USERNAME = 'the-user'
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
 * A well-framed 200 whose body is too short to be a real clip — the shape
 * defect 2 (F6 audit) has zero defense against today: no minimum-size floor,
 * no checksum, no MP3 validity check anywhere between the provider response
 * and `clipStore.put`, which is `ON CONFLICT (hash) DO NOTHING` (`server/db.js`)
 * and so serves whatever landed first, forever.
 */
function fetchElevenLabsTruncated(byteLength) {
  const impl = async () => {
    impl.calls += 1
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(byteLength) }
  }
  impl.calls = 0
  return impl
}

/** A 2xx with the given content-type and body, counting calls. */
function fetchElevenLabsSending({ contentType, bytes }) {
  const impl = async () => {
    impl.calls += 1
    const headers = new Headers(contentType ? { 'content-type': contentType } : {})
    return { ok: true, status: 200, headers, arrayBuffer: async () => new Uint8Array(bytes).buffer }
  }
  impl.calls = 0
  return impl
}

/** A 2xx (billed) whose body then fails to read — the shape that used to be retried and re-billed. */
function fetchElevenLabsBodyFails() {
  const impl = async () => {
    impl.calls += 1
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => {
        throw new Error('premature close')
      },
    }
  }
  impl.calls = 0
  return impl
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
    bytes.set([0x49, 0x44, 0x33, impl.calls]) // 'ID3' + the call number
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'audio/mpeg' }), arrayBuffer: async () => bytes.buffer }
  }
  impl.calls = 0
  return impl
}

/**
 * An ElevenLabs upstream that refuses with a status AND a body — the body is
 * the point: `quota_exceeded` and `invalid_api_key` both arrive as 401, and
 * only the body says which.
 */
function fetchElevenLabsRefusing(status, body) {
  const impl = async () => {
    impl.calls += 1
    return { ok: false, status, json: async () => body, text: async () => JSON.stringify(body) }
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

/**
 * The clip job queue `/api/tts` waits on (S5): the contract-checked
 * in-memory job store and the real runner, with waits short enough for a
 * test. `retryDelayMs` is 1 ms so a retried failure exhausts its three
 * attempts inside one request's wait.
 */
function clipQueue({ elevenLabs, clipStore, logger }) {
  const clipJobStore = createMemoryClipJobStore()
  const clipJobRunner = createClipJobRunner({
    jobStore: clipJobStore,
    clipStore,
    elevenLabs,
    validateClip,
    logger,
    pollMs: 5,
    retryDelayMs: () => 1,
  })
  clipJobRunner.start()
  return { clipJobStore, clipJobRunner }
}

/**
 * A fake ElevenLabs that holds every synthesis until `release()` — a
 * generation that is still running when the request's wait runs out. The
 * credential probe (`/api/status`, text '.') is answered at once and not
 * counted, so reading the status mid-generation does not hang on it.
 */
function fetchElevenLabsHeld() {
  let release
  const gate = new Promise((resolve) => (release = resolve))
  const impl = async (_url, init) => {
    if (JSON.parse(init.body).text === '.') return { ok: true, status: 200 }
    impl.calls += 1
    await gate
    const bytes = new Uint8Array(1600)
    bytes.set([0x49, 0x44, 0x33, impl.calls])
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'audio/mpeg' }), arrayBuffer: async () => bytes.buffer }
  }
  impl.calls = 0
  impl.release = () => release()
  return impl
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
  /** The clip job queue this boot wired in (S5); stopped after each test. */
  let clipJobRunner
  let clipJobStore

  async function boot({
    elevenLabsFetch = fetchElevenLabsOk(),
    anthropicFetch = fetchAnthropicOk([]),
    // `undefined` is a real deployment state — the local dev stack and any
    // machine without the secret — and `/api/status` must say so rather than
    // probe with nothing. Passed explicitly so the default stays "configured".
    elevenLabsKey = SECRET_ELEVENLABS_KEY,
    // How long `/api/tts` waits on a generation before answering 202. Long
    // by default so a test that is not about the 202 never sees one.
    ttsWaitMs = 5_000,
  } = {}) {
    elevenLabsUpstream = elevenLabsFetch
    libraryStore = await newLibraryStore()
    clipStore = await newClipStore()
    distDir = mkdtempSync(join(tmpdir(), 'phrase-drill-dist-'))
    mkdirSync(join(distDir, 'assets'), { recursive: true })
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>phrase-drill</title>')
    writeFileSync(join(distDir, 'assets', 'app.js'), 'console.log("app")')

    logger = collectingLogger()
    const elevenLabs = createElevenLabsProvider({ apiKey: elevenLabsKey, fetchImpl: elevenLabsFetch })
    const queue = clipQueue({ elevenLabs, clipStore, logger })
    ;({ clipJobRunner, clipJobStore } = queue)
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
      ...queue,
      ttsWaitMs,
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
    await clipJobRunner?.stop()
    clipJobRunner = undefined
    await new Promise((resolve) => server.close(resolve))
    rmSync(distDir, { recursive: true, force: true })
  })

  it('GET /api/health returns ok with no auth required', async () => {
    await boot()
    const res = await fetch(`${baseUrl}/api/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  /**
   * `/api/status` (2026-09-02). Generation failing is invisible from outside
   * this process: `/api/tts` needs their session, the provider's verdict is
   * mapped to a lossy HTTP status on the way to the device, and the only
   * record is a log line on a host nobody watches. So "phrase-drill isn't
   * playing" cost a round trip through a non-technical user in another
   * country to answer at all. This endpoint answers it with one unauthenticated
   * GET: does the credential this server holds still work, and what has
   * `/api/tts` actually been doing.
   *
   * Deliberately public and deliberately coarse — a verdict and the
   * provider's own status word, never a key, never a number about the
   * account, never anything of theirs.
   */
  it('GET /api/status needs no auth and reports a working credential', async () => {
    await boot()
    const res = await fetch(`${baseUrl}/api/status`)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.tts.configured).toBe(true)
    expect(body.tts.credential).toBe('ok')
    expect(typeof body.tts.checkedAt).toBe('number')
    expect(JSON.stringify(body)).not.toContain(SECRET_ELEVENLABS_KEY)
  })

  it('reports a rejected credential, with the provider’s own word for it', async () => {
    await boot({ elevenLabsFetch: fetchElevenLabsRefusing(401, { detail: { status: 'invalid_api_key' } }) })
    const body = await (await fetch(`${baseUrl}/api/status`)).json()

    expect(body.tts.credential).toBe('rejected')
    expect(body.tts.detail).toBe('invalid_api_key')
  })

  /**
   * The distinction that matters most and is the easiest to lose: ElevenLabs
   * answers an exhausted account with **401**, the same status as a bad key.
   * "Rotate the key" and "pay the bill" are different actions, so the body's
   * own `status` decides, not the HTTP code.
   */
  it('tells an exhausted account apart from a bad key, though both are 401', async () => {
    await boot({ elevenLabsFetch: fetchElevenLabsRefusing(401, { detail: { status: 'quota_exceeded' } }) })
    const body = await (await fetch(`${baseUrl}/api/status`)).json()

    expect(body.tts.credential).toBe('no-credit')
    expect(body.tts.detail).toBe('quota_exceeded')
  })

  it('says the credential is missing rather than probing with nothing', async () => {
    const upstream = fetchElevenLabsOk()
    // `''`, not `undefined`: an unset or cleared platform variable arrives as
    // an empty string, which is the state this asserts about — and a
    // destructuring default would swallow `undefined` and hand the probe the
    // real key, so the test would pass while proving the opposite.
    await boot({ elevenLabsFetch: upstream, elevenLabsKey: '' })
    const body = await (await fetch(`${baseUrl}/api/status`)).json()

    expect(body.tts.configured).toBe(false)
    expect(body.tts.credential).toBe('unknown')
    expect(upstream.calls).toBe(0)
  })

  /**
   * A probe costs one character of their credit, so it is taken once and
   * reused. Without this, anything watching the endpoint on a loop would
   * spend the account it exists to report on.
   */
  it('probes the provider once and serves the cached verdict afterwards', async () => {
    const upstream = fetchElevenLabsOk()
    await boot({ elevenLabsFetch: upstream })

    const first = await (await fetch(`${baseUrl}/api/status`)).json()
    const second = await (await fetch(`${baseUrl}/api/status`)).json()

    expect(upstream.calls).toBe(1)
    expect(second.tts.checkedAt).toBe(first.tts.checkedAt)
  })

  /**
   * The counters are the half a probe cannot cover: they say what their device
   * actually got, so "generation has been failing for two days" is readable
   * without their phone and without a log console.
   */
  it('counts what /api/tts really answered, so a failing library sweep is visible', async () => {
    await boot({ elevenLabsFetch: fetchThatFailsWith(401) })

    const refused = await fetch(`${baseUrl}/api/tts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
      body: ttsBody(),
    })
    expect(refused.status).toBe(503)

    const body = await (await fetch(`${baseUrl}/api/status`)).json()
    expect(body.tts.requests.total).toBe(1)
    expect(body.tts.requests.failed).toBe(1)
    expect(body.tts.lastFailure.kind).toBe('not-configured')
    expect(typeof body.tts.lastFailure.at).toBe('number')
  })

  it('counts a served clip as served', async () => {
    await boot()

    const ok = await fetch(`${baseUrl}/api/tts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
      body: ttsBody(),
    })
    expect(ok.status).toBe(200)

    const body = await (await fetch(`${baseUrl}/api/status`)).json()
    expect(body.tts.requests.total).toBe(1)
    expect(body.tts.requests.failed).toBe(0)
    expect(body.tts.lastFailure).toBeUndefined()
  })

  /**
   * The month-long failure (2026-09-02 to 2026-10-03) was invisible because
   * `requests.total` could not tell cache hits from misses, nor count
   * provider calls: 65 successes looked like a working service while every
   * miss was billed and dropped. Hits, misses, attempts and billed failures
   * make that readable at a glance: misses far above stored clips is the bug.
   */
  describe('GET /api/status — the clip store and provider spend', () => {
    const post = (body = ttsBody()) =>
      fetch(`${baseUrl}/api/tts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body,
      })
    const status = async () => (await (await fetch(`${baseUrl}/api/status`)).json()).tts

    it('starts at zero, with an empty store', async () => {
      await boot()
      const tts = await status()
      expect(tts.clips).toEqual({ hits: 0, misses: 0, storeBytes: 0 })
      expect(tts.provider).toEqual({ calls: 0, billedFailures: 0 })
      expect(tts.queue).toEqual({ queued: 0, running: 0, failed: 0 })
    })

    it('counts a miss, then a hit, one provider call, and the stored bytes', async () => {
      await boot()
      await post()
      await post()
      const tts = await status()
      expect(tts.clips).toEqual({ hits: 1, misses: 1, storeBytes: 1600 })
      expect(tts.provider).toEqual({ calls: 1, billedFailures: 0 })
      expect(tts.requests).toEqual({ total: 2, failed: 0 })
    })

    it('counts every attempt including retries, and a retried 5xx is not a billed failure', async () => {
      await boot({ elevenLabsFetch: fetchThatFailsWith(500) }) // the runner's three attempts
      await post()
      const tts = await status()
      expect(tts.provider).toEqual({ calls: 3, billedFailures: 0 })
      expect(tts.queue).toEqual({ queued: 0, running: 0, failed: 1 })
    })

    it('reports a generation still running when its request gave up waiting', async () => {
      const upstream = fetchElevenLabsHeld()
      await boot({ elevenLabsFetch: upstream, ttsWaitMs: 50 })
      expect((await post()).status).toBe(202)
      expect((await status()).queue).toEqual({ queued: 0, running: 1, failed: 0 })
      upstream.release()
    })

    it('reports the queue as null, not an error, when the job store cannot be read', async () => {
      await boot()
      clipJobStore.counts = async () => {
        throw new Error('db down')
      }
      const res = await fetch(`${baseUrl}/api/status`)
      expect(res.status).toBe(200)
      expect((await res.json()).tts.queue).toBeNull()
    })

    it('does not count the credential probe as a provider call', async () => {
      await boot()
      await status() // runs the probe
      expect((await status()).provider.calls).toBe(0)
    })

    it('counts a body that failed after a 2xx as a billed failure', async () => {
      await boot({ elevenLabsFetch: fetchElevenLabsBodyFails() })
      await post()
      const tts = await status()
      expect(tts.provider).toEqual({ calls: 1, billedFailures: 1 })
      expect(tts.clips.storeBytes).toBe(0)
    })

    it('counts a clip that failed validation as a billed failure', async () => {
      await boot({ elevenLabsFetch: fetchElevenLabsSending({ contentType: 'application/json', bytes: Buffer.alloc(2000) }) })
      await post()
      expect((await status()).provider).toEqual({ calls: 1, billedFailures: 1 })
    })

    it('reports storeBytes as null, not an error, when the store cannot be summed', async () => {
      await boot()
      clipStore.totalBytes = async () => {
        throw new Error('db down')
      }
      const res = await fetch(`${baseUrl}/api/status`)
      expect(res.status).toBe(200)
      expect((await res.json()).tts.clips.storeBytes).toBeNull()
    })
  })

  /**
   * The other half of "why isn't it playing", and the one no probe can
   * reach: whether their phone is talking to THIS server at all.
   *
   * It matters because a second, three-week-old build of this app is still
   * live on GitHub Pages, has no server behind it, and calls the provider
   * directly from the device — a phone on that URL cannot generate anything
   * and cannot be distinguished from a phone with a broken credential by
   * anything visible here. The sync engine fetches `/api/library` at launch,
   * so a timestamp on that route answers it: the user opens the app, and either
   * this number moves or the user is not on this build.
   *
   * Aggregate only — a count and a time. Never a user id, never per-device:
   * there is one account, so "which device" is a question this endpoint has
   * no business answering and no need to.
   */
  it('reports when a device last synced, so "is the user even on this build" is answerable', async () => {
    await boot()

    const before = await (await fetch(`${baseUrl}/api/status`)).json()
    expect(before.library.reads).toBe(0)
    expect(before.library.writes).toBe(0)
    expect(before.library.lastAt).toBeUndefined()

    const read = await fetch(`${baseUrl}/api/library`, {
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    })
    // 404 — this account has pushed nothing yet — and that is the point: a
    // device that reached this server is a device that reached this server,
    // whatever the row says. Counting only successful reads would report a
    // freshly restored phone as absent.
    expect(read.status).toBe(404)

    const after = await (await fetch(`${baseUrl}/api/status`)).json()
    expect(after.library.reads).toBe(1)
    expect(after.library.writes).toBe(0)
    expect(typeof after.library.lastAt).toBe('number')
  })

  it('counts a push separately from a fetch, so a silent device is not read as an active one', async () => {
    await boot()

    const wrote = await fetch(`${baseUrl}/api/library`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'phrase-drill-library', schemaVersion: 1, decks: [] }),
    })
    expect(wrote.status).toBe(204)

    const body = await (await fetch(`${baseUrl}/api/status`)).json()
    expect(body.library.reads).toBe(0)
    expect(body.library.writes).toBe(1)
  })

  it('keeps the account out of /api/status entirely', async () => {
    await boot()
    await fetch(`${baseUrl}/api/library`, { headers: { authorization: `Bearer ${VALID_TOKEN}` } })

    const raw = await (await fetch(`${baseUrl}/api/status`)).text()
    expect(raw).not.toContain(SUB)
    expect(raw).not.toContain(VALID_TOKEN)
    expect(raw).not.toContain(VALID_USERNAME)
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
      const elevenLabs = createElevenLabsProvider({ apiKey: null })
      const anthropic = createAnthropicProvider({ apiKey: null, queue: createBoundedQueue({ concurrency: 2 }) })
      const queue = clipQueue({ elevenLabs, clipStore, logger })
      ;({ clipJobRunner, clipJobStore } = queue)
      const handleRequest = createApp({
        libraryStore,
        clipStore,
        elevenLabs,
        ...queue,
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

    /**
     * **An upstream 429 is a wait, not a wall — and this used to answer 402.**
     * T035 split "you are asking this server too fast" (our limiter, 429)
     * from "the provider is out of credits" (402) at the device boundary, and
     * that split is right. It was applied to the wrong signal here:
     * ElevenLabs answers a rate limit with **429** and an exhausted account
     * with **401 `quota_exceeded`**, so mapping 429 → 402 told the device
     * "this will never succeed" about the one provider failure that always
     * succeeds a second later. `generation-queue.ts` treats `quota` as
     * terminal and never retries it, so a burst during a cold sweep marked
     * Phrases permanently unready with no message — the same class of defect
     * T035 fixed, re-introduced one layer up.
     */
    it('returns 429 with Retry-After when the upstream rate-limits us', async () => {
      await boot({ elevenLabsFetch: fetchElevenLabsRefusing(429, { detail: { status: 'too_many_concurrent_requests' } }) })
      const res = await fetch(`${baseUrl}/api/tts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body: ttsBody(),
      })
      expect(res.status).toBe(429)
      expect(await res.json()).toEqual({ error: 'rate-limited' })
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    })

    it('returns 402 only when the upstream says the account is exhausted', async () => {
      await boot({ elevenLabsFetch: fetchElevenLabsRefusing(401, { detail: { status: 'quota_exceeded' } }) })
      const res = await fetch(`${baseUrl}/api/tts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body: ttsBody(),
      })
      expect(res.status).toBe(402)
      expect(await res.json()).toEqual({ error: 'quota' })
    })

    it('still returns 503 when the upstream rejects the key itself', async () => {
      await boot({ elevenLabsFetch: fetchElevenLabsRefusing(401, { detail: { status: 'invalid_api_key' } }) })
      const res = await fetch(`${baseUrl}/api/tts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body: ttsBody(),
      })
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'not-configured' })
    })

    // Defect 2 (F6 audit): a short body must not be cached as a complete
    // clip. Proven by the second request below still reaching the provider
    // — nothing was ever stored under the hash for the caller to replay.
    it('rejects an implausibly short clip body with 422, and does not cache it', async () => {
      await boot({ elevenLabsFetch: fetchElevenLabsTruncated(40) })

      const first = await fetch(`${baseUrl}/api/tts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body: ttsBody(),
      })
      expect(first.status).toBe(422)
      expect(await first.json()).toEqual({ error: 'unreadable' })

      const second = await fetch(`${baseUrl}/api/tts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body: ttsBody(),
      })
      expect(second.status).toBe(422)
      expect(elevenLabsUpstream.calls).toBe(2)
    })

    // Validation before caching: `put` is ON CONFLICT DO NOTHING, so the first
    // bytes stored under a hash are served to every device forever.
    describe.each([
      ['a JSON body served as application/json', { contentType: 'application/json', bytes: Buffer.alloc(2000, 0x7b) }],
      ['an MP3 with no content-type', { contentType: null, bytes: Buffer.from([0x49, 0x44, 0x33, ...Array(1997).fill(0)]) }],
      ['audio/mpeg bytes that are not an MP3', { contentType: 'audio/mpeg', bytes: Buffer.alloc(2000, 0x7b) }],
      ['an implausibly long body for the text', { contentType: 'audio/mpeg', bytes: Buffer.from([0x49, 0x44, 0x33, ...Array(200_000).fill(0)]) }],
    ])('%s', (_name, upstream) => {
      it('is answered 422 unreadable and never cached', async () => {
        await boot({ elevenLabsFetch: fetchElevenLabsSending(upstream) })
        const post = () =>
          fetch(`${baseUrl}/api/tts`, {
            method: 'POST',
            headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
            body: ttsBody(),
          })
        expect((await post()).status).toBe(422)
        expect((await post()).status).toBe(422)
        expect(elevenLabsUpstream.calls).toBe(2)
      })
    })

    // A billed failure is terminal on the device (R3). It used to be 502,
    // which the device reads as `network` and re-POSTs; the re-POST re-queued
    // the failed job and the provider billed a second time for one phrase.
    // 422 is the device's one terminal answer for "the server already spent
    // money on this and got nothing" — the body still names the real kind,
    // so `/api/status` and the logs keep the distinction.
    it('answers 422 billed-failure for a body that fails after a 2xx, with ONE provider call', async () => {
      await boot({ elevenLabsFetch: fetchElevenLabsBodyFails() })
      const res = await fetch(`${baseUrl}/api/tts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body: ttsBody(),
      })
      expect(res.status).toBe(422)
      expect(await res.json()).toEqual({ error: 'billed-failure' })
      expect(elevenLabsUpstream.calls).toBe(1)
    })

    // Every kind that names a call the provider already charged for, or a
    // request that will be refused identically every time, is 422: the
    // device's terminal `unreadable`. None of them may reach it as a 5xx.
    it.each([
      ['a clip that failed validation', fetchElevenLabsTruncated(40), 'unreadable'],
      ['a body lost after a billed 2xx', fetchElevenLabsBodyFails(), 'billed-failure'],
      ['a request the provider rejects', fetchElevenLabsRefusing(400, { detail: { status: 'invalid_request' } }), 'rejected-request'],
    ])('answers %s with a terminal 422, never a retryable 5xx', async (_name, upstream, kind) => {
      await boot({ elevenLabsFetch: upstream })
      const res = await fetch(`${baseUrl}/api/tts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body: ttsBody(),
      })
      expect(res.status).toBe(422)
      expect(await res.json()).toEqual({ error: kind })
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

    // S8a: '|' is the delimiter of the content address. In any field but the
    // text it would let two different requests share one address, and one of
    // them be served the other's audio. Refused before anything is spent.
    it.each(['provider', 'modelId', 'voiceId', 'lang'])('rejects a "|" in %s with 400, before the provider is called', async (field) => {
      await boot()

      const res = await tts(ttsBody({ [field]: 'a|b' }))

      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid-request' })
      expect(elevenLabsUpstream.calls).toBe(0)
    })

    it('accepts a "|" in the text', async () => {
      await boot()

      expect((await tts(ttsBody({ text: 'oui | non' }))).status).toBe(200)
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

  /**
   * S5. A miss is a job, not an inline provider call: the request queues it,
   * waits on it for a bounded time, and answers what it knows by then.
   *
   *   done          → 200 audio
   *   still running → 202 {status:'queued'}, Retry-After: 5 — the device asks
   *                   again; the clip is in the store by then
   *   failed        → the provider's kind, as before
   *   billing cap   → 422 unreadable, with no provider call at all
   */
  describe('POST /api/tts — the clip job queue (S5)', () => {
    const post = (body = ttsBody()) =>
      fetch(`${baseUrl}/api/tts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${VALID_TOKEN}`, 'content-type': 'application/json' },
        body,
      })

    it('answers 202 queued with Retry-After when the clip is not ready in time, and serves it on the re-poll', async () => {
      const upstream = fetchElevenLabsHeld()
      await boot({ elevenLabsFetch: upstream, ttsWaitMs: 50 })

      const first = await post()
      expect(first.status).toBe(202)
      expect(first.headers.get('retry-after')).toBe('5')
      expect(await first.json()).toEqual({ status: 'queued' })

      upstream.release()
      await new Promise((resolve) => setTimeout(resolve, 50))
      const again = await post()
      expect(again.status).toBe(200)
      expect(Buffer.from(await again.arrayBuffer()).byteLength).toBe(1600)
      expect(upstream.calls, 'one generation, served from the store on the re-poll').toBe(1)
    })

    it('a re-poll while the job still runs joins it rather than paying again', async () => {
      const upstream = fetchElevenLabsHeld()
      await boot({ elevenLabsFetch: upstream, ttsWaitMs: 30 })

      expect((await post()).status).toBe(202)
      expect((await post()).status).toBe(202)
      upstream.release()

      expect(upstream.calls).toBe(1)
    })

    // Two devices sweeping the same new deck used to pay twice.
    it('makes one provider call for concurrent requests for one phrase', async () => {
      const upstream = fetchElevenLabsHeld()
      await boot({ elevenLabsFetch: upstream })

      const both = Promise.all([post(), post()])
      await new Promise((resolve) => setTimeout(resolve, 30))
      upstream.release()
      const [a, b] = await both

      expect(a.status).toBe(200)
      expect(b.status).toBe(200)
      expect(upstream.calls).toBe(1)
    })

    // The month that was lost, bounded: whatever the next bug after a billed
    // 2xx is, one phrase costs at most two calls a day.
    it('refuses a third billed generation of one phrase in a day with 422, without calling the provider', async () => {
      await boot({ elevenLabsFetch: fetchElevenLabsBodyFails() })

      // Each billed failure is terminal on its own (R3); a device would not
      // ask again. This drives the server past that, as a second device or a
      // later Regenerate would, to show the cap holds regardless.
      expect((await post()).status).toBe(422)
      expect((await post()).status).toBe(422)
      const third = await post()

      expect(third.status).toBe(422)
      expect(await third.json()).toEqual({ error: 'unreadable' })
      expect(elevenLabsUpstream.calls).toBe(2)

      const tts = (await (await fetch(`${baseUrl}/api/status`)).json()).tts
      expect(tts.requests).toEqual({ total: 3, failed: 3 })
      expect(tts.lastFailure.kind).toBe('billing-capped')
    })

    // A request we built wrong is the same answer every time; 422 is terminal
    // on the device, where a 502 was read as a network blip and retried.
    it('answers a request the provider rejects with 422, after one call', async () => {
      await boot({ elevenLabsFetch: fetchElevenLabsRefusing(400, { detail: { status: 'invalid_request' } }) })

      const res = await post()

      expect(res.status).toBe(422)
      expect(await res.json()).toEqual({ error: 'rejected-request' })
      expect(elevenLabsUpstream.calls).toBe(1)
    })

    it('retries a 5xx inside the request’s wait and serves the clip that follows', async () => {
      let calls = 0
      const ok = fetchElevenLabsOk()
      await boot({
        elevenLabsFetch: async (url, init) => {
          calls += 1
          return calls === 1 ? { ok: false, status: 503 } : ok(url, init)
        },
      })

      const res = await post()

      expect(res.status).toBe(200)
      expect(calls).toBe(2)
    })

    it('serves a stored clip without touching the queue', async () => {
      await boot()
      await post()
      clipJobStore.request = async () => {
        throw new Error('the queue must not be asked on a hit')
      }

      expect((await post()).status).toBe(200)
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
      const elevenLabs = createElevenLabsProvider({ apiKey: null })
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
      const secretPhrase = 'a very particular english phrase the user typed'
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
     * Version skew (T060). Their phone runs the bundle it last installed, not
     * the one just deployed, so for a window there is an OLD client pushing
     * against a NEW envelope. An old client's `exportAll()` cannot carry a
     * field it has never heard of, so its push would silently strip the
     * Tombstones off the server copy — and every deleted Deck would come
     * back on the next sync. The server refuses that push instead: their old
     * device simply does not sync until it updates, and nothing of theirs is
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
     * so it follows them to a new phone. The server stores the envelope
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
     * tell a bug from their genuinely deleting a deck, and — decisively — the
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
     * its own failure. The user deletes a deck, that push shrinks the library, and
     * it must land — no refusal, no confirmation step the user cannot reach, and
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
     * 500 is the honest answer — the fault is the server's — and it is a
     * *handled* result at the device, not an exception. Since T089 the body
     * is a contract too: `library-unreadable` is the one verdict this server
     * gives on its own stored bytes, and it is what licenses the device to
     * push over the row (see the repair-loop test below). The row itself is
     * the last copy, so it is neither deleted nor overwritten here.
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

    it('logs the unreadable row as an error, so it is visible without waiting for them to report it', async () => {
      await boot()
      await libraryStore.put(SUB, 'not json at all', Date.now())
      await fetch(`${baseUrl}/api/library`, { headers: { authorization: `Bearer ${VALID_TOKEN}` } })

      expect(logger.lines.some((line) => line.includes('"level":"error"') && line.includes('unreadable'))).toBe(true)
    })

    it('still lets a client replace a corrupt stored row, and archives the corrupt bytes first', async () => {
      await boot()
      await libraryStore.put(SUB, 'not json at all', Date.now())

      // `storedSchemaVersion` answers 0 for an unparseable row, deliberately,
      // so a corrupt row can never lock them out of syncing (T060). The
      // corrupt bytes are still the only record of what went wrong, so they
      // go into the history rather than being dropped on the floor.
      expect((await putLibrary(library(['d1']))).status).toBe(204)
      const versions = await libraryStore.versions(SUB)
      expect(versions[0].data).toBe('not json at all')
    })

    /**
     * The repair loop, end to end (T089). The 500 above is the whole reason a
     * poisoned row used to be permanent: the pull failed, and a device that
     * could not read the server copy will not push over it, so the intact
     * library on their phone could never go back up.
     *
     * The server half of the way out is already open — `storedSchemaVersion`
     * answers 0 for an unreadable row, so the PUT is accepted, and the store
     * archives the bytes it replaces. What this pins is that the loop closes:
     * the same row that answered 500 answers 200 with their library afterwards,
     * with nothing run by hand against the database.
     *
     * `{"error":"library-unreadable"}` is the exact body the device keys on
     * (`src/adapters/sync/library-sync-client.ts`, `server-copy-unreadable`).
     * Change this string and sync stops repairing itself silently, so it is
     * asserted here rather than assumed.
     */
    it('a poisoned row is repaired by the next push: 500 library-unreadable, then 204, then their library back', async () => {
      await boot()
      await libraryStore.put(SUB, '{"schemaVersion":null}', Date.now())

      const before = await fetch(`${baseUrl}/api/library`, { headers: { authorization: `Bearer ${VALID_TOKEN}` } })
      expect(before.status).toBe(500)
      expect(await before.json()).toEqual({ error: 'library-unreadable' })

      expect((await putLibrary(library(['d1']))).status).toBe(204)

      const after = await fetch(`${baseUrl}/api/library`, { headers: { authorization: `Bearer ${VALID_TOKEN}` } })
      expect(after.status).toBe(200)
      expect((await after.json()).decks.map((d) => d.id)).toEqual(['d1'])

      // The poisoned bytes are kept, not dropped — they are the only record
      // of what went wrong.
      expect((await libraryStore.versions(SUB))[0].data).toBe('{"schemaVersion":null}')
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
