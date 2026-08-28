import { useState } from 'react'
import '../styles/tokens.css'
import './PassageSheet.css'

export interface PassageSheetProps {
  /** "New long form" or "Edit long form" — the sheet is the same either way. */
  readonly title: string
  readonly initialName?: string
  readonly initialText?: string
  /** Both values already trimmed — see `handleSave`. */
  readonly onSave: (name: string, text: string) => void
  readonly onCancel: () => void
}

/**
 * Add and edit a Passage share this one sheet, the way Add and edit share one
 * sheet for a Phrase. It is deliberately not a copy of PhraseSheet: a Phrase is
 * two short lines and a Passage is a page, so the text field is a textarea and
 * the whole sheet is sized for the one thing in this app the user will paste rather
 * than type.
 *
 * There is no Passage detail screen behind it, and that is the point — a Deck
 * needs one because it holds many Phrases with per-Phrase controls, while a
 * Passage is one block of text this sheet already shows whole.
 */
export function PassageSheet({
  title,
  initialName = '',
  initialText = '',
  onSave,
  onCancel,
}: PassageSheetProps) {
  const [name, setName] = useState(initialName)
  const [text, setText] = useState(initialText)
  // Set by a refused Save and never cleared by hand: the message below is
  // derived from the current values, so filling the missing field in takes the
  // refusal away without a second tap to find out.
  const [refused, setRefused] = useState(false)

  const trimmedName = name.trim()
  const trimmedText = text.trim()

  /**
   * Why the Save the user just tapped did nothing, or nothing if it would work.
   * An entry with no text has no Lines, so there is nothing for a Drill to
   * play and nothing on the Long form screen to explain the empty row —
   * refusing here is the only place that can say so while the user is still
   * looking at the field.
   */
  const refusal = !refused
    ? undefined
    : trimmedName.length === 0
      ? 'It needs a name — that’s what you’ll see in the list.'
      : trimmedText.length === 0
        ? 'There’s nothing to read yet. Paste or type the text, then save.'
        : undefined

  function handleSave(): void {
    if (trimmedName.length === 0 || trimmedText.length === 0) {
      // Not a disabled button: a control that does nothing when tapped leaves
      // their guessing which field is at fault. It stays tappable and answers.
      setRefused(true)
      return
    }
    // The text is theirs and its paragraph breaks are structure — only the outer
    // whitespace goes, which is what a paste from Notes or a web page brings
    // with it. `splitPassageIntoLines` trims each Line itself, but the stored
    // text is what the user opens again to edit.
    onSave(trimmedName, trimmedText)
  }

  return (
    <div className="sheet passage-sheet" role="dialog" aria-label={title} data-testid="passage-sheet">
      <div className="sheet-title">{title}</div>

      <label className="sheet-label" htmlFor="passage-name">
        Name
      </label>
      {/*
        Autocapitalize, autocorrect and spellcheck are set on both fields on
        purpose rather than left to iOS's defaults. The user is typing French into a
        phone whose keyboard may well be set to English: autocorrect would
        rewrite French words against an English dictionary — silently, and this
        is a page of text the user will not re-read character by character — and the
        spell checker would underline every French word on the screen, which is
        noise with no signal in it. Sentence capitalisation stays on: it is
        correct for French prose and for the name of a piece.
      */}
      <input
        id="passage-name"
        data-testid="passage-sheet-name"
        className="sheet-input"
        value={name}
        autoFocus
        autoCapitalize="sentences"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => setName(e.target.value)}
      />

      <label className="sheet-label" htmlFor="passage-text">
        Text
      </label>
      <textarea
        id="passage-text"
        data-testid="passage-sheet-text"
        className="sheet-input passage-sheet-text"
        value={text}
        rows={10}
        autoCapitalize="sentences"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
      />

      {refusal && (
        <p className="passage-sheet-error" data-testid="passage-sheet-error">
          {refusal}
        </p>
      )}

      <div className="sheet-actions">
        <button
          type="button"
          data-testid="passage-sheet-cancel"
          className="btn-secondary"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="passage-sheet-save"
          className="btn-primary"
          onClick={handleSave}
        >
          Save
        </button>
      </div>
    </div>
  )
}
