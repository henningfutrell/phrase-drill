// @vitest-environment node
import { createServer } from 'node:http'
import { createClient } from '@supabase/supabase-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { createDailySpendCap } from './daily-spend-cap.js'
import { createAccessTokenVerifier } from './access-token-verifier.js'
import { createClipJobRunner } from './clip-job-runner.js'
import { createMemoryClipJobStore } from './clip-job-store.test-support.js'
import { validateClip } from './clip-validation.js'
import { createClipStore, createLibraryStore } from './db.js'
import {
  fakeClipPool,
  fakeClipStorage,
  fakeLibraryPool,
} from './pool.test-support.js'
import { createElevenLabsProvider } from './providers/elevenlabs-client.js'
import { createRateLimiter } from './rate-limiter.js'
import { createSupabase } from './supabase.js'

// Hoisted above the imports: `supabase.js` gets this `createClient`.
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ fake: true })),
}))

/**
 * The server's Supabase code with the Supabase client mocked, end to end:
 * the real token verifier and the real Clip store, wired as `index.js` wires
 * them, through `createApp`, over HTTP. Only the client is fake — the shape
 * `createClient` returns (`auth.getClaims`, `storage.from(bucket)`), answering
 * the way supabase-js answers. `app.test.js` fakes the ports instead; this
 * file proves the adapters behind them hold the server's promises when
 * Supabase says no.
 *
 * No live Supabase, ElevenLabs or anything else: every upstream is a fake.
 */

const TOKEN = 'token-for-them'
const SUB = '7d1f0c2e-0000-4000-8000-000000000001'

/**
 * How Supabase Storage refuses a request its row-level security denies: an
 * HTTP 400 whose body says `statusCode: '403'` (older Storage API), or an
 * HTTP 403 (newer). supabase-js hands back `{ data: null, error }` for both.
 */
const RLS_DENIED = [
  [
    '400 with statusCode 403',
    {
      message: 'new row violates row-level security policy',
      statusCode: '403',
      status: 400,
    },
  ],
  [
    '403',
    {
      message: 'new row violates row-level security policy',
      statusCode: '403',
      status: 403,
    },
  ],
]

/** The client `createClient` would return: auth answers from `claimsFor`, storage is one fake bucket. */
function fakeSupabaseClient({
  claimsFor = (token) =>
    token === TOKEN
      ? { data: { claims: { sub: SUB } }, error: null }
      : { data: null, error: { message: 'invalid JWT' } },
  storage = fakeClipStorage(),
} = {}) {
  const buckets = []
  return {
    buckets,
    storage: {
      from(bucket) {
        buckets.push(bucket)
        return storage
      },
    },
    auth: { getClaims: async (token) => claimsFor(token) },
    bucket: storage,
  }
}

/** A counting ElevenLabs upstream that answers a valid MP3-shaped body. */
function fetchElevenLabsOk() {
  const impl = async () => {
    impl.calls += 1
    const bytes = new Uint8Array(1600)
    bytes.set([0x49, 0x44, 0x33, impl.calls])
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'audio/mpeg' }),
      arrayBuffer: async () => bytes.buffer,
    }
  }
  impl.calls = 0
  return impl
}

function silentLogger() {
  const lines = []
  const write = (level) => (msg, fields) =>
    lines.push({ level, msg, ...fields })
  return {
    lines,
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
  }
}

let server
let runner

