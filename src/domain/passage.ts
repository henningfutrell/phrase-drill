export type PassageId = string

/**
 * One long-form French text the user reads aloud. The aggregate root and the unit
 * of persistence, beside a Deck. Their own words for it are "long form entry",
 * which is why the screen that lists them is labelled "Long form".
 *
 * Single-language on purpose: a Passage has no English half and is never
 * translated. The user is practising reading a page, not recalling a pair, so
 * there is nothing an English side would be the answer to.
 *
 * `text` is one field, not a collection: its Lines (src/domain/line.ts) are
 * derived from it and never stored, so rewriting the text re-derives every
 * Line and there is no per-Line state to keep in step. That is also what
 * makes last-writer-wins the whole merge rule for a Passage — see
 * `PassageStore` in ports.ts.
 */
export interface Passage {
  readonly id: PassageId
  readonly name: string
  readonly text: string
}

/** A new Passage. The id is supplied by the caller — the domain has no I/O. */
export function createPassage(
  id: PassageId,
  name: string,
  text: string,
): Passage {
  return { id, name, text }
}

/** A Passage with a new name; id and text unchanged. */
export function renamePassage(passage: Passage, name: string): Passage {
  return { ...passage, name }
}

/** A Passage with new text; id and name unchanged. Wholesale, never a merge. */
export function setPassageText(passage: Passage, text: string): Passage {
  return { ...passage, text }
}
