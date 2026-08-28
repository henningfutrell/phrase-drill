import { buildCadence, buildLineCadence, type Step } from './cadence'
import type { Line } from './line'
import type { Phrase } from './phrase'
import type { Statement } from './statement'

/**
 * One thing played through its full Cadence, start to finish: the unit of
 * progress inside a Drill, and the only unit a DrillPlayer knows about.
 *
 * A Rep is what a Phrase and a Line have in common — an id, the Statements
 * that must have Clips before it can play, and the Steps to play them in. That
 * is deliberately the whole interface: the Drill, the clip cache and the
 * generation queue all work in Reps, so a Passage needed no second player, no
 * second readiness rule and no second queue.
 */
export interface Rep {
  readonly id: string
  readonly statements: readonly Statement[]
  readonly cadence: readonly Step[]
}

/** The Rep for one Phrase: its two Statements, French first, and its Cadence. */
export function buildPhraseRep(phrase: Phrase): Rep {
  return {
    id: phrase.id,
    statements: [
      { text: phrase.french, lang: 'fr-FR' },
      { text: phrase.english, lang: 'en-US' },
    ],
    cadence: buildCadence(phrase),
  }
}

/** The Rep for one Line: a single French Statement, and the Line Cadence. */
export function buildLineRep(line: Line): Rep {
  return {
    id: line.id,
    statements: [{ text: line.text, lang: 'fr-FR' }],
    cadence: buildLineCadence(line),
  }
}
