import { useState } from 'react'

/**
 * The one shared bottom-sheet shape for a single free-text field: New Deck,
 * Rename Deck, Rename Deck (from detail). Shared because add and edit already
 * share one sheet shape for Phrases (§2 of docs/design.md) — the same reasoning
 * applies to every single-field name edit in this screen set.
 */
export function NameSheet({
  title,
  initialValue = '',
  onSave,
  onCancel,
}: {
  title: string
  initialValue?: string
  onSave: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initialValue)

  return (
    <div className="sheet" role="dialog" aria-label={title}>
      <div className="sheet-title">{title}</div>
      <input
        data-testid="deck-name-input"
        className="sheet-input"
        value={value}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
      />
      <div className="sheet-actions">
        <button type="button" className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          data-testid="deck-name-save"
          className="btn-primary"
          disabled={value.trim().length === 0}
          onClick={() => onSave(value.trim())}
        >
          Save
        </button>
      </div>
    </div>
  )
}
