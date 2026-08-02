import type { Language } from './ports'
import type { Phrase } from './phrase'

export interface Utterance {
  readonly kind: 'utterance'
  readonly text: string
  readonly lang: Language
}

export interface Pause {
  readonly kind: 'pause'
  readonly ms: number
}

/** One element of the Cadence: speak something, or hold silence. */
export type Step = Utterance | Pause

/**
 * Pause-duration domain constants. The pause is the pedagogy: it is when she
 * repeats the French phrase aloud, so it scales with how long the phrase
 * takes to say. Trivially adjustable — everything about the estimate lives
 * here, nowhere else.
 */
export const PAUSE_MS_PER_CHARACTER = 65
export const PAUSE_MIN_MS = 1500
export const PAUSE_MAX_MS = 5000

/** Estimated spoken duration of French text, clamped to a sane pause range. */
export function estimatePauseDuration(frenchText: string): number {
  const estimate = frenchText.length * PAUSE_MS_PER_CHARACTER
  return Math.min(PAUSE_MAX_MS, Math.max(PAUSE_MIN_MS, estimate))
}

function utterance(text: string, lang: Language): Utterance {
  return { kind: 'utterance', text, lang }
}

function pauseAfter(frenchText: string): Pause {
  return { kind: 'pause', ms: estimatePauseDuration(frenchText) }
}

/**
 * The fixed playback pattern for one Phrase: FR, pause, FR, pause, EN, pause,
 * FR, pause. Pure data — not behaviour. Every pause is sized off the French
 * text, including the one that follows the English utterance.
 */
export function buildCadence(phrase: Phrase): readonly Step[] {
  return [
    utterance(phrase.french, 'fr-FR'),
    pauseAfter(phrase.french),
    utterance(phrase.french, 'fr-FR'),
    pauseAfter(phrase.french),
    utterance(phrase.english, 'en-US'),
    pauseAfter(phrase.french),
    utterance(phrase.french, 'fr-FR'),
    pauseAfter(phrase.french),
  ]
}
