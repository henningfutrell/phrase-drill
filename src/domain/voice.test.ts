import { describe, expect, it } from 'vitest'
import { isVoice } from './voice'

const VOICE = { provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-1' }

describe('isVoice', () => {
  it('accepts a Voice with all three parts of the content address', () => {
    expect(isVoice(VOICE)).toBe(true)
  })

  it('rejects a missing provider — the first third of the content address', () => {
    expect(isVoice({ modelId: 'm', voiceId: 'v' })).toBe(false)
  })

  it('rejects a non-string modelId', () => {
    expect(isVoice({ provider: 'elevenlabs', modelId: 7, voiceId: 'v' })).toBe(false)
  })

  it('rejects a non-string voiceId', () => {
    expect(isVoice({ provider: 'elevenlabs', modelId: 'm', voiceId: null })).toBe(false)
  })

  it('rejects null, which typeof calls an object', () => {
    expect(isVoice(null)).toBe(false)
  })

  it('rejects an array, which typeof also calls an object', () => {
    expect(isVoice([])).toBe(false)
  })

  it('rejects a plain string', () => {
    expect(isVoice('voice-1')).toBe(false)
  })
})
