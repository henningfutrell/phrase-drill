import type { Deck, Mix } from '../../domain'
import type { DeckRecord, MixRecord, PhraseRecordV1 } from './migrations'

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