/** Boots the app as `index.js` composes it, around `supabase`. */
async function boot(
  supabase,
  { ttsLimiter = createRateLimiter({ capacity: 100, refillMs: 60_000 }) } = {},
) {
  const logger = silentLogger()
  const libraryStore = createLibraryStore(fakeLibraryPool())
  await libraryStore.init()
  const libraryKeys = []
  const clipPool = fakeClipPool()
  const clipStore = createClipStore(clipPool, {
    storage: supabase.storage.from('clips'),
    logger,
  })
  await clipStore.init()
  const upstream = fetchElevenLabsOk()
  const elevenLabs = createElevenLabsProvider({
    apiKey: 'stub-key',
    fetchImpl: upstream,
  })
  const clipJobStore = createMemoryClipJobStore()
  runner = createClipJobRunner({
    jobStore: clipJobStore,
    clipStore,
    elevenLabs,
    validateClip,
    logger,
    pollMs: 5,
    retryDelayMs: () => 1,
  })
  runner.start()

  const handleRequest = createApp({
    libraryStore: {
      ...libraryStore,
      get: async (key) => {
        libraryKeys.push(key)
        return libraryStore.get(key)
      },
    },
    clipStore,
    elevenLabs,
    clipJobStore,
    clipJobRunner: runner,
    ttsWaitMs: 5_000,
    anthropic: {},
    ttsLimiter,
    scanLimiter: createRateLimiter({ capacity: 100, refillMs: 60_000 }),
    libraryLimiter: createRateLimiter({ capacity: 100, refillMs: 60_000 }),
    translateLimiter: createRateLimiter({ capacity: 100, refillMs: 60_000 }),
    elevenLabsSpendCap: createDailySpendCap({ limit: 1_000 }),
    anthropicSpendCap: createDailySpendCap({ limit: 1_000 }),
    distDir: import.meta.dirname,
    logger,
    verifyAccessToken: createAccessTokenVerifier(supabase),
  })
  server = createServer(handleRequest)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  return { baseUrl, upstream, clipPool, libraryKeys, logger }
}

afterEach(async () => {
  await runner?.stop()
  runner = undefined
  if (server) await new Promise((resolve) => server.close(resolve))
  server = undefined
})

const authorized = (token = TOKEN) => ({ authorization: `Bearer ${token}` })

function tts(baseUrl, text = 'bonjour') {
  return fetch(`${baseUrl}/api/tts`, {
    method: 'POST',
    headers: { ...authorized(), 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      voiceId: 'v1',
      modelId: 'm1',
      provider: 'elevenlabs',
      lang: 'fr-FR',
    }),
  })
}

describe('createSupabase', () => {
  it('builds one client from the URL and secret key, with no session kept or refreshed', () => {
    const client = createSupabase({
      url: 'https://project.supabase.invalid',
      secretKey: 'sb_secret_stub',
    })
    expect(client).toEqual({ fake: true })
    expect(createClient).toHaveBeenCalledWith(
      'https://project.supabase.invalid',
      'sb_secret_stub',
      {
        auth: { persistSession: false, autoRefreshToken: false },
      },
    )
  })
})

describe('server over a mocked Supabase client — auth', () => {
  it('uses the clips bucket, and nothing else', async () => {
    const supabase = fakeSupabaseClient()
    await boot(supabase)
    expect(supabase.buckets).toEqual(['clips'])
  })

  it('keys their library by the token subject Supabase verified', async () => {
    const { baseUrl, libraryKeys } = await boot(fakeSupabaseClient())
    const res = await fetch(`${baseUrl}/api/library`, { headers: authorized() })
    expect(res.status).toBe(404) // nothing stored yet: authenticated, and looked up
    expect(libraryKeys).toEqual([SUB])
  })

  it.each([
    ['no Authorization header', {}],
    ['a token Supabase refuses', authorized('expired-token')],
  ])('answers 401 for %s, and reads no library', async (_, headers) => {
    const { baseUrl, libraryKeys } = await boot(fakeSupabaseClient())
    expect((await fetch(`${baseUrl}/api/library`, { headers })).status).toBe(
      401,
    )
    expect(libraryKeys).toEqual([])
  })

  it('answers 401 when Supabase Auth cannot be reached', async () => {
    const supabase = fakeSupabaseClient({
      claimsFor: () => {
        throw new TypeError('fetch failed')
      },
    })
    const { baseUrl, libraryKeys } = await boot(supabase)
    expect(
      (await fetch(`${baseUrl}/api/library`, { headers: authorized() })).status,
    ).toBe(401)
    expect(libraryKeys).toEqual([])
  })

  it('answers 401 for verified claims with no subject: no library key to use', async () => {
    const { baseUrl, libraryKeys } = await boot(
      fakeSupabaseClient({
        claimsFor: () => ({ data: { claims: { role: 'anon' } }, error: null }),
      }),
    )
    expect(
      (await fetch(`${baseUrl}/api/library`, { headers: authorized() })).status,
    ).toBe(401)
    expect(libraryKeys).toEqual([])
  })
})

