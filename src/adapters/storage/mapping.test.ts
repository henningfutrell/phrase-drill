import { describe, expect, it } from 'vitest'
import type { Deck } from '../../domain'
import { fromRecord, toRecord } from './mapping'

describe('deck record mapping', () => {
  const deck: Deck = {
    id: 'd1',
    name: 'Home',
    phrases: [{ id: 'p1', french: 'Bonjour', english: 'Hello' }],
  }

  it('maps a deck to its record shape, attaching the given timestamps', () => {
    const record = toRecord(deck, { createdAt: 10, updatedAt: 20 })
    expect(record).toEqual({
      id: 'd1',
      name: 'Home',
      phrases: [{ id: 'p1', french: 'Bonjour', english: 'Hello' }],
      createdAt: 10,
      updatedAt: 20,
    })
  })

  it('maps a record back to a domain deck, dropping the timestamps', () => {
    const record = toRecord(deck, { createdAt: 10, updatedAt: 20 })
    expect(fromRecord(record)).toEqual(deck)
  })
})
