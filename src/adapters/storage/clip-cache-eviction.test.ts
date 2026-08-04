/**
 * T036 acceptance — the bound holds against a MODELLED 10,000-Phrase library,
 * and the library survives it.
 *
 * T032 (docs/scale.md §1) modelled that library at ~890 MB of cached audio
 * with no eviction path anywhere in the code. On iOS, storage pressure is
 * itself an eviction trigger, so an origin that fat is an origin the browser
 * may throw away *whole* — Phrases included. This file is the proof that it
 * no longer gets fat, and the proof that getting thin cannot touch a Phrase.
 *
 * Everything here runs the real `clip-cache.ts`, `indexed-db-deck-store.ts`
 * and `indexed-db-mix-store.ts` against the in-memory `idb` fake
 * (`idb.test-support.ts`), the same way `scale.bench.test.ts` does. Clip
 * sizes are MODELLED with the domain's own `estimatePauseDuration` × 16
 * bytes/ms — the identical model docs/scale.md §1 used, reused rather than
 * re-invented so the ceiling is judged against the same numbers that
 * motivated it. No network call is made.
 *
 * Assertions are on the bytes actually resident in the `clips` store, read
 * back out of it — never on an eviction function having been called.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { estimatePauseDuration, type Phrase } from '../../domain'
import type { Clip } from './clip-cache'
import { idbDestructiveOperations, resetFakeIdb } from './idb.test-support'

vi.mock('idb', async () => {
  const fake = await import('./idb.test-support')
  return { openDB: fake.openDB }
})

// Imported after the mock is registered, per Vitest's hoisting contract.
const { createIndexedDbClipCache, computeClipHash, DEFAULT_CLIP_CACHE_MAX_BYTES } = await import('./clip-cache')
const { createIndexedDbDeckStore } = await import('./indexed-db-deck-store')
const { createIndexedDbMixStore } = await import('./indexed-db-mix-store')
const { CLIPS_STORE, CLIP_META_STORE, openDatabase } = await import('./database')

const VOICE = { provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-1' }

const LIBRARY_SIZE = 10_000
const PHRASES_PER_DECK = 50

/** MODELLED: MP3 bytes per ms at the 128 kbps output format (docs/scale.md §1). */
const MP3_BYTES_PER_MS_AT_128KBPS = 16

/** Deterministic PRNG (mulberry32) — the same synthetic library every run. */
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
  'ce', 'soir', 'ou', 'est', 'la', 'gare', 'plus', 'proche', 'pouvez',
  'vous', 'repeter', 'lentement', 'combien', 'ca', 'coute', 'ne',
  'comprends', 'pas', 'excusez', 'moi', 'quelle', 'heure', 'il',
  'bonjour', 'merci', 'beaucoup', 'au', 'revoir', 'a', 'bientot',
]
const ENGLISH_WORDS = [
  'i', 'would', 'like', 'to', 'book', 'a', 'table', 'for', 'two', 'people',
  'tonight', 'where', 'is', 'the', 'nearest', 'train', 'station', 'can',
  'you', 'repeat', 'that', 'slowly', 'how', 'much', 'does', 'it', 'cost',
  'do', 'not', 'understand', 'excuse', 'me', 'what', 'time',
  'hello', 'thank', 'goodbye', 'see', 'soon',
]

function sentence(words: readonly string[], rng: () => number, wordCount: number): string {
  const picked: string[] = []
  for (let i = 0; i < wordCount; i++) picked.push(words[Math.floor(rng() * words.length)])
  const s = picked.join(' ')
  return s.charAt(0).toUpperCase() + s.slice(1) + '.'
}

function generatePhrases(n: number, seed = 42): Phrase[] {
  const rng = mulberry32(seed)
  const phrases: Phrase[] = []
  for (let i = 0; i < n; i++) {
    const wordCount = 4 + Math.floor(rng() * 9)
    phrases.push({
      id: `p${i}`,
      french: sentence(FRENCH_WORDS, rng, wordCount),
      english: sentence(ENGLISH_WORDS, rng, wordCount),
    })
  }
  return phrases
}

/** MODELLED clip size for one side of one Phrase — docs/scale.md §1's formula. */
function modelledClipBytes(text: string): number {
  return Math.round(estimatePauseDuration(text) * MP3_BYTES_PER_MS_AT_128KBPS)
}

