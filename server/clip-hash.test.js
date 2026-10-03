// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { clipHashMaterial, computeClipHash } from './clip-hash.js'

/**
 * This derivation is one half of a pair. The other half is
 * `src/adapters/storage/clip-cache.ts#computeClipHash`, which addresses the
 * device's own IndexedDB cache. They must agree byte for byte or the shared
 * store and the local cache key the same audio differently and the sharing
 * silently stops working.
 *
 * These tests pin the server half's shape. The two halves are pinned
 * *against each other* by
 * `src/adapters/storage/clip-hash-parity.integration.test.ts`, which imports
 * both and compares them — a change to either side fails that test.
 */
const KEY = { provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-1', lang: 'fr-FR', text: 'Bonjour' }

describe('clipHashMaterial', () => {
  it('is the five fields joined by a pipe, in provider/model/voice/lang/text order', () => {
    expect(clipHashMaterial(KEY)).toBe('elevenlabs|eleven_multilingual_v2|voice-1|fr-FR|Bonjour')
  })
})

describe('computeClipHash', () => {
  it('is SHA-256 of the material string, as 64 lowercase hex characters', () => {
    const hash = computeClipHash(KEY)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(computeClipHash(KEY)).toBe(hash)
  })

  it('changes when the text changes — an edited Phrase points at a different clip', () => {
    expect(computeClipHash({ ...KEY, text: 'Salut' })).not.toBe(computeClipHash(KEY))
  })

  it('changes when the language changes, even for the same text', () => {
    expect(computeClipHash({ ...KEY, lang: 'en-US' })).not.toBe(computeClipHash(KEY))
  })

  it('changes when the pinned voice changes', () => {
    expect(computeClipHash({ ...KEY, voiceId: 'voice-2' })).not.toBe(computeClipHash(KEY))
  })

  it('changes when the model changes, even with the same voice id', () => {
    expect(computeClipHash({ ...KEY, modelId: 'eleven_v3' })).not.toBe(computeClipHash(KEY))
  })

  it('changes when the provider changes', () => {
    expect(computeClipHash({ ...KEY, provider: 'other' })).not.toBe(computeClipHash(KEY))
  })
})

/**
 * S8a. The material is the five fields joined by '|', unescaped, so without
 * a rule two different keys could share one string — `{voiceId: 'a|b', lang:
 * 'c'}` and `{voiceId: 'a', lang: 'b|c'}` — and so one address, and one
 * stored Clip served for both. Forbidding the delimiter in the first four
 * fields makes the encoding injective; `text` is last, so it may hold
 * anything, and no address that exists today changes.
 */
describe('the delimiter rule', () => {
  it.each(['provider', 'modelId', 'voiceId', 'lang'])('refuses a "|" in %s, the same from either function', (field) => {
    const key = { ...KEY, [field]: `${KEY[field]}|x` }
    expect(() => clipHashMaterial(key)).toThrow(/\|/)
    expect(() => computeClipHash(key)).toThrow(/\|/)
  })

  it('accepts a "|" in the text — the last field cannot be confused with a boundary', () => {
    expect(clipHashMaterial({ ...KEY, text: 'a | b' })).toBe('elevenlabs|eleven_multilingual_v2|voice-1|fr-FR|a | b')
  })

  it('leaves every existing address exactly as it was', () => {
    // The hash of the material string above, computed before the rule existed.
    // The server stores only hashes and cannot rehash, so a moved address is a
    // re-billed library.
    expect(computeClipHash(KEY)).toBe('b7c1c7394cfa3648a877fff841e14bbfee690ef152b58467e325be8fc911f3ae')
  })
})

