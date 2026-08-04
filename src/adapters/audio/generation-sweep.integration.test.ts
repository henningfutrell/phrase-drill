// T035 — THE acceptance test for the generation stampede.
//
// Named `.integration.test.ts` for the same reason
// `clip-hash-parity.integration.test.ts` is: `tsconfig.app.json` excludes
// that pattern, so a TypeScript test may import the server's plain-JS
// modules without `tsc -b` demanding declarations for them. That matters
// here — the fake server below meters requests with the *real*
// `server/rate-limiter.js`, at the real `/api/tts` setting (60 per 60s), so
// the numbers this test drains against are the ones production enforces
// rather than a re-implementation that could be kinder than the original.
//
// What this drives: a cold library of 1,000 Phrases (2,000 Clips, French and
// English) through the real `createGenerationQueue` and the real
// `createServerSynthClient`, over a fake `fetch` that is a faithful stand-in
// for this app's own server: token-bucket limiter in front, 429 with
// `Retry-After` when it denies, the "provider" behind it.
//
// Before this change the same sweep issued 2,000 simultaneous requests, ~60
// got through, and the other ~1,940 were marked `quota` — permanently, by our
// own limiter.
import { describe, expect, it } from 'vitest'
import { createRateLimiter } from '../../../server/rate-limiter.js'
import { createGenerationQueue, type GenerationStatus } from './generation-queue'
import { createServerSynthClient } from './server-synth-client'
import type { Clip, ClipCache } from '../storage/clip-cache'
import type { Voice } from '../storage/settings-store'

const VOICE: Voice = { provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-1' }
const PHRASE_COUNT = 1000
const MAX_CONCURRENT = 4

/**
 * A virtual clock. Not Vitest's fake timers: the queue reads time and sleeps
 * through injected seams (`now`, `sleep`), and driving those directly keeps
 * the digest promises `computeClipHash` depends on running on the real event
 * loop — a globally faked `setTimeout` and a real `crypto.subtle` do not mix
 * well. Time only moves when `tick()` moves it, which is what makes a
 * half-hour drain finish in a test.
 */
function createVirtualClock() {
  let now = 0
  let waiters: { at: number; resolve: () => void }[] = []
  return {
    now: () => now,
    sleep(ms: number): Promise<void> {
      return new Promise<void>((resolve) => {
        waiters.push({ at: now + Math.max(0, ms), resolve })
      })
    },
    /** Jump to the earliest pending wake-up. `false` when nothing is waiting. */
    tick(): boolean {
      if (waiters.length === 0) return false
      now = Math.min(...waiters.map((w) => w.at))
      const due = waiters.filter((w) => w.at <= now)
      waiters = waiters.filter((w) => w.at > now)
      for (const w of due) w.resolve()
      return true
    },
  }
}

interface FakeServer {
  readonly fetchImpl: typeof fetch
  readonly providerTexts: Set<string>
  requestCount(): number
  rejectedCount(): number
  peakInFlight(): number
  activity(): number
}

/** This app's own server, reduced to what a sweep can see: the real limiter,
 * a 429 with `Retry-After` when it denies, a "provider" call when it does not. */
function createFakeServer(now: () => number): FakeServer {
  // The production setting for /api/tts (docs/server.md).
  const limiter = createRateLimiter({ capacity: 60, refillMs: 60_000, now })
  const providerTexts = new Set<string>()
  let requests = 0
  let rejected = 0
  let inFlight = 0
  let peak = 0

  const fetchImpl = (async (_url: string, init: RequestInit) => {
    requests++
    inFlight++
    peak = Math.max(peak, inFlight)
    try {
      const body = JSON.parse(String(init.body)) as { text: string; lang: string }
      const decision = limiter.allow('her-session')
      if (!decision.ok) {
        rejected++
        // `Retry-After` is seconds, per RFC 9110 — the same rounding
        // server/app.js does.
        return errorResponse(429, { 'retry-after': String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))) })
      }
      providerTexts.add(`${body.lang}|${body.text}`)
      return mp3Response()
    } finally {
      inFlight--
    }
  }) as unknown as typeof fetch

  return {
    fetchImpl,
    providerTexts,
    requestCount: () => requests,
    rejectedCount: () => rejected,
    peakInFlight: () => peak,
    activity: () => requests,
  }
}

