// Named `.integration.test.ts` for the same reason
// `server-translator.integration.test.ts` is: `tsconfig.app.json` excludes
// that pattern, so a TypeScript test may import the server's plain-JS
// modules without `tsc -b` demanding declarations for them.
//
// What it proves: the device's clip key and the server's clip key are the
// same function of the same five fields. T063 makes the server-side shared
// Clip store use *the* content address, not a second one that happens to
// look like it. Two implementations of one derivation can drift silently —
// this test is what makes them fail together instead.
import { describe, expect, it } from 'vitest'
import { computeClipHash as serverComputeClipHash, clipHashMaterial } from '../../../server/clip-hash.js'
import { computeClipHash as deviceComputeClipHash } from './clip-cache'
import type { Language } from '../../domain'

interface Vector {
  readonly provider: string
  readonly modelId: string
  readonly voiceId: string
  readonly lang: Language
  readonly text: string
}

const VECTORS: readonly Vector[] = [
  { provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-1', lang: 'fr-FR', text: 'Bonjour' },
  { provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-1', lang: 'en-US', text: 'Bonjour' },
  { provider: 'elevenlabs', modelId: 'eleven_v3', voiceId: 'voice-2', lang: 'fr-FR', text: "J'aimerais un café, s'il vous plaît." },
  // Non-ASCII, a pipe in the text, and leading/trailing space: the material
  // string is not escaped, so these are the shapes that would expose an
  // encoding difference between `TextEncoder` and Node's utf8 handling.
  { provider: 'elevenlabs', modelId: 'm|1', voiceId: 'v 2', lang: 'fr-FR', text: ' Où ça? | Là-bas… ' },
]

describe('clip hash parity between the device and the server', () => {
  it.each(VECTORS)('agrees on $lang "$text"', async (vector) => {
    expect(await deviceComputeClipHash(vector)).toBe(serverComputeClipHash(vector))
  })

  it('both sides address the same material string', () => {
    expect(clipHashMaterial(VECTORS[0]!)).toBe('elevenlabs|eleven_multilingual_v2|voice-1|fr-FR|Bonjour')
  })
})
