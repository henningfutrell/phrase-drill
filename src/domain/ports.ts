/**
 * The domain declares these ports; it never implements them. Adapters live
 * outside the domain and satisfy these interfaces with real I/O (Web Speech,
 * a timer). Tests inject fakes at these seams and nowhere else.
 */

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

/**
 * A French/English pair proposed from a Scan, before review. Never a Phrase —
 * it has no id and reaches storage only once a person confirms it.
 */
export interface DraftPhrase {
  readonly french: string
  readonly english: string
}

/**
 * Why a Scan could not be turned into Draft Phrases. An empty array from
 * `read` is not this — it is the honest result of a photo with no phrases on
 * it. This type exists only for genuine failure.
 */
export type ScanError =
  | { kind: 'unauthorized' }
  | { kind: 'unreadable'; detail: string }
  | { kind: 'network'; detail: string }

export interface ScanReader {
  /**
   * Read a Scan (one photo) and propose Draft Phrases from it. Resolves to
   * `[]` when the photo genuinely contains no phrases — that is a successful
   * read, not a failure. Rejects with a ScanError only when the read itself
   * could not be completed.
   */
  read(image: Blob, signal?: AbortSignal): Promise<DraftPhrase[]>
}