describe.each(RLS_DENIED)(
  'server over a mocked Supabase client — Storage refuses (RLS, %s)',
  (_, denial) => {
    it('upload refused: the paid clip is still served, and no row points at a missing object', async () => {
      const supabase = fakeSupabaseClient()
      supabase.bucket.upload = async () => ({ data: null, error: denial })
      const { baseUrl, upstream, clipPool, logger } = await boot(supabase)

      const res = await tts(baseUrl)

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('audio/mpeg')
      expect(upstream.calls).toBe(1)
      expect(clipPool.rows.size).toBe(0)
      expect(
        logger.lines.some(
          (l) =>
            l.level === 'warn' && l.msg === 'could not store generated clip',
        ),
      ).toBe(true)
    })

    it('download refused: an error, not a miss — the row is kept and nothing is billed again', async () => {
      const supabase = fakeSupabaseClient()
      const { baseUrl, upstream, clipPool } = await boot(supabase)
      expect((await tts(baseUrl)).status).toBe(200) // stored
      supabase.bucket.download = async () => ({ data: null, error: denial })

      const res = await tts(baseUrl)

      expect(res.status).toBe(500)
      expect(upstream.calls).toBe(1)
      expect(clipPool.rows.size).toBe(1)
    })

    it('remove refused: the delete still succeeds, and the orphan is logged', async () => {
      const supabase = fakeSupabaseClient()
      const logger = silentLogger()
      const pool = fakeClipPool()
      const store = createClipStore(pool, {
        storage: supabase.storage.from('clips'),
        logger,
      })
      await store.init()
      await store.put({
        hash: 'abc123',
        bytes: Buffer.alloc(8, 1),
        mime: 'audio/mpeg',
        durationMs: 500,
        createdAt: 1,
      })
      supabase.bucket.remove = async () => ({ data: null, error: denial })

      expect(await store.delete('abc123')).toBe(true)
      expect(pool.rows.size).toBe(0)
      expect(supabase.bucket.objects.size, 'the orphan').toBe(1)
      expect(
        logger.lines.some(
          (l) => l.level === 'error' && l.msg.includes('orphaned'),
        ),
      ).toBe(true)
    })
  },
)

describe('server over a mocked Supabase client — cost guards', () => {
  it('Storage refusing every upload costs at most two billed calls per phrase a day', async () => {
    const supabase = fakeSupabaseClient()
    supabase.bucket.upload = async () => ({
      data: null,
      error: RLS_DENIED[0][1],
    })
    const { baseUrl, upstream } = await boot(supabase)

    expect((await tts(baseUrl)).status).toBe(200)
    expect((await tts(baseUrl)).status).toBe(200)
    const third = await tts(baseUrl)

    expect(third.status).toBe(422)
    expect(await third.json()).toEqual({ error: 'unreadable' })
    expect(upstream.calls).toBe(2)
  })

  it('the tts limiter answers 429 with Retry-After before it asks Supabase for the clip', async () => {
    const supabase = fakeSupabaseClient()
    const downloads = []
    const download = supabase.bucket.download.bind(supabase.bucket)
    supabase.bucket.download = async (path) => {
      downloads.push(path)
      return download(path)
    }
    const { baseUrl, upstream } = await boot(supabase, {
      ttsLimiter: createRateLimiter({ capacity: 1, refillMs: 60_000 }),
    })

    expect((await tts(baseUrl)).status).toBe(200)
    const limited = await tts(baseUrl)

    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(downloads).toEqual([])
    expect(upstream.calls).toBe(1)
  })

  it('the Clip store ceiling evicts objects from the bucket, not only rows', async () => {
    const supabase = fakeSupabaseClient()
    const pool = fakeClipPool()
    const store = createClipStore(pool, {
      storage: supabase.storage.from('clips'),
      maxBytes: 1_000,
      logger: silentLogger(),
    })
    await store.init()
    for (let i = 0; i < 12; i++) {
      await store.put({
        hash: `clip-${String(i).padStart(2, '0')}`,
        bytes: Buffer.alloc(100, i),
        mime: 'audio/mpeg',
        durationMs: 1,
        createdAt: i,
      })
    }

    expect(await store.totalBytes()).toBeLessThanOrEqual(1_000)
    expect([...supabase.bucket.objects.keys()].sort()).toEqual(
      [...pool.rows.keys()].sort(),
    )
    expect(supabase.bucket.objects.has('clip-00')).toBe(false)
  })
})
