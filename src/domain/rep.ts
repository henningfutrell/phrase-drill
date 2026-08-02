import { buildCadence, type Step } from './cadence'
import type { Phrase } from './phrase'

/** One Phrase played through the full Cadence, start to finish. */
export interface Rep {
  readonly phrase: Phrase
  readonly cadence: readonly Step[]
}

export function buildRep(phrase: Phrase): Rep {
  return { phrase, cadence: buildCadence(phrase) }
}
