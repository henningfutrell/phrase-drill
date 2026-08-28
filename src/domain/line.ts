import type { Passage } from './passage'

export type LineId = string

/**
 * One sentence-sized piece of a Passage: the unit of audio and of progress
 * inside a Passage's Drill.
 *
 * Derived, never persisted and never authored — `splitPassageIntoLines` is the
 * only way one comes into existence, so editing a Passage's text re-derives
 * every Line rather than leaving stale pieces behind. Its id is therefore
 * positional (`<passage id>#<index>`) and only meaningful against the text it
 * was derived from.
 *
 * Named Line, not Segment, because the UI already calls the thing being spoken
 * a line (`.drill-current-line`, `data-testid="drill-current-line"`) — one
 * word survives the whole way from the splitter to the screen.
 */
export interface Line {
  readonly id: LineId
  readonly text: string
}

/**
 * The hard ceiling on one Line's length, and the reason Lines exist at all.
 * `server/app.js` caps one text-to-speech request at TTS_MAX_TEXT_CHARS = 2000
 * characters and TTS_MAX_BODY_BYTES = 8000 bytes, so pages of text cannot be
 * one Clip: a Passage has to be broken into Clip-sized pieces before any audio
 * exists. 300 sits well inside both caps, keeps one Clip near one breath-group
 * so a mid-Line cut never lands mid-phrase, and bounds the Line pause at 19.5s
 * (see PASSAGE_PAUSE_MAX_MS in cadence.ts, which cadence.test.ts pins against
 * this constant).
 */
export const LINE_MAX_CHARS = 300

const SENTENCE_TERMINATORS = '.!?…'

/**
 * The Lines of a Passage, in reading order. Pure derivation — same text, same
 * Lines, every time.
 *
 * Ids run `<passage id>#0`, `#1`, … over the *final* list, so a Line's index
 * is its position in what the user will actually hear, cap-splits included.
 */
export function splitPassageIntoLines(passage: Passage): readonly Line[] {
  return splitOnBoundaries(passage.text)
    .map((piece) => piece.trim())
    .flatMap(capToLineLength)
    .map((part) => part.trim())
    .filter((text) => text.length > 0)
    .map((text, index) => ({ id: `${passage.id}#${index}`, text }))
}

/**
 * Cuts the text at every sentence boundary and every newline. A sentence
 * terminator counts only when whitespace follows it — that is what keeps "3.5"
 * whole — and it stays with the piece it ends; a newline belongs to no piece.
 *
 * Both boundaries are detected from the character *before* the cursor, which
 * is why the scan starts at 1: a boundary at index 0 could only ever close an
 * empty piece, and the caller drops those. End-of-text needs no case of its
 * own either — whatever follows the last boundary is pushed as the final
 * piece, so `Bonjour.` ends its Line because it *is* the last piece. An
 * explicit end-of-text branch would be a branch no test could distinguish.
 */
function splitOnBoundaries(text: string): string[] {
  const pieces: string[] = []
  let start = 0
  for (let i = 1; i < text.length; i += 1) {
    const character = text[i]
    if (character === '\n') {
      pieces.push(text.slice(start, i))
      start = i + 1
    } else if (
      character.trim().length === 0 &&
      SENTENCE_TERMINATORS.includes(text[i - 1])
    ) {
      pieces.push(text.slice(start, i))
      start = i
    }
  }
  pieces.push(text.slice(start))
  return pieces
}

/**
 * One piece, cut down to parts of at most LINE_MAX_CHARS characters. A cut
 * lands on the last whitespace at or before the cap so a part ends at a word
 * break; a window holding no whitespace at all (a pasted URL, say) is cut
 * exactly at the cap. Called with an already-trimmed piece, so the whitespace
 * a sentence split left in front of it never counts against the cap.
 *
 * A single forward scan rather than the obvious `while (rest.length > cap)`
 * over a shrinking remainder: `i` advances unconditionally, so termination
 * does not depend on every cut consuming at least one character. Both give
 * the same parts, but only this one cannot be turned into an unbounded loop
 * — which matters because the mutation gate (npm run test:mutation) breaks
 * this function on purpose, and "the tests time out" is a far worse signal
 * than "the tests fail".
 */
function capToLineLength(piece: string): string[] {
  const parts: string[] = []
  let start = 0
  let lastBreak = 0
  for (let i = 0; i < piece.length; i += 1) {
    if (piece[i].trim().length === 0) lastBreak = i
    // Characters start..i inclusive overflow the cap at exactly this point.
    if (i - start >= LINE_MAX_CHARS) {
      // lastBreak <= start means the only break in this window is the one the
      // previous cut already landed on: no break point of its own, take the
      // hard cap. It also keeps every cut strictly ahead of `start`.
      const at = lastBreak > start ? lastBreak : start + LINE_MAX_CHARS
      parts.push(piece.slice(start, at))
      start = at
    }
  }
  parts.push(piece.slice(start))
  return parts
}
