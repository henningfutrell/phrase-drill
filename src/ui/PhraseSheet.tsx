import { useState } from 'react'

/** Add and edit a Phrase share this one sheet shape — French, then English. */
export function PhraseSheet({
  initialFrench = '',
  initialEnglish = '',
  onSave,
  onCancel,
}: {
  initialFrench?: string
  initialEnglish?: string
  onSave: (french: string, english: string) => void
  onCancel: () => void
}) {
  const [french, setFrench] = useState(initialFrench)
  const [english, setEnglish] = useState(initialEnglish)
  const canSave = french.trim().length > 0 && english.trim().length > 0

  return (
    <div className="sheet" role="dialog" aria-label="Phrase">
      <label className="sheet-label" htmlFor="phrase-french">
        French
      </label>
      <input
        id="phrase-french"
        data-testid="phrase-french-input"
        className="sheet-input"
        value={french}
        autoFocus
        onChange={(e) => setFrench(e.target.value)}
      />
      <label className="sheet-label" htmlFor="phrase-english">
        English
      </label>
      <input
        id="phrase-english"
        data-testid="phrase-english-input"
        className="sheet-input"
        value={english}
        onChange={(e) => setEnglish(e.target.value)}
      />
      <div className="sheet-actions">
        <button type="button" className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          data-testid="phrase-save"
          className="btn-primary"
          disabled={!canSave}
          onClick={() => onSave(french.trim(), english.trim())}
        >
          Save
        </button>
      </div>
    </div>
  )
}
