/**
 * T032 — measures what "thousands of Phrases" actually costs, against the
 * *real* clip-cache, deck-store, and library code paths, run through the
 * same in-memory `idb` fake the rest of this repo's adapter tests use
 * (`idb.test-support.ts`, `vi.mock('idb', ...)`). Not part of the default
 * `npm test` run — see docs/scale.md for how to invoke it and what the last
 * run found.
 *
 * Everything measured here runs against the in-memory fake, not real Safari
 * disk-backed IndexedDB — that fake is a `Map`, so these numbers are a
 * floor for on-device IDB latency, not a ceiling. Network calls to
 * ElevenLabs are never made; this file must not import or exercise the real
 * `eleven-labs-synth-client.ts` fetch path. Every number this file prints is
 * labelled MEASURED (real code path, real timer) or MODELLED (derived from
 * a code constant/formula, no I/O) inline in its console output; docs/scale.md
 * repeats and explains each one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Deck, Phrase } from '../../domain'
import { estimatePauseDuration } from '../../domain'
import { resetFakeIdb } from './idb.test-support'

// This project's tsconfig carries no @types/node ("types": ["vite/client"]
// only, per tsconfig.app.json), and this file is the only one that needs
// process.env — a local ambient declaration, rather than adding @types/node
// project-wide for one gate flag.
declare const process: { env: Record<string, string | undefined> }

vi.mock('idb', async () => {
  const fake = await import('./idb.test-support')
  return { openDB: fake.openDB }
})

// Imported after the mock is registered, per Vitest's hoisting contract —
// same pattern as clip-cache.test.ts / indexed-db-deck-store.test.ts.
const { createIndexedDbClipCache, computeClipHash } = await import('./clip-cache')
const { createIndexedDbDeckStore } = await import('./indexed-db-deck-store')

const RUN = process.env.RUN_SCALE_BENCH === '1'

const VOICE = { provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-1' }

/** MODELLED: the eleven-labs-synth-client.ts constant (private, not exported)
 * — MP3 bytes/ms at its 128 kbps output format. Reproduced here, not
 * imported, because the source module is not touched by this file. */
const MP3_BYTES_PER_MS_AT_128KBPS = 16

const LIBRARY_SIZES = [100, 1000, 5000, 10000] as const
const PHRASES_PER_DECK = 50

// ---------------------------------------------------------------------------
// Synthetic library generation
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) — reproducible synthetic libraries across runs. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FRENCH_WORDS = [
  'je', 'voudrais', 'reserver', 'une', 'table', 'pour', 'deux', 'personnes',
  'ce', 'soir', 'ou', 'est', 'la', 'gare', 'la', 'plus', 'proche', 'pouvez',
  'vous', 'repeter', 'lentement', 'combien', 'ca', 'coute', 'je', 'ne',
  'comprends', 'pas', 'excusez', 'moi', 'quelle', 'heure', 'est', 'il',
  'bonjour', 'merci', 'beaucoup', 'au', 'revoir', 'a', 'bientot',
]
const ENGLISH_WORDS = [
  'i', 'would', 'like', 'to', 'book', 'a', 'table', 'for', 'two', 'people',
  'tonight', 'where', 'is', 'the', 'nearest', 'train', 'station', 'can',
  'you', 'repeat', 'that', 'slowly', 'how', 'much', 'does', 'it', 'cost',
  'i', 'do', 'not', 'understand', 'excuse', 'me', 'what', 'time', 'is', 'it',
  'hello', 'thank', 'you', 'goodbye', 'see', 'you', 'soon',
]

function sentence(words: readonly string[], rng: () => number, wordCount: number): string {
  const picked: string[] = []
  for (let i = 0; i < wordCount; i++) {
    picked.push(words[Math.floor(rng() * words.length)])
  }
  const s = picked.join(' ')
  return s.charAt(0).toUpperCase() + s.slice(1) + '.'
}

function generatePhrases(n: number, seed = 42): Phrase[] {
  const rng = mulberry32(seed)
  const phrases: Phrase[] = []
  for (let i = 0; i < n; i++) {
    // 4-12 word phrases — a realistic conversational-phrase range, not a
    // single fixed length, so duration/hash-cost figures aren't an artifact
    // of one string length.
    const wordCount = 4 + Math.floor(rng() * 9)
    phrases.push({
      id: `p${i}`,
      french: sentence(FRENCH_WORDS, rng, wordCount),
      english: sentence(ENGLISH_WORDS, rng, wordCount),
    })
  }
  return phrases
}

function chunkIntoDecks(phrases: readonly Phrase[], perDeck: number): Deck[] {
  const decks: Deck[] = []
  for (let i = 0; i < phrases.length; i += perDeck) {
    decks.push({
      id: `deck${decks.length}`,
      name: `Deck ${decks.length}`,
      phrases: phrases.slice(i, i + perDeck),
    })
  }
  return decks
}

