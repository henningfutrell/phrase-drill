import type { Language } from './ports'
import type { Line } from './line'
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
 * Pause-duration domain constants. The pause is the pedagogy: it is when the user
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

/**
 * A Line's pause has a ceiling of its own. PAUSE_MAX_MS (5s) is sized for a
 * memorised Phrase of a few words; a Line runs to LINE_MAX_CHARS characters
 * and saying one back takes far longer, so clamping a Line at 5s would cut them
 * off mid-sentence — the one thing the pause exists to prevent. 20s clears a
 * full-length Line at PAUSE_MS_PER_CHARACTER (300 * 65 = 19.5s); the two
 * constants are chosen together and cadence.test.ts pins the relation.
 */
export const PASSAGE_PAUSE_MAX_MS = 20000

/** Estimated spoken duration of one Line, clamped to the Line pause range. */
export function estimateLinePause(text: string): number {
  const estimate = text.length * PAUSE_MS_PER_CHARACTER
  return Math.min(PASSAGE_PAUSE_MAX_MS, Math.max(PAUSE_MIN_MS, estimate))
}

/**
 * The playback pattern for one Line: read it once, then hold silence long
 * enough for them to say it back. Not the Phrase Cadence's three readings — a
 * Phrase is short and drilled until it is memorised, a page is read.
 */
export function buildLineCadence(line: Line): readonly Step[] {
  return [
    utterance(line.text, 'fr-FR'),
    { kind: 'pause', ms: estimateLinePause(line.text) },
  ]
}