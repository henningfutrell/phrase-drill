import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Clip } from './clip-cache'
import { openDB, resetFakeIdb } from './idb.test-support'
import { createIndexedDbDeckStore } from './indexed-db-deck-store'

vi.mock('idb', async () => {
  const fake = await import('./idb.test-support')
  return { openDB: fake.openDB }
})

// Imported after the mock is registered, per Vitest's hoisting contract.
const { createIndexedDbClipCache, computeClipHash, DEFAULT_CLIP_CACHE_MAX_BYTES } = await import('./clip-cache')
const { CLIPS_STORE, CLIP_META_STORE, DB_NAME } = await import('./database')

const VOICE = { provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-1' }

function bytesOf(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer
}

describe('computeClipHash', () => {
  it('is deterministic for the same provider/model/voice/lang/text', async () => {
    const key = { ...VOICE, lang: 'fr-FR' as const, text: 'Bonjour' }
    expect(await computeClipHash(key)).toBe(await computeClipHash(key))
  })

  it('changes when the text changes — an edited Phrase orphans its old clip', async () => {
    const a = await computeClipHash({ ...VOICE, lang: 'fr-FR' as const, text: 'Bonjour' })
    const b = await computeClipHash({ ...VOICE, lang: 'fr-FR' as const, text: 'Salut' })
    expect(a).not.toBe(b)
  })

  it('changes when the language changes, even for the same text', async () => {
    const fr = await computeClipHash({ ...VOICE, lang: 'fr-FR' as const, text: 'Salut' })
    const en = await computeClipHash({ ...VOICE, lang: 'en-US' as const, text: 'Salut' })
    expect(fr).not.toBe(en)
  })

  it('changes when the pinned voice changes — a voice change invalidates the whole cache', async () => {
    const a = await computeClipHash({ ...VOICE, lang: 'fr-FR' as const, text: 'Bonjour' })
    const b = await computeClipHash({ ...VOICE, voiceId: 'voice-2', lang: 'fr-FR' as const, text: 'Bonjour' })
    expect(a).not.toBe(b)
  })

  it('changes when the model changes, even with the same voice id', async () => {
    const a = await computeClipHash({ ...VOICE, lang: 'fr-FR' as const, text: 'Bonjour' })
    const b = await computeClipHash({ ...VOICE, modelId: 'eleven_v3', lang: 'fr-FR' as const, text: 'Bonjour' })
    expect(a).not.toBe(b)
  })
})

describe('createIndexedDbClipCache', () => {
  beforeEach(() => {
    resetFakeIdb()
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(true) } })
  })

  it('reports a clip absent until it is put, then present', async () => {
    const cache = createIndexedDbClipCache()
    const hash = await computeClipHash({ ...VOICE, lang: 'fr-FR' as const, text: 'Bonjour' })

    expect(await cache.has(hash)).toBe(false)
    expect(await cache.get(hash)).toBeUndefined()

    await cache.put({ hash, bytes: bytesOf('audio'), mime: 'audio/mpeg', durationMs: 1200, createdAt: 1 })

    expect(await cache.has(hash)).toBe(true)
    expect(await cache.get(hash)).toEqual({
      hash,
      bytes: bytesOf('audio'),
      mime: 'audio/mpeg',
      durationMs: 1200,
      createdAt: 1,
    })
  })

  it('overwrites a clip stored under the same hash rather than duplicating it', async () => {
    const cache = createIndexedDbClipCache()
    const hash = await computeClipHash({ ...VOICE, lang: 'fr-FR' as const, text: 'Bonjour' })
    await cache.put({ hash, bytes: bytesOf('v1'), mime: 'audio/mpeg', durationMs: 1, createdAt: 1 })
    await cache.put({ hash, bytes: bytesOf('v2'), mime: 'audio/mpeg', durationMs: 2, createdAt: 2 })

    expect((await cache.get(hash))?.durationMs).toBe(2)
  })

  describe('readyPhraseIds', () => {
    it('returns only the phrases whose FR and EN clips are both cached', async () => {
      const cache = createIndexedDbClipCache()
      const phrases = [
        { id: 'p1', french: 'Bonjour', english: 'Hello' },
        { id: 'p2', french: 'Salut', english: 'Hi' },
      ]
      const frHash1 = await computeClipHash({ ...VOICE, lang: 'fr-FR' as const, text: 'Bonjour' })
      const enHash1 = await computeClipHash({ ...VOICE, lang: 'en-US' as const, text: 'Hello' })
      await cache.put({ hash: frHash1, bytes: bytesOf('fr'), mime: 'audio/mpeg', durationMs: 1, createdAt: 1 })
      await cache.put({ hash: enHash1, bytes: bytesOf('en'), mime: 'audio/mpeg', durationMs: 1, createdAt: 1 })
      // p2 gets only its FR clip — not ready.
      const frHash2 = await computeClipHash({ ...VOICE, lang: 'fr-FR' as const, text: 'Salut' })
      await cache.put({ hash: frHash2, bytes: bytesOf('fr2'), mime: 'audio/mpeg', durationMs: 1, createdAt: 1 })

      const ready = await cache.readyPhraseIds(phrases, [VOICE])

      expect(ready).toEqual(new Set(['p1']))
    })

    it('excludes a phrase whose text was edited after its old clip was cached, forcing regeneration', async () => {
      const cache = createIndexedDbClipCache()
      const staleHash = await computeClipHash({ ...VOICE, lang: 'fr-FR' as const, text: 'Old text' })
      await cache.put({ hash: staleHash, bytes: bytesOf('old'), mime: 'audio/mpeg', durationMs: 1, createdAt: 1 })
      const enHash = await computeClipHash({ ...VOICE, lang: 'en-US' as const, text: 'Hello' })
      await cache.put({ hash: enHash, bytes: bytesOf('en'), mime: 'audio/mpeg', durationMs: 1, createdAt: 1 })

      const edited = [{ id: 'p1', french: 'New text', english: 'Hello' }]
      const ready = await cache.readyPhraseIds(edited, [VOICE])

      expect(ready).toEqual(new Set())
    })

    /**
     * T067. A Clip's voice is a property of that Clip, not of the app: a
     * Phrase whose audio exists in ANY of the voices offered is ready, and
     * re-pinning cannot make a library unready. The old behaviour — every
     * Phrase unready the moment the pinned voice changed — is what queued
     * a whole library for regeneration.
     */
    it('keeps a phrase ready when its clips exist in a voice other than the pinned one', async () => {
      const cache = createIndexedDbClipCache()
      const frHash = await computeClipHash({ ...VOICE, lang: 'fr-FR' as const, text: 'Bonjour' })
      const enHash = await computeClipHash({ ...VOICE, lang: 'en-US' as const, text: 'Hello' })
      await cache.put({ hash: frHash, bytes: bytesOf('fr'), mime: 'audio/mpeg', durationMs: 1, createdAt: 1 })
      await cache.put({ hash: enHash, bytes: bytesOf('en'), mime: 'audio/mpeg', durationMs: 1, createdAt: 1 })

      const newlyPinned = { ...VOICE, voiceId: 'voice-2' }
      const ready = await cache.readyPhraseIds([{ id: 'p1', french: 'Bonjour', english: 'Hello' }], [
        newlyPinned,
        VOICE,
      ])

      expect(ready).toEqual(new Set(['p1']))
    })

    it('excludes a phrase whose clips are in no offered voice at all', async () => {
      const cache = createIndexedDbClipCache()
      const frHash = await computeClipHash({ ...VOICE, lang: 'fr-FR' as const, text: 'Bonjour' })
      const enHash = await computeClipHash({ ...VOICE, lang: 'en-US' as const, text: 'Hello' })
      await cache.put({ hash: frHash, bytes: bytesOf('fr'), mime: 'audio/mpeg', durationMs: 1, createdAt: 1 })
      await cache.put({ hash: enHash, bytes: bytesOf('en'), mime: 'audio/mpeg', durationMs: 1, createdAt: 1 })

      const ready = await cache.readyPhraseIds([{ id: 'p1', french: 'Bonjour', english: 'Hello' }], [
        { ...VOICE, voiceId: 'voice-2' },
      ])

      expect(ready).toEqual(new Set())
    })

    it('counts a phrase ready when one side is cached in one voice and the other side in another', async () => {
      const cache = createIndexedDbClipCache()
      const other = { ...VOICE, voiceId: 'voice-2' }
      const frHash = await computeClipHash({ ...VOICE, lang: 'fr-FR' as const, text: 'Bonjour' })
      const enHash = await computeClipHash({ ...other, lang: 'en-US' as const, text: 'Hello' })
      await cache.put({ hash: frHash, bytes: bytesOf('fr'), mime: 'audio/mpeg', durationMs: 1, createdAt: 1 })
      await cache.put({ hash: enHash, bytes: bytesOf('en'), mime: 'audio/mpeg', durationMs: 1, createdAt: 1 })

      const ready = await cache.readyPhraseIds([{ id: 'p1', french: 'Bonjour', english: 'Hello' }], [VOICE, other])

      expect(ready).toEqual(new Set(['p1']))
    })

    it('asks about no voice it was not given — an empty voice list makes nothing ready', async () => {
      const cache = createIndexedDbClipCache()
      const frHash = await computeClipHash({ ...VOICE, lang: 'fr-FR' as const, text: 'Bonjour' })
      const enHash = await computeClipHash({ ...VOICE, lang: 'en-US' as const, text: 'Hello' })
      await cache.put({ hash: frHash, bytes: bytesOf('fr'), mime: 'audio/mpeg', durationMs: 1, createdAt: 1 })
      await cache.put({ hash: enHash, bytes: bytesOf('en'), mime: 'audio/mpeg', durationMs: 1, createdAt: 1 })

      expect(await cache.readyPhraseIds([{ id: 'p1', french: 'Bonjour', english: 'Hello' }], [])).toEqual(new Set())
    })

    it('returns an empty set for an empty phrase list', async () => {
      const cache = createIndexedDbClipCache()
      expect(await cache.readyPhraseIds([], [VOICE])).toEqual(new Set())
    })
  })

  describe('export exclusion', () => {
    it('never includes a cached clip hash or its bytes in a Deck export — clips are derived cache, not user data', async () => {
      const cache = createIndexedDbClipCache()
      const deckStore = createIndexedDbDeckStore()
      await deckStore.save({
        id: 'd1',
        name: 'Home',
        phrases: [{ id: 'p1', french: 'Bonjour', english: 'Hello' }],
      })

      const hash = await computeClipHash({ ...VOICE, lang: 'fr-FR' as const, text: 'Bonjour' })
      await cache.put({
        hash,
        bytes: bytesOf('clip-bytes-should-not-leak'),
        mime: 'audio/mpeg',
        durationMs: 1234,
        createdAt: 1,
      })

      const library = await deckStore.exportAll()

      const serialized = JSON.stringify(library)
      expect(serialized).not.toContain(hash)
      expect(serialized).not.toContain('clip-bytes-should-not-leak')
    })
  })

  /**
   * T036 — the cache is bounded and evicts, because on iOS an origin that
   * grows to hundreds of MB is an origin the browser may evict *whole*,
   * Phrases included. A Clip is regenerable; a Phrase is not, so the cache
   * throws Clips away readily rather than risk the library that gives them
   * meaning.
   */
  describe('the bound', () => {
    function sizedClip(hash: string, bytes: number): Clip {
      return { hash, bytes: new ArrayBuffer(bytes), mime: 'audio/mpeg', durationMs: 1000, createdAt: 1 }
    }

    /** A strictly increasing clock, so "least recently played" is unambiguous. */
    function ticking(): () => number {
      let t = 0
      return () => (t += 1)
    }

    it('has a ceiling even when created with no options', async () => {
      expect(DEFAULT_CLIP_CACHE_MAX_BYTES).toBeGreaterThan(0)
      expect((await createIndexedDbClipCache().usage()).maxBytes).toBe(DEFAULT_CLIP_CACHE_MAX_BYTES)
    })

    it('states what it is holding: bytes, clip count, and the ceiling', async () => {
      const cache = createIndexedDbClipCache({ maxBytes: 1000 })
      await cache.put(sizedClip('a', 100))
      await cache.put(sizedClip('b', 250))

      expect(await cache.usage()).toEqual({ bytes: 350, clipCount: 2, maxBytes: 1000 })
    })

    it('counts a re-put of the same hash once, not twice', async () => {
      const cache = createIndexedDbClipCache({ maxBytes: 1000 })
      await cache.put(sizedClip('a', 100))
      await cache.put(sizedClip('a', 300))

      expect(await cache.usage()).toEqual({ bytes: 300, clipCount: 1, maxBytes: 1000 })
    })

    it('evicts the least recently played clip when a put crosses the ceiling', async () => {
      const cache = createIndexedDbClipCache({ maxBytes: 1000, now: ticking() })
      await cache.put(sizedClip('a', 400))
      await cache.put(sizedClip('b', 400))
      // She drills the Deck holding `a` again; `b` is the one she left behind.
      await cache.get('a')

      await cache.put(sizedClip('c', 400))

      expect(await cache.has('b')).toBe(false)
      expect(await cache.has('a')).toBe(true)
      expect(await cache.has('c')).toBe(true)
      expect((await cache.usage()).bytes).toBeLessThanOrEqual(1000)
    })

    it('does not treat a readiness check as playing a clip — only a real play counts', async () => {
      const cache = createIndexedDbClipCache({ maxBytes: 1000, now: ticking() })
      await cache.put(sizedClip('a', 400))
      await cache.put(sizedClip('b', 400))
      // `has` is the generation/readiness question, asked of every Phrase in
      // the library. If it counted as use, the sweep would reset every clip's
      // age at once and the policy would degrade to "evict whatever is last".
      await cache.has('a')

      await cache.put(sizedClip('c', 400))

      expect(await cache.has('a')).toBe(false)
      expect(await cache.has('b')).toBe(true)
    })

    it('never evicts the clip it was just asked to cache', async () => {
      const cache = createIndexedDbClipCache({ maxBytes: 1000, now: ticking() })
      await cache.put(sizedClip('a', 500))
      await cache.put(sizedClip('b', 400))

      await cache.put(sizedClip('c', 900))

      expect(await cache.has('c')).toBe(true)
      expect(await cache.has('a')).toBe(false)
      expect(await cache.has('b')).toBe(false)
    })

    it('remembers when a clip was last played across a restart', async () => {
      const clock = ticking()
      const first = createIndexedDbClipCache({ maxBytes: 1000, now: clock })
      await first.put(sizedClip('a', 400))
      await first.put(sizedClip('b', 400))
      await first.get('a')

      // A new cache instance is what a fresh app launch builds — the ordering
      // has to come off disk, not out of the instance that observed the play.
      const second = createIndexedDbClipCache({ maxBytes: 1000, now: clock })
      await second.put(sizedClip('c', 400))

      expect(await second.has('b')).toBe(false)
      expect(await second.has('a')).toBe(true)
    })

    it('reports an evicted Phrase as no longer ready, rather than claiming audio it threw away', async () => {
      const cache = createIndexedDbClipCache({ maxBytes: 1600, now: ticking() })
      const phrases = [
        { id: 'p1', french: 'Bonjour', english: 'Hello' },
        { id: 'p2', french: 'Salut', english: 'Hi' },
      ]
      for (const phrase of phrases) {
        await cache.put(sizedClip(await computeClipHash({ ...VOICE, lang: 'fr-FR', text: phrase.french }), 500))
        await cache.put(sizedClip(await computeClipHash({ ...VOICE, lang: 'en-US', text: phrase.english }), 500))
      }

      expect(await cache.readyPhraseIds(phrases, [VOICE])).toEqual(new Set(['p2']))
    })

    it('counts clips cached before the bound existed, instead of reporting an empty cache', async () => {
      // A schema-v5 database: the shape on her phone before this change — a
      // `clips` store with real audio in it and no size index beside it. Her
      // cache must not read as empty and must not have to be regenerated.
      const legacy = await openDB(DB_NAME, 5, {
        upgrade(db) {
          db.createObjectStore('decks', { keyPath: 'id' })
          db.createObjectStore('settings')
          db.createObjectStore(CLIPS_STORE, { keyPath: 'hash' })
          db.createObjectStore('errors', { keyPath: 'id' })
          db.createObjectStore('mixes', { keyPath: 'id' })
          db.createObjectStore('tombstones', { keyPath: 'id' })
        },
      })
      await legacy.put(CLIPS_STORE, sizedClip('old-1', 4096))
      await legacy.put(CLIPS_STORE, sizedClip('old-2', 2048))

      const cache = createIndexedDbClipCache({ maxBytes: 1_000_000 })

      expect(await cache.usage()).toEqual({ bytes: 6144, clipCount: 2, maxBytes: 1_000_000 })
      // Written down at upgrade time, not recomputed on every launch — the
      // whole point of a separate index is that reading it never touches the
      // audio bytes.
      const upgraded = await openDB(DB_NAME, 6)
      expect((await upgraded.getAll(CLIP_META_STORE)).length).toBe(2)
    })
  })
})
