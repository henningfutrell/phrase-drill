import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.js'
import { createLibraryStore } from './db.js'
import { createLogger } from './logger.js'
import { createRateLimiter } from './rate-limiter.js'
import { createBoundedQueue } from './bounded-queue.js'
import { createElevenLabsProvider } from './providers/elevenlabs-client.js'
import { createAnthropicProvider } from './providers/anthropic-client.js'

/**
 * Wires every real dependency from the environment (T041 "secrets come from
 * the environment only") and returns an unstarted `http.Server` plus the
 * pieces a caller (or a test) may want to close down cleanly. Nothing here
 * is exercised directly by a test — `server/app.test.js` exercises
 * `createApp` with fakes; this function is the thin, once-per-process glue
 * that only differs from a test by which values it's handed.
 */
export function buildServer(env = process.env) {
  const port = Number(env.PORT ?? 8080)
  const dbPath = env.DB_PATH ?? './data/phrase-drill.db'
  const distDir = env.DIST_DIR ?? fileURLToPath(new URL('../dist', import.meta.url))
  const elevenLabsApiKey = env.ELEVENLABS_API_KEY || null
  const anthropicApiKey = env.ANTHROPIC_API_KEY || null

  const logger = createLogger({ secrets: [elevenLabsApiKey, anthropicApiKey] })
  if (!elevenLabsApiKey) logger.warn('ELEVENLABS_API_KEY is not set — speech generation will return not-configured')
  if (!anthropicApiKey) logger.warn('ANTHROPIC_API_KEY is not set — scan reading will return not-configured')

  const libraryStore = createLibraryStore(dbPath)
  const elevenLabsQueue = createBoundedQueue({ concurrency: 4 })
  const anthropicQueue = createBoundedQueue({ concurrency: 2 })
  const elevenLabs = createElevenLabsProvider({ apiKey: elevenLabsApiKey, queue: elevenLabsQueue })
  const anthropic = createAnthropicProvider({ apiKey: anthropicApiKey, queue: anthropicQueue })

  // Limits (T041 "rate-limit the proxy endpoints"): tts is the busy path
  // (generation-queue.ts can enqueue two calls per phrase across a whole
  // library at once) so it gets the highest ceiling; scan is one photo at a
  // time by hand, so ten a minute is already generous; library sync is
  // polled/pushed around every local edit, so it sits between the two.
  const ttsLimiter = createRateLimiter({ capacity: 60, refillMs: 60_000 })
  const scanLimiter = createRateLimiter({ capacity: 10, refillMs: 60_000 })
  const libraryLimiter = createRateLimiter({ capacity: 30, refillMs: 60_000 })

  const handleRequest = createApp({
    libraryStore,
    elevenLabs,
    anthropic,
    ttsLimiter,
    scanLimiter,
    libraryLimiter,
    distDir,
    logger,
  })

  const server = createServer(handleRequest)
  return { server, port, logger, libraryStore }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const { server, port, logger } = buildServer()
  server.listen(port, () => logger.info('server listening', { port }))
}