function mp3Response(): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name === 'x-duration-ms' ? '900' : null) },
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
  } as unknown as Response
}

function errorResponse(status: number, headers: Record<string, string>): Response {
  return {
    ok: false,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  } as unknown as Response
}

function createFakeClipCache(): ClipCache {
  const clips = new Map<string, Clip>()
  return {
    async get(hash) {
      return clips.get(hash)
    },
    async put(clip) {
      clips.set(clip.hash, clip)
    },
    async has(hash) {
      return clips.has(hash)
    },
    async readyPhraseIds() {
      return new Set()
    },
  }
}

/** Let every promise chain that can progress without the clock progress.
 * A real macrotask, repeatedly, because `computeClipHash` resolves through
 * `crypto.subtle.digest`, which a microtask flush does not reach. */
async function settle(activity: () => number): Promise<void> {
  let last = -1
  for (let round = 0; round < 50 && activity() !== last; round++) {
    last = activity()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('a cold library sweep against a rate-limiting server', () => {
  it(
    'drains every Phrase instead of dying on our own limiter, and never exceeds its concurrency bound',
    async () => {
      const clock = createVirtualClock()
      const server = createFakeServer(clock.now)
      const synthClient = createServerSynthClient({
        getAccessToken: async () => 'session-token',
        fetchImpl: server.fetchImpl,
      })

      const settledStatuses = new Map<string, GenerationStatus>()
      const queue = createGenerationQueue({
        synthClient,
        clipCache: createFakeClipCache(),
        getVoice: async () => VOICE,
        maxConcurrent: MAX_CONCURRENT,
        now: clock.now,
        sleep: clock.sleep,
        onStatusChange: (phraseId, status) => {
          if (status.kind === 'generating') settledStatuses.delete(phraseId)
          else settledStatuses.set(phraseId, status)
        },
      })

      const phrases = Array.from({ length: PHRASE_COUNT }, (_, i) => ({
        id: `p${i}`,
        french: `phrase française numéro ${i}`,
        english: `french phrase number ${i}`,
      }))
      for (const phrase of phrases) queue.enqueue(phrase)

      // Quiescence is the queue's own answer (`whenIdle`), never a counted
      // number of turns; the clock only moves when the sweep has nothing
      // left to do without it.
      let idle = false
      void queue.whenIdle().then(() => {
        idle = true
      })
      for (let guard = 0; !idle; guard++) {
        await settle(server.activity)
        if (idle) break
        expect(guard).toBeLessThan(20_000) // the sweep terminates, or this test does
        if (!clock.tick()) {
          await settle(server.activity)
          break
        }
      }
      expect(idle).toBe(true)

      const byKind = new Map<GenerationStatus['kind'], number>()
      for (const status of settledStatuses.values()) byKind.set(status.kind, (byKind.get(status.kind) ?? 0) + 1)

      // The measured defect, inverted: zero Phrases permanently marked
      // quota-failed, and every one of the 2,000 Clips generated.
      expect(byKind.get('quota') ?? 0).toBe(0)
      expect(byKind.get('failed') ?? 0).toBe(0)
      expect(byKind.get('unauthorized') ?? 0).toBe(0)
      expect(byKind.get('ready')).toBe(PHRASE_COUNT)
      expect(server.providerTexts.size).toBe(PHRASE_COUNT * 2)

      // The device bounds itself. Before: 2,000 at once.
      expect(server.peakInFlight()).toBeLessThanOrEqual(MAX_CONCURRENT)

      // And the limiter really did fire — otherwise this proves nothing.
      expect(server.rejectedCount()).toBeGreaterThan(0)
      expect(server.requestCount()).toBeGreaterThan(PHRASE_COUNT * 2)
    },
    { timeout: 180_000 },
  )
})
