import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.js'
import { createLibraryStore, createPool, waitForDatabase, extractPassword } from './db.js'
import { createTokenVerifier } from './jwt-verifier.js'
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
 *
 * Now async (T043): boot must wait for Postgres to accept connections
 * (`waitForDatabase` — Docker Compose starts every service concurrently, so
 * Postgres reporting "healthy" to Compose and this process's first query
 * landing are two different races) before the table is guaranteed to exist.
 */
export async function buildServer(env = process.env) {
  const port = Number(env.PORT ?? 8080)
  const databaseUrl = env.DATABASE_URL ?? 'postgres://phrase_drill:phrase_drill@localhost:5432/phrase_drill'
  const distDir = env.DIST_DIR ?? fileURLToPath(new URL('../dist', import.meta.url))
  const elevenLabsApiKey = env.ELEVENLABS_API_KEY || null
  const anthropicApiKey = env.ANTHROPIC_API_KEY || null
  const keycloakIssuer = env.KEYCLOAK_ISSUER ?? 'http://localhost:8081/realms/phrase-drill'
  const keycloakJwksUri = env.KEYCLOAK_JWKS_URI ?? 'http://localhost:8081/realms/phrase-drill/protocol/openid-connect/certs'
  const tokenAudience = env.TOKEN_AUDIENCE ?? 'phrase-drill-app'

  const logger = createLogger({ secrets: [elevenLabsApiKey, anthropicApiKey, extractPassword(databaseUrl)] })
  if (!elevenLabsApiKey) logger.warn('ELEVENLABS_API_KEY is not set — speech generation will return not-configured')
  if (!anthropicApiKey) logger.warn('ANTHROPIC_API_KEY is not set — scan reading will return not-configured')

  const pool = createPool(databaseUrl)
  await waitForDatabase(pool)
  const libraryStore = createLibraryStore(pool)
  await libraryStore.init()

  const tokenVerifier = createTokenVerifier({ issuer: keycloakIssuer, audience: tokenAudience, jwksUri: keycloakJwksUri })

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
    tokenVerifier,
  })

  const server = createServer(handleRequest)
  return { server, port, logger, libraryStore }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const { server, port, logger } = await buildServer()
  server.listen(port, () => logger.info('server listening', { port }))
}
