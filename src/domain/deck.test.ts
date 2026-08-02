import { describe, expect, it } from 'vitest'
import {
  addPhrase,
  createDeck,
  removePhrase,
  renameDeck,
  reorderPhrase,
  updatePhrase,
} from './deck'
import type { Phrase } from './phrase'

function phrase(id: string, french: string, english: string): Phrase {
  return { id, french, english }
}

describe('createDeck', () => {
  it('creates a Deck with the given id and name and no Phrases', () => {
    const deck = createDeck('d1', 'Climbing')
    expect(deck).toEqual({ id: 'd1', name: 'Climbing', phrases: [] })
  })
})

describe('renameDeck', () => {
  it('returns a Deck with the new name, phrases and id unchanged', () => {
    const original = createDeck('d1', 'Climbing')
    const renamed = renameDeck(original, 'Bouldering')
    expect(renamed).toEqual({ id: 'd1', name: 'Bouldering', phrases: [] })
  })

  it('does not mutate the original Deck', () => {
    const original = createDeck('d1', 'Climbing')
    renameDeck(original, 'Bouldering')
    expect(original.name).toBe('Climbing')
  })
})

describe('addPhrase', () => {
  it('appends the Phrase to the end, keeping author order', () => {
    const deck = addPhrase(createDeck('d1', 'Home'), phrase('p1', 'Bonjour', 'Hello'))
    const withSecond = addPhrase(deck, phrase('p2', 'Merci', 'Thanks'))
    expect(withSecond.phrases.map((p) => p.id)).toEqual(['p1', 'p2'])
  })

  it('does not mutate the original Deck', () => {
    const deck = createDeck('d1', 'Home')
    addPhrase(deck, phrase('p1', 'Bonjour', 'Hello'))
    expect(deck.phrases).toEqual([])
  })
})

describe('updatePhrase', () => {
  it('replaces the french/english text of the matching Phrase only', () => {
    const deck = addPhrase(
      addPhrase(createDeck('d1', 'Home'), phrase('p1', 'Bonjour', 'Hello')),
      phrase('p2', 'Merci', 'Thanks'),
    )
    const updated = updatePhrase(deck, 'p1', { french: 'Salut', english: 'Hi' })
    expect(updated.phrases).toEqual([
      { id: 'p1', french: 'Salut', english: 'Hi' },
      { id: 'p2', french: 'Merci', english: 'Thanks' },
    ])
  })

  it('leaves the Deck unchanged when no Phrase matches the id', () => {
    const deck = addPhrase(createDeck('d1', 'Home'), phrase('p1', 'Bonjour', 'Hello'))
    const updated = updatePhrase(deck, 'nope', { french: 'Salut', english: 'Hi' })
    expect(updated.phrases).toEqual(deck.phrases)
  })
})

describe('removePhrase', () => {
  it('removes the matching Phrase, keeping the rest in order', () => {
    const deck = addPhrase(
      addPhrase(createDeck('d1', 'Home'), phrase('p1', 'Bonjour', 'Hello')),
      phrase('p2', 'Merci', 'Thanks'),
    )
    const result = removePhrase(deck, 'p1')
    expect(result.phrases.map((p) => p.id)).toEqual(['p2'])
  })

  it('is a no-op when no Phrase matches the id', () => {
    const deck = addPhrase(createDeck('d1', 'Home'), phrase('p1', 'Bonjour', 'Hello'))
    const result = removePhrase(deck, 'nope')
    expect(result.phrases).toEqual(deck.phrases)
  })
})

describe('reorderPhrase', () => {
  function threePhraseDeck() {
    return addPhrase(
      addPhrase(
        addPhrase(createDeck('d1', 'Home'), phrase('p1', 'a', 'a')),
        phrase('p2', 'b', 'b'),
      ),
      phrase('p3', 'c', 'c'),
    )
  }

  it('moves a Phrase forward in the order', () => {
    const result = reorderPhrase(threePhraseDeck(), 0, 2)
    expect(result.phrases.map((p) => p.id)).toEqual(['p2', 'p3', 'p1'])
  })

  it('moves a Phrase backward in the order', () => {
    const result = reorderPhrase(threePhraseDeck(), 2, 0)
    expect(result.phrases.map((p) => p.id)).toEqual(['p3', 'p1', 'p2'])
  })

  it('is a no-op when the target index equals the source index', () => {
    const deck = threePhraseDeck()
    const result = reorderPhrase(deck, 1, 1)
    expect(result.phrases.map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
  })

  it('does not mutate the original Deck', () => {
    const deck = threePhraseDeck()
    reorderPhrase(deck, 0, 2)
    expect(deck.phrases.map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
  })
})
