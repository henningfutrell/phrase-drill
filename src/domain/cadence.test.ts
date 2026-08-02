import { describe, expect, it } from 'vitest'
import {
  PAUSE_MAX_MS,
  PAUSE_MIN_MS,
  PAUSE_MS_PER_CHARACTER,
  buildCadence,
  estimatePauseDuration,
} from './cadence'
import type { Phrase } from './phrase'

describe('estimatePauseDuration', () => {
  it('scales with the length of the French text', () => {
    const text = 'x'.repeat(40) // 40 * 65ms = 2600ms, inside the clamp range
    expect(estimatePauseDuration(text)).toBe(40 * PAUSE_MS_PER_CHARACTER)
  })

  it('clamps very short text up to the minimum pause', () => {
    expect(estimatePauseDuration('Oui')).toBe(PAUSE_MIN_MS)
  })

  it('clamps very long text down to the maximum pause', () => {
    const text = 'x'.repeat(200)
    expect(estimatePauseDuration(text)).toBe(PAUSE_MAX_MS)
  })

  it('treats empty text as the minimum pause', () => {
    expect(estimatePauseDuration('')).toBe(PAUSE_MIN_MS)
  })
})

describe('buildCadence', () => {
  const phrase: Phrase = { id: 'p1', french: 'Bonjour', english: 'Hello' }

  it('produces FR, pause, FR, pause, EN, pause, FR, pause in that exact order', () => {
    const steps = buildCadence(phrase)

    expect(steps).toEqual([
      { kind: 'utterance', text: 'Bonjour', lang: 'fr-FR' },
      { kind: 'pause', ms: estimatePauseDuration('Bonjour') },
      { kind: 'utterance', text: 'Bonjour', lang: 'fr-FR' },
      { kind: 'pause', ms: estimatePauseDuration('Bonjour') },
      { kind: 'utterance', text: 'Hello', lang: 'en-US' },
      { kind: 'pause', ms: estimatePauseDuration('Bonjour') },
      { kind: 'utterance', text: 'Bonjour', lang: 'fr-FR' },
      { kind: 'pause', ms: estimatePauseDuration('Bonjour') },
    ])
  })

  it('sizes every pause off the French text, even the one following English', () => {
    const longFrench: Phrase = {
      id: 'p2',
      french: 'x'.repeat(60),
      english: 'hi',
    }

    const steps = buildCadence(longFrench)
    const pauses = steps.filter((step) => step.kind === 'pause')

    expect(pauses).toHaveLength(4)
    for (const pause of pauses) {
      expect(pause.ms).toBe(estimatePauseDuration(longFrench.french))
    }
  })

  it('is pure data — calling it twice for the same phrase produces equal, independent arrays', () => {
    const a = buildCadence(phrase)
    const b = buildCadence(phrase)

    expect(a).toEqual(b)
    expect(a).not.toBe(b)
  })
})
