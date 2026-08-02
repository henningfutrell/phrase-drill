import type { Deck } from '../../domain'
import type { DeckRecord, PhraseRecordV1 } from './migrations'

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
