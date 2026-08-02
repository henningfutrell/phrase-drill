import type { Phrase } from './phrase'

export type DeckId = string

/**
 * A named collection of Phrases for one context. The aggregate root, the unit
 * of persistence. Keeps author order — the Phrases are never reordered here;
 * reordering (Shuffle) is a property of a Drill, not of a Deck.
 */
export interface Deck {
  readonly id: DeckId
  readonly name: string
  readonly phrases: readonly Phrase[]
}