// ---------------------------------------------------------------------------
// Modelled clip duration/bytes — via the domain's own estimatePauseDuration.
//
// estimatePauseDuration (src/domain/cadence.ts) is the domain's existing
// model of "how long this text takes to say aloud" — its own doc comment
// says the pause "scales with how long the phrase takes to say". Reused
// here as the duration model for a Clip of that text: 65 ms/char, clamped
// to [1500, 5000] ms. This is a MODEL, not a measurement — no real
// ElevenLabs audio is generated — but it is grounded in a formula this
// codebase already committed to, rather than an invented constant. The one
// real data point in the code (eleven-labs-synth-client.ts comment: a ~36 KB
// response, i.e. ~2250 ms, for "a short French phrase") sits inside this
// formula's clamped range, which is the corroboration available without a
// key.
// ---------------------------------------------------------------------------

function modelledClipBytes(text: string): number {
  const durationMs = estimatePauseDuration(text)
  return durationMs * MP3_BYTES_PER_MS_AT_128KBPS
}

function modelledLibraryClipCacheBytes(phrases: readonly Phrase[]): number {
  let total = 0
  for (const phrase of phrases) {
    total += modelledClipBytes(phrase.french) + modelledClipBytes(phrase.english)
  }
  return total
}

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------

interface Row {
  n: number
  clipCacheBytesModelled: number
  coldFillCalls: number
  coldFillConcurrencyMeasured: number
  hashComputeMsMeasured: number
  deckSaveMsMeasured: number
  importAllMsMeasured: number
  exportAllMsMeasured: number
  exportBytesMeasured: number
  readyPhraseIdsColdMsMeasured: number
  readyPhraseIdsWarmMsMeasured: number
}

const results: Row[] = []

