import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.js'
import { createLibraryStore, createAuthStore, createClipStore, createPool, waitForDatabase, extractPassword, clipStoreMaxBytesFrom } from './db.js'
import { createSessionAuth } from './session-auth.js'
import { createLogger } from './logger.js'
import { createRateLimiter } from './rate-limiter.js'
import { createBoundedQueue } from './bounded-queue.js'
import { createElevenLabsProvider } from './providers/elevenlabs-client.js'
import { createAnthropicProvider } from './providers/anthropic-client.js'
import { createShutdown } from './shutdown.js'

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
  const databaseUrl = env.DATABASE_URL ?? 'postgres://phrase_drill:phrase_drill@localhost:5432/phrase_drill'
  const distDir = env.DIST_DIR ?? fileURLToPath(new URL('../dist', import.meta.url))
  const elevenLabsApiKey = env.ELEVENLABS_API_KEY || null
  const anthropicApiKey = env.ANTHROPIC_API_KEY || null

  const logger = createLogger({ secrets: [elevenLabsApiKey, anthropicApiKey, extractPassword(databaseUrl)] })
  if (!elevenLabsApiKey) logger.warn('ELEVENLABS_API_KEY is not set — speech generation will return not-configured')
  if (!anthropicApiKey) logger.warn('ANTHROPIC_API_KEY is not set — scan reading will return not-configured')

  // T088: `port` is parsed, not `Number(...)`d — see `portFrom`.
  const port = portFrom(env.PORT, logger)

  // T088: the pool gets this process's redacting logger, so the `error` event
  // `createPool` now listens for is reported through the same redaction every
  // other line goes through.
  const pool = createPool(databaseUrl, { logger })
  await waitForDatabase(pool)
  const libraryStore = createLibraryStore(pool)
  await libraryStore.init()
  const authStore = createAuthStore(pool)
  await authStore.init()
  // T063: adds the `clips` table. Same `CREATE TABLE IF NOT EXISTS` shape as
  // the two above, so a deployed database gets it on the next restart with no
  // manual step and nothing existing touched. T071 bounds it: audio is
  // derived and regenerable, her phrases are not, and both live on the same
  // 1 GB instance — so the table that grows without limit is the one that
  // gets a ceiling. `CLIP_STORE_MAX_BYTES` overrides it if the plan changes.
  // T082: parsed, not `Number(...)`d. A typo in the Render dashboard field
  // used to make this store either unbounded (`NaN`) or permanently empty
  // (`''`), and the first of those ends with `libraryStore.put` as the write
  // that fails. `clipStoreMaxBytesFrom` falls back to the default, loudly.
  const clipStoreMaxBytes = clipStoreMaxBytesFrom(env.CLIP_STORE_MAX_BYTES, logger)
  const clipStore = createClipStore(pool, { maxBytes: clipStoreMaxBytes })
  await clipStore.init()

  // T050: identity is a session row in Postgres, not a Keycloak-issued
  // JWT — no issuer, no audience, no JWKS to configure or trust. T052:
  // authStore.users/.sessions match createSessionAuth's seam name for name
  // (server/auth-store-contract.test.js pins it) — this used to pass the
  // same flat, mismatched object as both arguments and every login 500'd.
  const sessionAuth = createSessionAuth({ userStore: authStore.users, sessionStore: authStore.sessions })

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
  // Hard, per-username: T050 "rate-limit login hard" — 5 attempts/60s means
  // a brute force against one username gets nowhere before the account
  // owner would notice.
  const loginLimiter = createRateLimiter({ capacity: 5, refillMs: 60_000 })
  // T057: translate fires once per phrase, debounced, while she's adding
  // phrases to a Deck in one sitting — more frequent than scan's "one photo
  // at a time" but each call is far cheaper (one short string, not an
  // image), so it sits just under tts's ceiling rather than down at scan's.
  const translateLimiter = createRateLimiter({ capacity: 30, refillMs: 60_000 })

  const handleRequest = createApp({
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
  })

  const server = createServer(handleRequest)
  // `pool` is returned because its lifetime is this function's, not any
  // store's (T088, see `createPool`): one owner builds it and one owner ends
  // it, on the way out.
  return { server, port, logger, pool, libraryStore, authStore, clipStore }
}

/**
 * Reads `PORT` into a port `listen` can be trusted with (T088).
 *
 * It used to be a bare `Number(env.PORT ?? 8080)`, left in place by T082 on
 * the reasoning that a bad port fails loudly at `listen`. That is true for the
 * NaN half (`'abc'` → `options.port should be >= 0 and < 65536`) and false for
 * the half that a deploy dashboard actually produces: `Number('')` is `0`, and
 * `listen(0)` is not an error — it is the documented way to ask the OS for a
 * RANDOM FREE PORT. A cleared `PORT` field therefore gives a process that
 * boots, logs `server listening`, and answers nothing on the port the platform
 * routes to, with no line in the log saying so. The only off-device copy of
 * her library is then unreachable and healthy-looking.
 *
 * It falls back rather than refusing to boot, for the same reason
 * `clipStoreMaxBytesFrom` does: a misconfigured deploy that still serves
 * `GET /api/library` on the documented default is worth more than one that
 * does not start. The fallback is logged at error level, once, at boot.
 */
export function portFrom(raw, logger) {
  if (raw === undefined || raw === null) return DEFAULT_PORT
  const value = Number(raw)
  // `0` is excluded deliberately: it is the random-port request, never a port
  // anything can route to.
  if (Number.isInteger(value) && value > 0 && value < 65536) return value
  logger.error('PORT is not a usable TCP port — using the default', { provided: String(raw), using: DEFAULT_PORT })
  return DEFAULT_PORT
}

/** Matches `docs/server.md` and `docker-compose.yml`; Render sets `PORT` itself. */
export const DEFAULT_PORT = 8080

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const { server, port, logger, pool } = await buildServer()
  // T088: without this, Render's SIGTERM on every deploy and restart killed
  // the process outright, cutting any push in flight.
  const shutdown = createShutdown({ server, pool, logger })
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  server.listen(port, () => logger.info('server listening', { port }))
}
