// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { validateClip } from './clip-validation.js'

/** A plausible MP3: an ID3 tag header, padded to `size` bytes. */
function mp3({ size = 20_000, head = [0x49, 0x44, 0x33] } = {}) {
  const bytes = Buffer.alloc(size)
  Buffer.from(head).copy(bytes)
  return bytes
}
const ok = (overrides = {}) => ({ bytes: mp3(), contentType: 'audio/mpeg', text: 'Bonjour tout le monde', ...overrides })

describe('validateClip', () => {
  it('accepts an ID3-tagged audio/mpeg body of plausible size', () => {
    expect(validateClip(ok())).toBeNull()
  })

  it('accepts a bare MP3 frame sync (0xFF 0xFB) instead of an ID3 tag', () => {
    expect(validateClip(ok({ bytes: mp3({ head: [0xff, 0xfb] }) }))).toBeNull()
  })

  it('accepts the content-type case-insensitively, with parameters', () => {
    expect(validateClip(ok({ contentType: 'Audio/MPEG; charset=binary' }))).toBeNull()
  })

  it('rejects a missing content-type', () => {
    expect(validateClip(ok({ contentType: null }))).toMatch(/content-type/)
  })

  it('rejects a non-audio content-type even when the bytes look like an MP3', () => {
    expect(validateClip(ok({ contentType: 'application/json' }))).toMatch(/content-type/)
  })

  it('rejects a body that opens with neither ID3 nor a frame sync', () => {
    expect(validateClip(ok({ bytes: mp3({ head: [0x7b, 0x22] }) }))).toMatch(/MP3/)
  })

  it('rejects 0xFF followed by a byte whose top three bits are not all set', () => {
    expect(validateClip(ok({ bytes: mp3({ head: [0xff, 0xc0] }) }))).toMatch(/MP3/)
  })

  it('rejects a body too short to be an MP3 at all, without reading past it', () => {
    expect(validateClip(ok({ bytes: Buffer.alloc(1) }))).not.toBeNull()
  })

  describe('size band: min = max(1000, 100 * chars), max = 6400 * chars + 48000', () => {
    it('rejects 999 bytes for any text, accepts 1000 for a short one', () => {
      expect(validateClip(ok({ text: 'Merci', bytes: mp3({ size: 999 }) }))).toMatch(/short/)
      expect(validateClip(ok({ text: 'Merci', bytes: mp3({ size: 1000 }) }))).toBeNull()
    })

    it('raises the floor with the text: 100 bytes per character', () => {
      const text = 'x'.repeat(50) // 5000 bytes
      expect(validateClip(ok({ text, bytes: mp3({ size: 4999 }) }))).toMatch(/short/)
      expect(validateClip(ok({ text, bytes: mp3({ size: 5000 }) }))).toBeNull()
    })

    it('rejects a body above 6400 bytes per character plus 48000', () => {
      const text = 'x'.repeat(10) // 64000 + 48000 = 112000
      expect(validateClip(ok({ text, bytes: mp3({ size: 112_000 }) }))).toBeNull()
      expect(validateClip(ok({ text, bytes: mp3({ size: 112_001 }) }))).toMatch(/long/)
    })
  })
})