describe('clip cache eviction against a modelled 10,000-Phrase library (T036)', () => {
  beforeEach(() => {
    resetFakeIdb()
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(true) }, onLine: true })
  })

  it('stays under its ceiling, evicts to get there, and leaves every Phrase, Deck and Mix intact', async () => {
    const phrases = generatePhrases(LIBRARY_SIZE)
    const deckStore = createIndexedDbDeckStore()
    const mixStore = createIndexedDbMixStore()

    const deckIds: string[] = []
    for (let i = 0; i < phrases.length; i += PHRASES_PER_DECK) {
      const id = `deck${deckIds.length}`
      deckIds.push(id)
      await deckStore.save({ id, name: `Deck ${deckIds.length}`, phrases: phrases.slice(i, i + PHRASES_PER_DECK) })
    }
    await mixStore.save({ id: 'm1', name: 'Mornings', deckIds: deckIds.slice(0, 3) })

    const librarySnapshotBefore = JSON.stringify(await deckStore.exportAll())
    const mixesSnapshotBefore = JSON.stringify(await mixStore.loadAll())

    // The whole modelled library's audio, cached one Clip at a time — the
    // cold-fill path, exactly as generation-queue.ts drives it.
    const modelledTotalBytes = phrases.reduce(
      (sum, p) => sum + modelledClipBytes(p.french) + modelledClipBytes(p.english),
      0,
    )
    expect(modelledTotalBytes).toBeGreaterThan(DEFAULT_CLIP_CACHE_MAX_BYTES)

    idbDestructiveOperations.length = 0
    const cache = createIndexedDbClipCache()
    for (const phrase of phrases) {
      for (const [lang, text] of [['fr-FR', phrase.french], ['en-US', phrase.english]] as const) {
        const hash = await computeClipHash({ ...VOICE, lang, text })
        await cache.put({
          hash,
          bytes: new ArrayBuffer(modelledClipBytes(text)),
          mime: 'audio/mpeg',
          durationMs: estimatePauseDuration(text),
          createdAt: 1,
        })
      }
    }

    // MEASURED, off the store itself — not off the cache's own bookkeeping.
    const db = await openDatabase()
    const resident = (await db.getAll(CLIPS_STORE)) as Clip[]
    const residentBytes = resident.reduce((sum, clip) => sum + clip.bytes.byteLength, 0)

    expect(residentBytes).toBeLessThanOrEqual(DEFAULT_CLIP_CACHE_MAX_BYTES)
    // Eviction actually happened: far fewer than the 20,000 Clips put.
    expect(resident.length).toBeLessThan(phrases.length * 2)
    expect(resident.length).toBeGreaterThan(0)
    // The cache's own account of itself matches the store, so the number the
    // UI shows her is the number on disk.
    expect(await cache.usage()).toEqual({
      bytes: residentBytes,
      clipCount: resident.length,
      maxBytes: DEFAULT_CLIP_CACHE_MAX_BYTES,
    })
    // The size index does not outlive the audio it indexes.
    expect((await db.getAll(CLIP_META_STORE)).length).toBe(resident.length)

    // The library is untouched — byte for byte.
    expect(JSON.stringify(await deckStore.exportAll())).toBe(librarySnapshotBefore)
    expect(JSON.stringify(await mixStore.loadAll())).toBe(mixesSnapshotBefore)
  }, 300_000)

  it('cannot delete anything but a Clip — eviction never reaches a store holding her library', async () => {
    const phrases = generatePhrases(LIBRARY_SIZE)
    const deckStore = createIndexedDbDeckStore()
    for (let i = 0; i < phrases.length; i += PHRASES_PER_DECK) {
      await deckStore.save({
        id: `deck${i}`,
        name: `Deck ${i}`,
        phrases: phrases.slice(i, i + PHRASES_PER_DECK),
      })
    }

    idbDestructiveOperations.length = 0
    const cache = createIndexedDbClipCache()
    for (const phrase of phrases) {
      for (const [lang, text] of [['fr-FR', phrase.french], ['en-US', phrase.english]] as const) {
        await cache.put({
          hash: await computeClipHash({ ...VOICE, lang, text }),
          bytes: new ArrayBuffer(modelledClipBytes(text)),
          mime: 'audio/mpeg',
          durationMs: estimatePauseDuration(text),
          createdAt: 1,
        })
      }
    }

    // `delete` and `clear` are the only two ways a record leaves IndexedDB, so
    // this is the complete list of what the cold fill was able to destroy.
    expect(idbDestructiveOperations.length).toBeGreaterThan(0)
    const stores = [...new Set(idbDestructiveOperations.map((op) => op.store))].sort()
    expect(stores).toEqual([CLIP_META_STORE, CLIPS_STORE].sort())
    expect(idbDestructiveOperations.some((op) => op.op === 'clear')).toBe(false)
  }, 300_000)
})
