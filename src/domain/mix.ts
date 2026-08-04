import type { Deck, DeckId } from './deck'
import type { Phrase } from './phrase'

export type MixId = string

/**
 * A named, saved selection of Decks (glossary), drilled as one run. An
 * entity: it has an id, a name, and the ids of its Decks — never a copy of
 * their Phrases, so editing a Deck changes every Mix that names it and
 * nothing has to be kept in step.
 *
 * It was ephemeral until T059; the owner asked to save, edit and delete
 * Mixes, and the glossary entry moved with the code.
 */
export interface Mix {
  readonly id: MixId
  readonly name: string
  readonly deckIds: readonly DeckId[]
}

/** A new Mix. The id is supplied by the caller — the domain has no I/O. */
export function createMix(id: MixId, name: string, deckIds: readonly DeckId[]): Mix {
  return { id, name, deckIds }
}

/** A Mix with a new name; id and Decks unchanged. */
export function renameMix(mix: Mix, name: string): Mix {
  return { ...mix, name }
}

/** A Mix with a new Deck selection; id and name unchanged. Wholesale, never a merge. */
export function setMixDecks(mix: Mix, deckIds: readonly DeckId[]): Mix {
  return { ...mix, deckIds }
}

/**
 * The Decks a Mix names, in the Mix's own order, skipping any whose Deck no
 * longer exists.
 *
 * Deliberate: a Deck deleted out from under a Mix is dropped at read time
 * and its id is *kept* on the Mix. Rewriting the Mix on Deck deletion would
 * be a second, silent write to her data at the moment she asked for a
 * different one, and it would stop a restored Deck rejoining the Mix it was
 * always part of. The dead id costs nothing and goes the next time she
 * edits the Mix herself.
 */
export function resolveMixDecks(mix: Mix, decks: readonly Deck[]): Deck[] {
  return mix.deckIds
    .map((id) => decks.find((deck) => deck.id === id))
    .filter((deck): deck is Deck => deck !== undefined)
}

/** The pool of Phrases a Mix drills: its Decks in Mix order, each in author order. */
export function resolveMixPhrases(mix: Mix, decks: readonly Deck[]): Phrase[] {
  return resolveMixDecks(mix, decks).flatMap((deck) => deck.phrases)
}
