import { describe, expect, it } from 'vitest'
import { buildRep } from './rep'
import { buildCadence } from './cadence'
import type { Phrase } from './phrase'

describe('buildRep', () => {
  it('pairs the Phrase with its full Cadence', () => {
    const phrase: Phrase = { id: 'p1', french: 'Bonjour', english: 'Hello' }

    const rep = buildRep(phrase)

    expect(rep.phrase).toBe(phrase)
    expect(rep.cadence).toEqual(buildCadence(phrase))
  })
})
