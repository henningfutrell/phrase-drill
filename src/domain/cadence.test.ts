import { describe, expect, it } from 'vitest'
import {
  PASSAGE_PAUSE_MAX_MS,
  PAUSE_MAX_MS,
  PAUSE_MIN_MS,
  PAUSE_MS_PER_CHARACTER,
  buildCadence,
  buildLineCadence,
  estimateLinePause,
  estimatePauseDuration,
} from './cadence'
import { LINE_MAX_CHARS, type Line } from './line'
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

describe('the Line pause constants', () => {
  /**
   * LINE_MAX_CHARS and PASSAGE_PAUSE_MAX_MS are chosen together, in two
   * different modules, and nothing else connects them. A pause shorter than
   * the Line takes to say defeats the only thing a pause is for: it cuts them
   * off mid-sentence and the next reading starts over the top of them. So an
   * edit to either constant has to go red here rather than quietly ship a
   * ceiling a full-length Line does not fit under.
   */
  it('leaves room to say back a Line of the maximum length', () => {
    expect(LINE_MAX_CHARS * PAUSE_MS_PER_CHARACTER).toBeLessThanOrEqual(
      PASSAGE_PAUSE_MAX_MS,
    )
  })
})

describe('estimateLinePause', () => {
  it('scales with the length of the Line', () => {
    // 100 * 65ms = 6500ms: past the Phrase ceiling, inside the Line range.
    const text = 'x'.repeat(100)
    expect(estimateLinePause(text)).toBe(100 * PAUSE_MS_PER_CHARACTER)
  })

  it('clamps a very short Line up to the shared minimum pause', () => {
    expect(estimateLinePause('Oui')).toBe(PAUSE_MIN_MS)
  })

  it('treats empty text as the minimum pause', () => {
    expect(estimateLinePause('')).toBe(PAUSE_MIN_MS)
  })

  it('clamps down to PASSAGE_PAUSE_MAX_MS, not to the Phrase ceiling', () => {
    expect(estimateLinePause('x'.repeat(LINE_MAX_CHARS * 2))).toBe(
      PASSAGE_PAUSE_MAX_MS,
    )
  })

  it('gives a full-length Line a longer pause than any Phrase can get — which is why the second ceiling exists', () => {
    const pause = estimateLinePause('x'.repeat(LINE_MAX_CHARS))

    expect(pause).toBe(LINE_MAX_CHARS * PAUSE_MS_PER_CHARACTER)
    expect(pause).toBeGreaterThan(PAUSE_MAX_MS)
  })
})

describe('buildLineCadence', () => {
  const text =
    'Il me faut du temps pour lire cette phrase à voix haute, parce qu’elle ne tient pas en une seule respiration.'
  const line: Line = { id: 'pg1#0', text }

  /**
   * Fixture guard, not a behaviour. A short Line clamps to PAUSE_MIN_MS under
   * either ceiling, so the assertions below would stop being able to tell
   * which pause they got — and a Line reading back under the Phrase ceiling
   * is exactly the regression PASSAGE_PAUSE_MAX_MS exists to prevent.
   */
  it('is long enough that the Phrase ceiling and the Line ceiling disagree', () => {
    expect(estimatePauseDuration(text)).toBe(PAUSE_MAX_MS)
    expect(estimateLinePause(text)).toBeGreaterThan(PAUSE_MAX_MS)
  })

  it('reads the Line once in French, then holds silence long enough to say it back', () => {
    expect(buildLineCadence(line)).toEqual([
      { kind: 'utterance', text, lang: 'fr-FR' },
      { kind: 'pause', ms: estimateLinePause(text) },
    ])
  })

  it('alternates kinds — DrillScreen reconstructs the beat from no two adjacent Steps sharing one', () => {
    expect(buildLineCadence(line).map((step) => step.kind)).toEqual([
      'utterance',
      'pause',
    ])
  })

  it('is pure data — calling it twice for the same Line produces equal, independent arrays', () => {
    const a = buildLineCadence(line)
    const b = buildLineCadence(line)

    expect(a).toEqual(b)
    expect(a).not.toBe(b)
  })
})
