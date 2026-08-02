import { describe, expect, it } from 'vitest'
import { FALLBACK_PREVIEW_PHRASE, VOICE_CATALOGUE } from './voice-catalogue'

describe('VOICE_CATALOGUE', () => {
  it('is not empty — the picker always has something to offer', () => {
    expect(VOICE_CATALOGUE.length).toBeGreaterThan(0)
  })

  it('gives every entry a provider, model, voice id, display name, and description', () => {
    for (const entry of VOICE_CATALOGUE) {
      expect(entry.provider).toBe('elevenlabs')
      expect(entry.modelId.length).toBeGreaterThan(0)
      expect(entry.voiceId.length).toBeGreaterThan(0)
      expect(entry.name.length).toBeGreaterThan(0)
      expect(entry.description.length).toBeGreaterThan(0)
    }
  })

  it('has no duplicate voice ids', () => {
    const ids = VOICE_CATALOGUE.map((entry) => entry.voiceId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('includes the three confirmed-working voices, unchanged', () => {
    const ids = VOICE_CATALOGUE.map((entry) => entry.voiceId)
    expect(ids).toEqual(
      expect.arrayContaining(['21m00Tcm4TlvDq8ikWAM', 'XB0fDUnXU5powFXDhCwa', 'JBFqnCBsd6RMkjVDRZzb']),
    )
  })

  it('pins every entry to the multilingual model confirmed to work with these voices', () => {
    for (const entry of VOICE_CATALOGUE) {
      expect(entry.modelId).toBe('eleven_multilingual_v2')
    }
  })

  it('is honest that none of these is a French-native voice', () => {
    for (const entry of VOICE_CATALOGUE) {
      expect(entry.description).not.toMatch(/native french|french native/i)
    }
  })
})

describe('FALLBACK_PREVIEW_PHRASE', () => {
  it('is a non-empty phrase to preview a voice with when the library is empty', () => {
    expect(FALLBACK_PREVIEW_PHRASE.trim().length).toBeGreaterThan(0)
  })
})
