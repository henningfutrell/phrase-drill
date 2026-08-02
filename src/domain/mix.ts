import type { Deck } from './deck'
import type { Phrase } from './phrase'

/**
 * Several Decks combined into one pool of Phrases. Ephemeral — a value made
 * at Drill start, never persisted. The source Decks are untouched.
 */
export interface Mix {
  readonly phrases: readonly Phrase[]
}

export function createMix(decks: readonly Deck[]): Mix {
  return { phrases: decks.flatMap((deck) => deck.phrases) }
}
