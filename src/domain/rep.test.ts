import { describe, expect, it } from 'vitest'
import { buildLineRep, buildPhraseRep } from './rep'
import { buildCadence, buildLineCadence } from './cadence'
import type { Line } from './line'
import type { Phrase } from './phrase'

const phrase: Phrase = { id: 'p1', french: 'Bonjour', english: 'Hello' }
const line: Line = { id: 'pg1#0', text: 'Bonjour tout le monde.' }

describe('buildPhraseRep', () => {
  it('carries the Phrase id, its two Statements French-then-English, and the full Cadence', () => {
    expect(buildPhraseRep(phrase)).toEqual({
      id: 'p1',
      statements: [
        { text: 'Bonjour', lang: 'fr-FR' },
        { text: 'Hello', lang: 'en-US' },
      ],
      cadence: buildCadence(phrase),
    })
  })

  it('has exactly two Statements — the two Clips a Phrase needs before it can be drilled', () => {
    expect(buildPhraseRep(phrase).statements).toHaveLength(2)
  })
})

describe('buildLineRep', () => {
  it('carries the Line id, its single French Statement, and the Line Cadence', () => {
    expect(buildLineRep(line)).toEqual({
      id: 'pg1#0',
      statements: [{ text: 'Bonjour tout le monde.', lang: 'fr-FR' }],
      cadence: buildLineCadence(line),
    })
  })

  it('has exactly one Statement — a Passage is never translated, so a Line has no English half', () => {
    expect(buildLineRep(line).statements).toHaveLength(1)
  })
})
