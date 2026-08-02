import { describe, expect, it } from 'vitest'
import { createMix } from './mix'
import type { Deck } from './deck'

function deck(id: string, name: string, phrases: Deck['phrases']): Deck {
  return { id, name, phrases }
}

describe('createMix', () => {
  it('combines the phrases of several Decks into one pool, in Deck order then author order', () => {
    const home = deck('d1', 'home', [
      { id: 'p1', french: 'Bonjour', english: 'Hello' },
      { id: 'p2', french: 'Merci', english: 'Thank you' },
    ])
    const work = deck('d2', 'work', [
      { id: 'p3', french: 'Réunion', english: 'Meeting' },
    ])

    const mix = createMix([home, work])

    expect(mix.phrases.map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
  })

  it('produces an empty pool for no Decks', () => {
    expect(createMix([])).toEqual({ phrases: [] })
  })

  it('leaves the source Decks untouched', () => {
    const home = deck('d1', 'home', [
      { id: 'p1', french: 'Bonjour', english: 'Hello' },
    ])

    createMix([home])

    expect(home.phrases).toHaveLength(1)
  })
})
