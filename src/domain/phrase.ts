export type PhraseId = string

/** One French/English pair. The unit of learning. Entity local to its Deck. */
export interface Phrase {
  readonly id: PhraseId
  readonly french: string
  readonly english: string
}
