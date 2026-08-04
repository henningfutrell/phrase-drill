// @vitest-environment node
//
// Exercises the real server handler (server/app.js's createApp) against the
// real adapter (createServerTranslator) over a real HTTP connection — not
// two fakes agreeing with each other. Only the outbound call this process
// would make to the actual Anthropic API is faked, since no real
// ANTHROPIC_API_KEY is available in this environment and none is sought.
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../../../server/app.js'
import { createRateLimiter } from '../../../server/rate-limiter.js'
import { createBoundedQueue } from '../../../server/bounded-queue.js'
import { createAnthropicProvider } from '../../../server/providers/anthropic-client.js'
import { createServerTranslator } from './server-translator'

const VALID_TOKEN = 'valid-token'
const SUB = 'user-1'

function fakeSessionAuth() {
  return {
    async verify(token: string) {
      if (token !== VALID_TOKEN) throw new Error('invalid token')
      return { sub: SUB }
    },
    async login() {
      return null
    },
    async logout() {},
  }
}

function fakeAnthropicFetch(candidates: Array<{ text: string; register?: string }>) {
  return async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ candidates }) }] }),
    }) as Response
}

let server: Server
let baseUrl: string

async function boot(anthropicFetch: typeof fetch) {
  const anthropic = createAnthropicProvider({
    apiKey: 'test-key',
    fetchImpl: anthropicFetch,
    queue: createBoundedQueue({ concurrency: 2 }),
    retries: 0,
  })
  const handleRequest = createApp({
    libraryStore: { get: async () => undefined, put: async () => {} },
    elevenLabs: { synthesize: async () => ({ bytes: new ArrayBuffer(0), durationMs: 0 }) },
    anthropic,
    ttsLimiter: createRateLimiter({ capacity: 100, refillMs: 60_000 }),
    scanLimiter: createRateLimiter({ capacity: 100, refillMs: 60_000 }),
    libraryLimiter: createRateLimiter({ capacity: 100, refillMs: 60_000 }),
    loginLimiter: createRateLimiter({ capacity: 100, refillMs: 60_000 }),
    translateLimiter: createRateLimiter({ capacity: 100, refillMs: 60_000 }),
    distDir: import.meta.dirname,
    logger: { info() {}, warn() {}, error() {} },
    sessionAuth: fakeSessionAuth(),
  })
  server = createServer(handleRequest)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`
}

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
})

describe('server-translator against a real server (fake Anthropic upstream only)', () => {
  it('round-trips a translate request through the real route and the real adapter', async () => {
    await boot(
      fakeAnthropicFetch([
        { text: 'Tu peux venir?', register: 'tu' },
        { text: 'Pouvez-vous venir?', register: 'vous' },
      ]),
    )
    const translator = createServerTranslator({
      getAccessToken: async () => VALID_TOKEN,
      fetchImpl: (input, init) => fetch(new URL(String(input), baseUrl), init),
    })

    const candidates = await translator.translate('Can you come?', 'en-to-fr', 'friends')
    expect(candidates).toEqual([
      { text: 'Tu peux venir?', register: 'tu' },
      { text: 'Pouvez-vous venir?', register: 'vous' },
    ])
  })

  it('rejects unauthorized when the session token is invalid, through the real route', async () => {
    await boot(fakeAnthropicFetch([{ text: 'Bonjour' }]))
    const translator = createServerTranslator({
      getAccessToken: async () => 'not-a-real-token',
      fetchImpl: (input, init) => fetch(new URL(String(input), baseUrl), init),
    })
    await expect(translator.translate('Hello', 'en-to-fr', 'home')).rejects.toMatchObject({ kind: 'unauthorized' })
  })
})
