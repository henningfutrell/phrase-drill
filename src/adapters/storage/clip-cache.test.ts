import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetFakeIdb } from './idb.test-support'
import { createIndexedDbDeckStore } from './indexed-db-deck-store'

vi.mock('idb', async () => {
  const fake = await import('./idb.test-support')
  return { openDB: fake.openDB }
})

// Imported after the mock is registered, per Vitest's hoisting contract.
const { createIndexedDbClipCache, computeClipHash } = await import('./clip-cache')

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

      const ready = await cache.readyPhraseIds(phrases, VOICE)

      expect(ready).toEqual(new Set(['p1']))
    })

    it('excludes a phrase whose text was edited after its old clip was cached, forcing regeneration', async () => {
      const cache = createIndexedDbClipCache()
      const staleHash = await computeClipHash({ ...VOICE, lang: 'fr-FR' as const, text: 'Old text' })
      await cache.put({ hash: staleHash, bytes: bytesOf('old'), mime: 'audio/mpeg', durationMs: 1, createdAt: 1 })
      const enHash = await computeClipHash({ ...VOICE, lang: 'en-US' as const, text: 'Hello' })
      await cache.put({ hash: enHash, bytes: bytesOf('en'), mime: 'audio/mpeg', durationMs: 1, createdAt: 1 })

      const edited = [{ id: 'p1', french: 'New text', english: 'Hello' }]
      const ready = await cache.readyPhraseIds(edited, VOICE)

      expect(ready).toEqual(new Set())
    })

    it('excludes every phrase when the pinned voice changes, invalidating the whole cache', async () => {
      const cache = createIndexedDbClipCache()
      const frHash = await computeClipHash({ ...VOICE, lang: 'fr-FR' as const, text: 'Bonjour' })
      const enHash = await computeClipHash({ ...VOICE, lang: 'en-US' as const, text: 'Hello' })
      await cache.put({ hash: frHash, bytes: bytesOf('fr'), mime: 'audio/mpeg', durationMs: 1, createdAt: 1 })
      await cache.put({ hash: enHash, bytes: bytesOf('en'), mime: 'audio/mpeg', durationMs: 1, createdAt: 1 })

      const otherVoice = { ...VOICE, voiceId: 'voice-2' }
      const ready = await cache.readyPhraseIds([{ id: 'p1', french: 'Bonjour', english: 'Hello' }], otherVoice)

      expect(ready).toEqual(new Set())
    })

    it('returns an empty set for an empty phrase list', async () => {
      const cache = createIndexedDbClipCache()
      expect(await cache.readyPhraseIds([], VOICE)).toEqual(new Set())
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
})
