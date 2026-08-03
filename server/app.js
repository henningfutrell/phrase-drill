import { getBearerToken, isValidLibraryKey } from './auth.js'
import { readBody, sendJson, PayloadTooLargeError } from './http-helpers.js'
import { createStaticHandler } from './static.js'

const TTS_MAX_BODY_BYTES = 8_000 // a phrase is a sentence, not a document
const TTS_MAX_TEXT_CHARS = 2_000
const SCAN_MAX_BODY_BYTES = 6 * 1024 * 1024 // one downsized photo (device caps ~1600px/JPEG q0.85)
const LIBRARY_MAX_BODY_BYTES = 8 * 1024 * 1024 // ~6.5x the modelled 10,000-phrase export (docs/scale.md §4)
const LIBRARY_FORMAT = 'phrase-drill-library'

/**
 * Builds the one request handler this server runs — every `/api/*` route
 * plus the static PWA fallback. Pure composition: every dependency (the
 * providers, the rate limiters, the library store, the logger) is injected,
 * so this module never itself imports `node:sqlite` or `fetch` and is
 * exercised in tests with fakes for all of them.
 */
export function createApp({ libraryStore, elevenLabs, anthropic, ttsLimiter, scanLimiter, libraryLimiter, distDir, logger }) {
  const serveStatic = createStaticHandler(distDir)

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

    const { text, voiceId, modelId } = parsed ?? {}
    if (
      typeof text !== 'string' ||
      text.length === 0 ||
      text.length > TTS_MAX_TEXT_CHARS ||
      typeof voiceId !== 'string' ||
      voiceId.length === 0 ||
      typeof modelId !== 'string' ||
      modelId.length === 0
    ) {
      return sendJson(res, 400, { error: 'invalid-request' })
    }

    try {
      const result = await elevenLabs.synthesize({ text, voiceId, modelId })
      res.writeHead(200, {
        'content-type': 'audio/mpeg',
        'content-length': result.bytes.byteLength,
        'x-duration-ms': String(result.durationMs),
      })
      res.end(result.bytes)
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

  async function handleLibraryGet(req, res, key) {
    if (!libraryLimiter.allow(key)) return sendJson(res, 429, { error: 'rate-limited' })
    const row = libraryStore.get(key)
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
      !Array.isArray(parsed.decks)
    ) {
      return sendJson(res, 400, { error: 'invalid-request' })
    }

    libraryStore.put(key, JSON.stringify(parsed), Date.now())
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

      if (url.pathname.startsWith('/api/')) {
        const key = getBearerToken(req)
        if (!isValidLibraryKey(key)) {
          sendJson(res, 401, { error: 'unauthorized' })
          return
        }

        if (url.pathname === '/api/tts' && req.method === 'POST') return await handleTts(req, res, key)
        if (url.pathname === '/api/scan' && req.method === 'POST') return await handleScan(req, res, key)
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
