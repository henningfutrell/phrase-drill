/**
 * The domain declares these ports; it never implements them. Adapters live
 * outside the domain and satisfy these interfaces with real I/O (Web Speech,
 * a timer, IndexedDB). Tests inject fakes at these seams and nowhere else.
 */

import type { Deck, DeckId } from './deck'

/** Closed on purpose — widening it later is a type change, not a data migration. */
export type Language = 'fr-FR' | 'en-US'

export interface SpeechPort {
  /** Speak text aloud in the given language. Resolves when the utterance ends. */
  speak(text: string, lang: Language): Promise<void>
  /** Stop any current utterance immediately. Safe when idle. */
  cancel(): void
}

export interface ClockPort {
  /** Resolve after ms. Cancellable via the given AbortSignal. */
  wait(ms: number, signal?: AbortSignal): Promise<void>
}

/** The two halves of a Phrase, as they sit on disk — plain data, no I/O. */
export interface PhraseRecord {
  readonly id: string
  readonly french: string
  readonly english: string
}

/**
 * A Deck as it sits on disk: the domain shape plus the bookkeeping the
 * domain itself has no use for (when it was created/last touched). The
 * *current* schema version — an adapter's own historical shapes and
 * migrations between them are the adapter's concern, not the domain's.
 */
export interface DeckRecord {
  readonly id: string
  readonly name: string
  readonly phrases: readonly PhraseRecord[]
  readonly createdAt: number
  readonly updatedAt: number
}

export const LIBRARY_FORMAT = 'phrase-drill-library'

/**
 * A whole-library snapshot for export/import — also the recovery path for
 * iOS's IndexedDB eviction. Import replaces the whole library; it never
 * merges, because merge is a design problem nobody has asked to solve.
 */
export interface Library {
  readonly format: typeof LIBRARY_FORMAT
  readonly schemaVersion: number
  readonly exportedAt: number
  readonly decks: readonly DeckRecord[]
}

export interface DeckStore {
  loadAll(): Promise<Deck[]>
  get(id: DeckId): Promise<Deck | undefined>
  /** Whole-aggregate put: insert or replace. No transaction spans stores. */
  save(deck: Deck): Promise<void>
  remove(id: DeckId): Promise<void>
  /** Whole-library snapshot. Never carries anything from settings (the API key). */
  exportAll(): Promise<Library>
  /** Replaces the whole library. Never merges. */
  importAll(library: Library): Promise<void>
}
