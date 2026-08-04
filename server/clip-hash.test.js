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
