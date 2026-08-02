import type { Phrase, PhraseId } from './phrase'

export type DeckId = string

/**
 * A named collection of Phrases for one context. The aggregate root, the unit
 * of persistence. Keeps author order: nothing here reorders it at random —
 * that (Shuffle) is a property of a Drill, never of a Deck. Manual reorder is
 * different: it is the author deliberately re-stating that order, so
 * `reorderPhrase` below is what "author order" is made of.
 */
export interface Deck {
  readonly id: DeckId
  readonly name: string
  readonly phrases: readonly Phrase[]
}

/** A new, empty Deck. The id is supplied by the caller — the domain has no I/O. */
export function createDeck(id: DeckId, name: string): Deck {
  return { id, name, phrases: [] }
}

/** A Deck with a new name; Phrases and id unchanged. */
export function renameDeck(deck: Deck, name: string): Deck {
  return { ...deck, name }
}

/** A Deck with the Phrase appended at the end, preserving author order. */
export function addPhrase(deck: Deck, phrase: Phrase): Deck {
  return { ...deck, phrases: [...deck.phrases, phrase] }
}

/** A Deck with the matching Phrase's text replaced. No-op if the id is not found. */
export function updatePhrase(
  deck: Deck,
  phraseId: PhraseId,
  fields: { french: string; english: string },
): Deck {
  return {
    ...deck,
    phrases: deck.phrases.map((phrase) =>
      phrase.id === phraseId ? { ...phrase, ...fields } : phrase,
    ),
  }
}

/** A Deck with the matching Phrase removed. No-op if the id is not found. */
export function removePhrase(deck: Deck, phraseId: PhraseId): Deck {
  return { ...deck, phrases: deck.phrases.filter((phrase) => phrase.id !== phraseId) }
}

/**
 * A Deck with the Phrase at `fromIndex` moved to `toIndex`, the rest shifted
 * to keep contiguous author order. The touch-native move-up/move-down
 * controls in Deck detail are the only callers; there is no drag gesture in
 * the domain, only this pure reindex.
 */
export function reorderPhrase(deck: Deck, fromIndex: number, toIndex: number): Deck {
  const phrases = [...deck.phrases]
  const [moved] = phrases.splice(fromIndex, 1)
  phrases.splice(toIndex, 0, moved)
  return { ...deck, phrases }
}