describe.skipIf(!RUN)('scale: thousands of Phrases (T032)', () => {
  beforeEach(() => {
    resetFakeIdb()
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(true) }, onLine: true })
  })

  for (const n of LIBRARY_SIZES) {
    it(`measures library size ${n}`, async () => {
      const phrases = generatePhrases(n)
      const decks = chunkIntoDecks(phrases, PHRASES_PER_DECK)

      // 1. Modelled clip cache bytes (2 clips/phrase, FR + EN).
      const clipCacheBytesModelled = modelledLibraryClipCacheBytes(phrases)

      // 2a. Cold-fill call count: read from code, not modelled — generateOne
      // is called once per language per phrase (generation-queue.ts), always,
      // starting from an empty cache. Verified here by actually exercising
      // the real queue against a fake, instant-resolving synth client and
      // counting calls.
      const { createGenerationQueue } = await import('../audio/generation-queue')
      let calls = 0
      const clips = new Map<string, { hash: string; bytes: ArrayBuffer; mime: string; durationMs: number; createdAt: number }>()
      const fakeClipCache = {
        async get(hash: string) {
          return clips.get(hash)
        },
        async put(clip: { hash: string; bytes: ArrayBuffer; mime: string; durationMs: number; createdAt: number }) {
          clips.set(clip.hash, clip)
        },
        async has(hash: string) {
          return clips.has(hash)
        },
        async readyPhraseIds() {
          return new Set<string>()
        },
      }
      const queue = createGenerationQueue({
        synthClient: {
          async synthesize() {
            calls++
            return { bytes: new ArrayBuffer(1), durationMs: 1 }
          },
        },
        clipCache: fakeClipCache,
        getVoice: async () => VOICE,
      })

      for (const phrase of phrases) queue.enqueue(phrase)
      // Flush until every enqueue()'s async IIFE has settled. A pure
      // microtask flush (bare `await Promise.resolve()`) is NOT enough:
      // computeClipHash's crypto.subtle.digest() resolves via a macrotask
      // under Node's real WebCrypto implementation, so this needs the same
      // setTimeout-based flush() the existing generation-queue.test.ts uses.
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0))

      const coldFillCalls = calls

      // 2b. Concurrency: does the queue wait for one Phrase's Clips before
      // starting the next? Measuring "max simultaneous in-flight" against an
      // instant-resolving fake is unreliable — it's dominated by how Node's
      // real WebCrypto scheduler batches digest completions, not by the
      // queue's own logic. A decisive proof instead: give every call a synth
      // client that NEVER resolves, enqueue the whole library, flush, and
      // count how many synthesize() calls were issued anyway. If the queue
      // throttled concurrency, this would stay near the throttle limit
      // (e.g. low single digits) no matter how long we flush; if unbounded,
      // it converges on 2n regardless of nothing ever completing.
      let hangingCalls = 0
      const hangingClipCache = {
        async get() {
          return undefined
        },
        async put() {},
        async has() {
          return false
        },
        async readyPhraseIds() {
          return new Set<string>()
        },
      }
      const hangingQueue = createGenerationQueue({
        synthClient: {
          synthesize() {
            hangingCalls++
            return new Promise(() => {
              /* never resolves — nothing here ever "finishes" */
            })
          },
        },
        clipCache: hangingClipCache,
        getVoice: async () => VOICE,
      })
      for (const phrase of phrases) hangingQueue.enqueue(phrase)
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0))
      const coldFillConcurrencyMeasured = hangingCalls // out of 2n possible

      // 3a. IDB write throughput — save the whole library deck-by-deck
      // (the normal edit path) through the real deck store, against the
      // fake idb.
      const deckStore = createIndexedDbDeckStore()
      const saveStart = performance.now()
      for (const deck of decks) await deckStore.save(deck)
      const deckSaveMsMeasured = performance.now() - saveStart

      // 3b. importAll — the bulk-restore path (one transaction).
      const { buildLibrary } = await import('./library')
      const library = buildLibrary(
        decks.map((d) => ({ id: d.id, name: d.name, phrases: [...d.phrases], createdAt: 1, updatedAt: 1 })),
        // No saved Mixes in the scale fixture: a Mix is a handful of ids,
        // orders of magnitude below the Deck/Phrase volume this benchmark
        // exists to bound.
        [],
        Date.now(),
      )
      const importStart = performance.now()
      await deckStore.importAll(library)
      const importAllMsMeasured = performance.now() - importStart

      // 4. Export file size + timing.
      const exportStart = performance.now()
      const exported = await deckStore.exportAll()
      const exportAllMsMeasured = performance.now() - exportStart
      const serialized = JSON.stringify(exported)
      const exportBytesMeasured = new TextEncoder().encode(serialized).byteLength

      // 5. readyPhraseIds — the drill-start sweep. computeClipHash is
      // called twice per phrase (drill-readiness.ts -> clip-cache.ts),
      // real SHA-256 via crypto.subtle, real per-call cost measured.
      const clipCache = createIndexedDbClipCache()

      const coldStart = performance.now()
      const readyCold = await clipCache.readyPhraseIds(phrases, VOICE)
      const readyPhraseIdsColdMsMeasured = performance.now() - coldStart
      expect(readyCold.size).toBe(0) // nothing cached yet

      // Warm the cache: put a Clip (modelled bytes) for every phrase/lang,
      // so readyPhraseIds' db.getAll(CLIPS_STORE) has to load 2N real
      // ArrayBuffers of realistic (modelled) size out of the fake store —
      // this is what happens on every drill start once the library is
      // fully generated.
      for (const phrase of phrases) {
        const frHash = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: phrase.french })
        const enHash = await computeClipHash({ ...VOICE, lang: 'en-US', text: phrase.english })
        await clipCache.put({
          hash: frHash,
          bytes: new ArrayBuffer(Math.max(1, Math.round(modelledClipBytes(phrase.french)))),
          mime: 'audio/mpeg',
          durationMs: estimatePauseDuration(phrase.french),
          createdAt: Date.now(),
        })
        await clipCache.put({
          hash: enHash,
          bytes: new ArrayBuffer(Math.max(1, Math.round(modelledClipBytes(phrase.english)))),
          mime: 'audio/mpeg',
          durationMs: estimatePauseDuration(phrase.english),
          createdAt: Date.now(),
        })
      }

      const warmStart = performance.now()
      const readyWarm = await clipCache.readyPhraseIds(phrases, VOICE)
      const readyPhraseIdsWarmMsMeasured = performance.now() - warmStart
      expect(readyWarm.size).toBe(n) // everything now ready

      // 6. Raw hashing cost in isolation: 2N SHA-256 digests, nothing else.
      const hashStart = performance.now()
      for (const phrase of phrases) {
        await computeClipHash({ ...VOICE, lang: 'fr-FR', text: phrase.french })
        await computeClipHash({ ...VOICE, lang: 'en-US', text: phrase.english })
      }
      const hashComputeMsMeasured = performance.now() - hashStart

      const row: Row = {
        n,
        clipCacheBytesModelled,
        coldFillCalls,
        coldFillConcurrencyMeasured,
        hashComputeMsMeasured,
        deckSaveMsMeasured,
        importAllMsMeasured,
        exportAllMsMeasured,
        exportBytesMeasured,
        readyPhraseIdsColdMsMeasured,
        readyPhraseIdsWarmMsMeasured,
      }
      results.push(row)

      console.log(`[scale n=${n}]`, JSON.stringify(row, null, 2))
    }, 60_000)
  }

  it('prints the full table once every size has run', () => {
    if (results.length !== LIBRARY_SIZES.length) return
    console.table(results)
  })
})
