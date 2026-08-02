import { useState } from 'react'
import type { Deck } from '../domain'
import type { PhraseId } from '../domain'
import { NameSheet } from './NameSheet'
import { PhraseSheet } from './PhraseSheet'

type PhraseSheetState = { kind: 'add' } | { kind: 'edit'; phraseId: PhraseId } | undefined

/**
 * Deck detail — the Phrases in one Deck (docs/design.md §3.3). Reorder is
 * touch-native move-up/move-down buttons, not a drag gesture — see T007
 * report for why. Purely presentational; every persist decision is App.tsx's.
 */
export function DeckDetailScreen({
  deck,
  onBack,
  onRenameDeck,
  onDeleteDeck,
  onAddPhrase,
  onUpdatePhrase,
  onDeletePhrase,
  onMovePhraseUp,
  onMovePhraseDown,
  onDrillDeck,
}: {
  deck: Deck
  onBack: () => void
  onRenameDeck: (name: string) => void
  onDeleteDeck: () => void
  onAddPhrase: (french: string, english: string) => void
  onUpdatePhrase: (id: PhraseId, fields: { french: string; english: string }) => void
  onDeletePhrase: (id: PhraseId) => void
  onMovePhraseUp: (id: PhraseId) => void
  onMovePhraseDown: (id: PhraseId) => void
  /** Launches a Drill over this whole Deck (docs/design.md §3.3, T006). */
  onDrillDeck: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [phraseSheet, setPhraseSheet] = useState<PhraseSheetState>(undefined)
  const [confirmingDeletePhraseId, setConfirmingDeletePhraseId] = useState<PhraseId | undefined>(
    undefined,
  )
  const [confirmingDeleteDeck, setConfirmingDeleteDeck] = useState(false)

  const editingPhrase =
    phraseSheet?.kind === 'edit' ? deck.phrases.find((p) => p.id === phraseSheet.phraseId) : undefined

  return (
    <main className="screen">
      <header className="screen-header">
        <button type="button" data-testid="back" className="btn-icon" onClick={onBack}>
          Back
        </button>
        <button type="button" data-testid="rename-deck" className="deck-title" onClick={() => setRenaming(true)}>
          {deck.name}
        </button>
        {confirmingDeleteDeck ? (
          <button
            type="button"
            data-testid="confirm-delete-deck"
            className="btn-icon btn-danger"
            onClick={onDeleteDeck}
          >
            Delete &quot;{deck.name}&quot; and its {deck.phrases.length} phrases?
          </button>
        ) : (
          <button
            type="button"
            data-testid="delete-deck"
            className="btn-icon btn-danger"
            onClick={() => setConfirmingDeleteDeck(true)}
          >
            Delete Deck
          </button>
        )}
      </header>

      <button
        type="button"
        data-testid="drill-deck"
        className="btn-primary"
        onClick={onDrillDeck}
      >
        Drill this Deck
      </button>

      {deck.phrases.length === 0 ? (
        <p className="empty-state">Add phrases to drill this Deck.</p>
      ) : (
        <ul className="phrase-list">
          {deck.phrases.map((phrase, index) => (
            <li key={phrase.id} data-testid={`phrase-row-${phrase.id}`} className="phrase-row">
              <div className="phrase-text">
                <div className="phrase-french">{phrase.french}</div>
                <div className="phrase-english">{phrase.english}</div>
              </div>
              <div className="phrase-reorder">
                <button
                  type="button"
                  data-testid={`move-up-${phrase.id}`}
                  className="btn-icon"
                  disabled={index === 0}
                  onClick={() => onMovePhraseUp(phrase.id)}
                >
                  Move up
                </button>
                <button
                  type="button"
                  data-testid={`move-down-${phrase.id}`}
                  className="btn-icon"
                  disabled={index === deck.phrases.length - 1}
                  onClick={() => onMovePhraseDown(phrase.id)}
                >
                  Move down
                </button>
              </div>
              <div className="phrase-actions">
                <button
                  type="button"
                  data-testid={`edit-phrase-${phrase.id}`}
                  className="btn-icon"
                  onClick={() => setPhraseSheet({ kind: 'edit', phraseId: phrase.id })}
                >
                  Edit
                </button>
                {confirmingDeletePhraseId === phrase.id ? (
                  <button
                    type="button"
                    data-testid={`confirm-delete-phrase-${phrase.id}`}
                    className="btn-icon btn-danger"
                    onClick={() => {
                      onDeletePhrase(phrase.id)
                      setConfirmingDeletePhraseId(undefined)
                    }}
                  >
                    Confirm delete
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid={`delete-phrase-${phrase.id}`}
                    className="btn-icon btn-danger"
                    onClick={() => setConfirmingDeletePhraseId(phrase.id)}
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        data-testid="add-phrase"
        className="btn-primary btn-add-row"
        onClick={() => setPhraseSheet({ kind: 'add' })}
      >
        + Add phrase
      </button>

      {renaming && (
        <NameSheet
          title="Rename Deck"
          initialValue={deck.name}
          onCancel={() => setRenaming(false)}
          onSave={(name) => {
            onRenameDeck(name)
            setRenaming(false)
          }}
        />
      )}

      {phraseSheet?.kind === 'add' && (
        <PhraseSheet
          onCancel={() => setPhraseSheet(undefined)}
          onSave={(french, english) => {
            onAddPhrase(french, english)
            setPhraseSheet(undefined)
          }}
        />
      )}
      {phraseSheet?.kind === 'edit' && editingPhrase && (
        <PhraseSheet
          initialFrench={editingPhrase.french}
          initialEnglish={editingPhrase.english}
          onCancel={() => setPhraseSheet(undefined)}
          onSave={(french, english) => {
            onUpdatePhrase(editingPhrase.id, { french, english })
            setPhraseSheet(undefined)
          }}
        />
      )}
    </main>
  )
}
