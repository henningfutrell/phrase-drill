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
