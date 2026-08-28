import type { Language } from './ports'

/**
 * One text in one language: exactly what one Clip is the audio of. A Phrase
 * has two Statements (its French and its English), a Line has one.
 *
 * This is the unit the audio layer counts. Before Passages it counted halves
 * of a Phrase — always two, always FR then EN — which is a shape a
 * single-language Line cannot take. Naming the piece instead of the pair lets
 * one readiness rule ("every Statement has a cached Clip") serve a Deck, a
 * Mix and a Passage without a second code path.
 */
export interface Statement {
  readonly text: string
  readonly lang: Language
}
