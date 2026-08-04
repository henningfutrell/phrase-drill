import { describe, expect, it } from 'vitest'
import { createMix, renameMix, resolveMixDecks, resolveMixPhrases, setMixDecks } from './mix'
import type { Deck } from './deck'

function deck(id: string, name: string, phrases: Deck['phrases']): Deck {
  return { id, name, phrases }
}

const home = deck('d1', 'home', [
  { id: 'p1', french: 'Bonjour', english: 'Hello' },
  { id: 'p2', french: 'Merci', english: 'Thank you' },
])
const work = deck('d2', 'work', [{ id: 'p3', french: 'Réunion', english: 'Meeting' }])

describe('createMix', () => {
  it('names a Mix and the Decks it draws from, by id', () => {
    expect(createMix('m1', 'Mornings', ['d1', 'd2'])).toEqual({
      id: 'm1',
      name: 'Mornings',
      deckIds: ['d1', 'd2'],
    })
  })

  it('holds Deck ids only — never a copy of their Phrases, so an edited Deck changes every Mix that names it', () => {
    const mix = createMix('m1', 'Mornings', [home.id])
    expect(Object.keys(mix).sort()).toEqual(['deckIds', 'id', 'name'])
  })
})

describe('renameMix', () => {
  it('replaces the name, leaving id and Decks alone', () => {
    const mix = createMix('m1', 'Mornings', ['d1', 'd2'])
    expect(renameMix(mix, 'Evenings')).toEqual({ id: 'm1', name: 'Evenings', deckIds: ['d1', 'd2'] })
  })

  it('leaves the original Mix untouched', () => {
    const mix = createMix('m1', 'Mornings', ['d1'])
    renameMix(mix, 'Evenings')
    expect(mix.name).toBe('Mornings')
  })
})

describe('setMixDecks', () => {
  it('replaces the Deck selection wholesale, leaving id and name alone', () => {
    const mix = createMix('m1', 'Mornings', ['d1'])
    expect(setMixDecks(mix, ['d2', 'd3'])).toEqual({
      id: 'm1',
      name: 'Mornings',
      deckIds: ['d2', 'd3'],
    })
  })

  it('leaves the original Mix untouched', () => {
    const mix = createMix('m1', 'Mornings', ['d1'])
    setMixDecks(mix, ['d2'])
    expect(mix.deckIds).toEqual(['d1'])
  })
})

describe('resolveMixDecks', () => {
  it('resolves ids to Decks in the Mix own order, not the library order', () => {
    const mix = createMix('m1', 'Mornings', ['d2', 'd1'])
    expect(resolveMixDecks(mix, [home, work]).map((d) => d.id)).toEqual(['d2', 'd1'])
  })

  it('skips an id whose Deck was deleted, and keeps the rest — a deleted Deck never corrupts a Mix', () => {
    const mix = createMix('m1', 'Mornings', ['d1', 'gone', 'd2'])
    expect(resolveMixDecks(mix, [home, work]).map((d) => d.id)).toEqual(['d1', 'd2'])
  })

  it('resolves to nothing when every Deck it named is gone', () => {
    const mix = createMix('m1', 'Mornings', ['gone', 'also-gone'])
    expect(resolveMixDecks(mix, [home, work])).toEqual([])
  })

  it('keeps the dead id on the Mix, so a restored Deck rejoins it', () => {
    const mix = createMix('m1', 'Mornings', ['d1', 'd2'])
    resolveMixDecks(mix, [home])
    expect(mix.deckIds).toEqual(['d1', 'd2'])
    expect(resolveMixDecks(mix, [home, work]).map((d) => d.id)).toEqual(['d1', 'd2'])
  })
})

describe('resolveMixPhrases', () => {
  it('pools the Phrases of its Decks, in Mix order then author order', () => {
    const mix = createMix('m1', 'Mornings', ['d1', 'd2'])
    expect(resolveMixPhrases(mix, [home, work]).map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
  })

  it('pools only the Decks that still exist', () => {
    const mix = createMix('m1', 'Mornings', ['gone', 'd2'])
    expect(resolveMixPhrases(mix, [home, work]).map((p) => p.id)).toEqual(['p3'])
  })

  it('produces an empty pool when no named Deck exists', () => {
    expect(resolveMixPhrases(createMix('m1', 'Mornings', ['gone']), [home])).toEqual([])
  })

  it('leaves the source Decks untouched', () => {
    resolveMixPhrases(createMix('m1', 'Mornings', ['d1']), [home])
    expect(home.phrases).toHaveLength(2)
  })
})
