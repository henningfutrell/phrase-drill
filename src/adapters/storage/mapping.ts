import type { Deck, Mix, Passage } from '../../domain'
import type { DeckRecord, MixRecord, PassageRecord, PhraseRecordV1 } from './migrations'

/** Domain Deck -> its on-disk record, attaching the timestamps the domain has no use for. */
export function toRecord(deck: Deck, timestamps: { createdAt: number; updatedAt: number }): DeckRecord {
  return {
    id: deck.id,
    name: deck.name,
    phrases: deck.phrases.map(
      (phrase): PhraseRecordV1 => ({
        id: phrase.id,
        french: phrase.french,
        english: phrase.english,
      }),
    ),
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  }
}

/** Domain Mix -> its on-disk record, attaching the same timestamps a Deck record carries. */
export function toMixRecord(mix: Mix, timestamps: { createdAt: number; updatedAt: number }): MixRecord {
  return {
    id: mix.id,
    name: mix.name,
    deckIds: [...mix.deckIds],
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  }
}

/**
 * Domain Passage -> its on-disk record, attaching the same timestamps a Deck
 * record carries. Its Lines are not written: they are derived from `text` on
 * read (`splitPassageIntoLines`), so storing them would be storing a cache
 * that could disagree with the text the user typed.
 */
export function toPassageRecord(
  passage: Passage,
  timestamps: { createdAt: number; updatedAt: number },
): PassageRecord {
  return {
    id: passage.id,
    name: passage.name,
    text: passage.text,
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  }
}

/** On-disk record -> domain Passage, dropping the timestamps the domain doesn't model. */
export function fromPassageRecord(record: PassageRecord): Passage {
  return { id: record.id, name: record.name, text: record.text }
}

/** On-disk record -> domain Mix, dropping the timestamps the domain doesn't model. */
export function fromMixRecord(record: MixRecord): Mix {
  return { id: record.id, name: record.name, deckIds: [...record.deckIds] }
}

/** On-disk record -> domain Deck, dropping the timestamps the domain doesn't model. */
export function fromRecord(record: DeckRecord): Deck {
  return {
    id: record.id,
    name: record.name,
    phrases: record.phrases.map((phrase) => ({
      id: phrase.id,
      french: phrase.french,
      english: phrase.english,
    })),
  }
}
