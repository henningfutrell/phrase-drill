import { useState } from 'react'
import type { Deck, DeckId } from '../domain'
import { NameSheet } from './NameSheet'

type SheetState = { kind: 'create' } | { kind: 'rename'; deckId: DeckId; name: string } | undefined

/**
 * Decks — contexts, pick, create/rename/delete (docs/design.md §3.2).
 * Purely presentational: every persistence decision is the composition
 * root's (App.tsx), reached only through callback props.
 */
export function DecksScreen({
  decks,
  onCreateDeck,
  onRenameDeck,
  onDeleteDeck,
  onOpenDeck,
}: {
  decks: readonly Deck[]
  onCreateDeck: (name: string) => void
  onRenameDeck: (id: DeckId, name: string) => void
  onDeleteDeck: (id: DeckId) => void
  onOpenDeck: (id: DeckId) => void
}) {
  const [sheet, setSheet] = useState<SheetState>(undefined)
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<DeckId | undefined>(undefined)

  return (
    <main className="screen">
      <header className="screen-header">
        <h1>Decks</h1>
        <button
          type="button"
          data-testid="new-deck"
          className="link-action"
          onClick={() => setSheet({ kind: 'create' })}
        >
          + New Deck
        </button>
      </header>

      {decks.length === 0 ? (
        <p className="empty-state">
          Nothing here yet — start a Deck for one of your contexts.
        </p>
      ) : (
        <ul className="deck-list">
          {decks.map((deck) => (
            <li key={deck.id} className="deck-chip">
              <button
                type="button"
                data-testid={`deck-row-${deck.id}`}
                className="deck-chip-main"
                onClick={() => onOpenDeck(deck.id)}
              >
                <span className="deck-chip-name">{deck.name}</span>
                <span className="deck-chip-count">
                  {deck.phrases.length === 0
                    ? 'Add phrases to drill this Deck'
                    : `${deck.phrases.length} phrases`}
                </span>
              </button>
              <div className="deck-chip-actions">
                <button
                  type="button"
                  data-testid={`rename-deck-${deck.id}`}
                  className="btn-icon"
                  onClick={() => setSheet({ kind: 'rename', deckId: deck.id, name: deck.name })}
                >
                  Rename
                </button>
                {confirmingDeleteId === deck.id ? (
                  <button
                    type="button"
                    data-testid={`confirm-delete-deck-${deck.id}`}
                    className="btn-icon btn-danger"
                    onClick={() => {
                      onDeleteDeck(deck.id)
                      setConfirmingDeleteId(undefined)
                    }}
                  >
                    Confirm delete
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid={`delete-deck-${deck.id}`}
                    className="btn-icon btn-danger"
                    onClick={() => setConfirmingDeleteId(deck.id)}
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {sheet?.kind === 'create' && (
        <NameSheet
          title="New Deck"
          onCancel={() => setSheet(undefined)}
          onSave={(name) => {
            onCreateDeck(name)
            setSheet(undefined)
          }}
        />
      )}
      {sheet?.kind === 'rename' && (
        <NameSheet
          title="Rename Deck"
          initialValue={sheet.name}
          onCancel={() => setSheet(undefined)}
          onSave={(name) => {
            onRenameDeck(sheet.deckId, name)
            setSheet(undefined)
          }}
        />
      )}
    </main>
  )
}
