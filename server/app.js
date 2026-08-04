import { getBearerToken } from './auth.js'
import { computeClipHash } from './clip-hash.js'
import { readBody, sendJson, PayloadTooLargeError } from './http-helpers.js'
import { createStaticHandler } from './static.js'

const TTS_MAX_BODY_BYTES = 8_000 // a phrase is a sentence, not a document
const TTS_MAX_TEXT_CHARS = 2_000
const SCAN_MAX_BODY_BYTES = 6 * 1024 * 1024 // one downsized photo (device caps ~1600px/JPEG q0.85)
const LIBRARY_MAX_BODY_BYTES = 8 * 1024 * 1024 // ~6.5x the modelled 10,000-phrase export (docs/scale.md §4)
const LOGIN_MAX_BODY_BYTES = 2_000 // a username and password, not a document
const TRANSLATE_MAX_BODY_BYTES = 4_000 // one phrase plus a deck name, not a document
const TRANSLATE_MAX_TEXT_CHARS = 500
const LIBRARY_FORMAT = 'phrase-drill-library'

/**
 * The schema version of a stored envelope, read back out of the JSON the
 * server keeps opaque otherwise. `0` for anything unreadable or missing a
 * numeric version — the permissive answer, so a corrupt or ancient stored
 * row can never lock a client out of syncing.
 */
function storedSchemaVersion(data) {
  try {
    const version = JSON.parse(data).schemaVersion
    return typeof version === 'number' ? version : 0
  } catch {
    return 0
  }
}

/**
 * Builds the one request handler this server runs — every `/api/*` route
 * plus the static PWA fallback. Pure composition: every dependency (the
 * providers, the rate limiters, the library store, the logger) is injected,
 * so this module never itself imports `node:sqlite` or `fetch` and is
 * exercised in tests with fakes for all of them.
 */
export function createApp({
  libraryStore,
  clipStore,
  elevenLabs,
  anthropic,
  ttsLimiter,
  scanLimiter,
  libraryLimiter,
  loginLimiter,
  translateLimiter,
  distDir,
  logger,
  sessionAuth,
}) {
  const serveStatic = createStaticHandler(distDir)

  async function handleLogin(req, res) {
    let body
    try {
      body = await readBody(req, { maxBytes: LOGIN_MAX_BODY_BYTES })
    } catch (err) {
      if (err instanceof PayloadTooLargeError) return sendJson(res, 413, { error: 'payload-too-large' })
      throw err
    }

    let parsed
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      return sendJson(res, 400, { error: 'invalid-json' })
    }

    const { username, password } = parsed ?? {}
    if (typeof username !== 'string' || username.length === 0 || typeof password !== 'string' || password.length === 0) {
      return sendJson(res, 400, { error: 'invalid-request' })
    }

    // Rate-limited hard, keyed by username — 5 attempts per 60s
    // (buildServer wires the limiter's capacity/refillMs) — before
    // credentials are ever checked, so a brute force against one username
    // never even reaches the scrypt comparison after the fifth try.
    if (!loginLimiter.allow(username)) return sendJson(res, 429, { error: 'rate-limited' })

    // Never pass the password to the logger, in a field or a message — see
    // docs/server.md "Provable: no key can leak".
    const result = await sessionAuth.login(username, password)
    if (!result) return sendJson(res, 401, { error: 'invalid-credentials' })
    sendJson(res, 200, { token: result.token, expiresAt: result.expiresAt })
  }

  async function handleLogout(req, res) {
    const token = getBearerToken(req)
    if (token) await sessionAuth.logout(token)
    res.writeHead(204)
    res.end()
  }

  /**
   * Speech for one phrase, served from the shared Clip store when it can be
   * (T063).
   *
   * **The rate limiter stays in front, and a cache hit spends a token.** The
   * tempting alternative — free hits, since a hit costs no provider money —
   * puts an un-metered path behind a bearer token: a stolen one (docs/server.md
   * lists that in the threat model) could then pull audio out of Postgres as
   * fast as the process would serve it. A hit is still an authenticated
   * request doing a database read and streaming ~20 KB back, so it is still
   * work worth bounding. Note what this does *not* fix: a device sweeping a
   * whole library still hits the 60/60s ceiling on the second device exactly
   * as it did on the first. It gets there without spending money now, which
   * is a smaller bill, not a working sweep.
   */
  async function handleTts(req, res, key) {
    if (!ttsLimiter.allow(key)) return sendJson(res, 429, { error: 'rate-limited' })

    let body
    try {
      body = await readBody(req, { maxBytes: TTS_MAX_BODY_BYTES })
    } catch (err) {
      if (err instanceof PayloadTooLargeError) return sendJson(res, 413, { error: 'payload-too-large' })
      throw err
    }

    let parsed
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      return sendJson(res, 400, { error: 'invalid-json' })
    }

    // `provider` and `lang` are required even though the ElevenLabs call uses
    // neither: they are two of the five fields the Clip's content address is
    // derived from, and an address missing a field is a different address
    // from the one the device holds. Required outright, with no default
    // invented for a caller that omits them — a guessed `provider` would
    // silently key the shared store against a value nobody chose.
    const { text, voiceId, modelId, provider, lang } = parsed ?? {}
    if (
      typeof text !== 'string' ||
      text.length === 0 ||
      text.length > TTS_MAX_TEXT_CHARS ||
      typeof voiceId !== 'string' ||
      voiceId.length === 0 ||
      typeof modelId !== 'string' ||
      modelId.length === 0 ||
      typeof provider !== 'string' ||
      provider.length === 0 ||
      typeof lang !== 'string' ||
      lang.length === 0
    ) {
      return sendJson(res, 400, { error: 'invalid-request' })
    }

    const hash = computeClipHash({ provider, modelId, voiceId, lang, text })

    const cached = await clipStore.get(hash)
    if (cached) return sendClip(res, cached)

    try {
      const result = await elevenLabs.synthesize({ text, voiceId, modelId })
      const clip = { bytes: result.bytes, mime: 'audio/mpeg', durationMs: result.durationMs }
      // A failed write must not fail the request: these bytes have already
      // been generated and paid for, and the caller wants the audio far more
      // than it wants the store to be complete. The next request for this
      // phrase pays again — the cost of a store outage, not of a bug.
      try {
        await clipStore.put({ hash, ...clip, createdAt: Date.now() })
      } catch (err) {
        logger.warn('could not store generated clip', { hash, message: describeError(err) })
      }
      sendClip(res, clip)
    } catch (err) {
      sendJson(res, statusForProviderError(err), { error: err.kind ?? 'network' })
    }
  }

  async function handleScan(req, res, key) {
    if (!scanLimiter.allow(key)) return sendJson(res, 429, { error: 'rate-limited' })

    let body
    try {
      body = await readBody(req, { maxBytes: SCAN_MAX_BODY_BYTES })
    } catch (err) {
      if (err instanceof PayloadTooLargeError) return sendJson(res, 413, { error: 'payload-too-large' })
      throw err
    }
    if (body.length === 0) return sendJson(res, 400, { error: 'invalid-request' })

    const contentType = req.headers['content-type']
    const mediaType = typeof contentType === 'string' && contentType.startsWith('image/') ? contentType : 'image/jpeg'

    try {
      const phrases = await anthropic.scan({ base64: body.toString('base64'), mediaType })
      sendJson(res, 200, { phrases })
    } catch (err) {
      sendJson(res, statusForProviderError(err), { error: err.kind ?? 'network' })
    }
  }

  async function handleTranslate(req, res, key) {
    if (!translateLimiter.allow(key)) return sendJson(res, 429, { error: 'rate-limited' })

    let body
    try {
      body = await readBody(req, { maxBytes: TRANSLATE_MAX_BODY_BYTES })
    } catch (err) {
      if (err instanceof PayloadTooLargeError) return sendJson(res, 413, { error: 'payload-too-large' })
      throw err
    }

    let parsed
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      return sendJson(res, 400, { error: 'invalid-json' })
    }

    const { text, direction, deckName } = parsed ?? {}
    if (
      typeof text !== 'string' ||
      text.length === 0 ||
      text.length > TRANSLATE_MAX_TEXT_CHARS ||
      (direction !== 'en-to-fr' && direction !== 'fr-to-en') ||
      typeof deckName !== 'string'
    ) {
      return sendJson(res, 400, { error: 'invalid-request' })
    }

    try {
      const candidates = await anthropic.translate({ text, direction, deckName })
      sendJson(res, 200, { candidates })
    } catch (err) {
      sendJson(res, statusForProviderError(err), { error: err.kind ?? 'network' })
    }
  }

  async function handleLibraryGet(req, res, key) {
    if (!libraryLimiter.allow(key)) return sendJson(res, 429, { error: 'rate-limited' })
    const row = await libraryStore.get(key)
    if (!row) return sendJson(res, 404, { error: 'not-found' })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(row.data)
  }

  async function handleLibraryPut(req, res, key) {
    if (!libraryLimiter.allow(key)) return sendJson(res, 429, { error: 'rate-limited' })

    let body
    try {
      body = await readBody(req, { maxBytes: LIBRARY_MAX_BODY_BYTES })
    } catch (err) {
      if (err instanceof PayloadTooLargeError) return sendJson(res, 413, { error: 'payload-too-large' })
      throw err
    }

    let parsed
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      return sendJson(res, 400, { error: 'invalid-json' })
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.format !== LIBRARY_FORMAT ||
      typeof parsed.schemaVersion !== 'number' ||
      !Array.isArray(parsed.decks) ||
      (parsed.mixes !== undefined && !Array.isArray(parsed.mixes)) ||
      (parsed.tombstones !== undefined && !Array.isArray(parsed.tombstones))
    ) {
      return sendJson(res, 400, { error: 'invalid-request' })
    }

    // A client older than the stored envelope may not overwrite it (T060).
    //
    // Her devices do not update together: one runs the bundle just
    // deployed, the other the bundle it last installed. An old client's
    // whole-library push is honest about what it knows and silent about
    // what it does not — it cannot carry a field its build has never heard
    // of. Letting it write would strip the newer envelope's merge metadata
    // (the Tombstones) off the server copy, and every Deck she deleted
    // would come back on the next sync.
    //
    // Refusing costs that device its sync until it updates — hours, and its
    // own changes stay safe on the device and go up afterwards. Accepting
    // costs her data. This is the one place both devices' pushes pass
    // through, so it is the only place the rule can be enforced for a
    // client that does not know the rule exists.
    const stored = await libraryStore.get(key)
    if (stored && parsed.schemaVersion < storedSchemaVersion(stored.data)) {
      return sendJson(res, 409, { error: 'stale-client' })
    }

    await libraryStore.put(key, JSON.stringify(parsed), Date.now())
    res.writeHead(204)
    res.end()
  }

  return async function handleRequest(req, res) {
    const started = Date.now()
    try {
      const url = new URL(req.url, 'http://internal')

      if (url.pathname === '/api/health') {
        sendJson(res, 200, { status: 'ok' })
        return
      }

      if (url.pathname === '/api/login' && req.method === 'POST') return await handleLogin(req, res)
      if (url.pathname === '/api/logout' && req.method === 'POST') return await handleLogout(req, res)

      if (url.pathname.startsWith('/api/')) {
        const token = getBearerToken(req)
        let claims = null
        if (token) {
          try {
            claims = await sessionAuth.verify(token)
          } catch {
            claims = null
          }
        }
        if (!claims || typeof claims.sub !== 'string' || claims.sub.length === 0) {
          sendJson(res, 401, { error: 'unauthorized' })
          return
        }
        // Her library is keyed by the session's user id (T050) — a stable,
        // server-issued identity, never a value the device could pick or a
        // pasted key someone else could hand out.
        const key = claims.sub

        if (url.pathname === '/api/tts' && req.method === 'POST') return await handleTts(req, res, key)
        if (url.pathname === '/api/scan' && req.method === 'POST') return await handleScan(req, res, key)
        if (url.pathname === '/api/translate' && req.method === 'POST') return await handleTranslate(req, res, key)
        if (url.pathname === '/api/library' && req.method === 'GET') return await handleLibraryGet(req, res, key)
        if (url.pathname === '/api/library' && req.method === 'PUT') return await handleLibraryPut(req, res, key)

        sendJson(res, 404, { error: 'not-found' })
        return
      }

      await serveStatic(req, res, url.pathname)
    } catch (err) {
      logger.error('unhandled request error', { message: describeError(err) })
      if (!res.headersSent) sendJson(res, 500, { error: 'server-error' })
    } finally {
      logger.info('request', {
        method: req.method,
        path: req.url,
        status: res.statusCode,
        ms: Date.now() - started,
      })
    }
  }
}

/** One response shape for a Clip, whether it came from the store or the provider — the caller cannot tell, and must not have to. */
function sendClip(res, clip) {
  res.writeHead(200, {
    'content-type': clip.mime,
    'content-length': clip.bytes.byteLength,
    'x-duration-ms': String(clip.durationMs),
  })
  res.end(clip.bytes)
}

function statusForProviderError(err) {
  switch (err.kind) {
    case 'not-configured':
      return 503
    case 'quota':
      return 429
    case 'unreadable':
      return 422
    default:
      return 502
  }
}

function describeError(err) {
  return err instanceof Error ? err.message : String(err)
}
