import { useState } from 'react'
import type { BackupAge, Deck, Translator } from '../domain'
import type { PhraseId } from '../domain'
import { isBackupUrgent } from '../domain'
import { NameSheet } from './NameSheet'
import { PhraseSheet } from './PhraseSheet'
import { BackupStatus, type ExportOutcome } from './BackupStatus'

interface AcceptedCandidate {
  french: string
  english: string
  deckId: string
}

type PhraseSheetState = { kind: 'add' } | { kind: 'edit'; phraseId: PhraseId } | undefined

/**
 * Deck detail — the Phrases in one Deck (docs/design.md §3.3). Reorder is
 * touch-native move-up/move-down buttons, not a drag gesture — see T007
 * report for why. Purely presentational; every persist decision is App.tsx's.
 */
export function DeckDetailScreen({
  deck,
  decks,
  translator,
  onAddPhraseCandidates,
  onBack,
  onRenameDeck,
  onDeleteDeck,
  onAddPhrase,
  onUpdatePhrase,
  onDeletePhrase,
  onMovePhraseUp,
  onMovePhraseDown,
  onDrillDeck,
  onRegenerateDeckAudio,
  onRegeneratePhraseAudio,
  backupAge,
  onExportBackup,
  onCopyText,
}: {
  deck: Deck
  /** All Decks, so a Phrase Candidate can be routed to one other than this one (T057). */
  decks?: Deck[]
  /** Wired only into the Add sheet — never Edit (T057). */
  translator?: Translator
  onAddPhraseCandidates?: (accepted: AcceptedCandidate[]) => void
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
  /**
   * Makes the audio for every Phrase of this Deck again, in the voice pinned
   * now (T067). Confirmed first: it is one request per side per Phrase, the
   * only control in the app that spends real money in bulk, and she has no
   * other signal of what it costs. Optional — a caller that wires nothing
   * gets no control.
   */
  onRegenerateDeckAudio?: () => void
  /** The same for one Phrase. One tap, no confirmation: two Clips is not a
   * decision worth a sheet. */
  onRegeneratePhraseAudio?: (id: PhraseId) => void
  /**
   * How long since the library was last safe somewhere else (T031). Shown
   * here only once it is urgent — the home screen states it at every level,
   * and repeating a calm fact on every screen is how a status line becomes
   * wallpaper. This is the screen she adds Phrases on, so it is where an
   * urgent one has to reach her: the work at risk is the work being made here.
   */
  backupAge?: BackupAge
  /** Required whenever `backupAge` is passed. */
  onExportBackup?: () => Promise<ExportOutcome>
  onCopyText?: (text: string) => Promise<boolean>
}) {
  const [renaming, setRenaming] = useState(false)
  const [phraseSheet, setPhraseSheet] = useState<PhraseSheetState>(undefined)
  const [confirmingDeletePhraseId, setConfirmingDeletePhraseId] = useState<PhraseId | undefined>(
    undefined,
  )
  const [confirmingDeleteDeck, setConfirmingDeleteDeck] = useState(false)
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false)

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

      {backupAge && onExportBackup && isBackupUrgent(backupAge) && (
        <BackupStatus age={backupAge} onExportBackup={onExportBackup} onCopyText={onCopyText} />
      )}

      {deck.phrases.length > 0 && (
        <button
          type="button"
          data-testid="drill-deck"
          className="btn-primary"
          onClick={onDrillDeck}
        >
          Drill this Deck
        </button>
      )}

      {deck.phrases.length > 0 && onRegenerateDeckAudio && (
        confirmingRegenerate ? (
          <button
            type="button"
            data-testid="confirm-regenerate-deck-audio"
            className="btn-secondary"
            onClick={() => {
              setConfirmingRegenerate(false)
              onRegenerateDeckAudio()
            }}
          >
            Make the audio for all {deck.phrases.length} phrases again?
          </button>
        ) : (
          <button
            type="button"
            data-testid="regenerate-deck-audio"
            className="btn-secondary"
            onClick={() => setConfirmingRegenerate(true)}
          >
            Redo audio in the current voice
          </button>
        )
      )}

      {deck.phrases.length === 0 ? (
        <p className="empty-state">Add phrases to drill this Deck.</p>
      ) : (
        <ul className="phrase-list">
          {deck.phrases.map((phrase, index) => (
            <li key={phrase.id} data-testid={`phrase-row-${phrase.id}`} className="phrase-row">
              <div className="phrase-text">
                <div className="phrase-english">{phrase.english}</div>
                <div className="phrase-french">{phrase.french}</div>
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
                {onRegeneratePhraseAudio && (
                  <button
                    type="button"
                    data-testid={`regenerate-phrase-audio-${phrase.id}`}
                    className="btn-icon"
                    onClick={() => onRegeneratePhraseAudio(phrase.id)}
                  >
                    Redo audio
                  </button>
                )}
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
          deckName={deck.name}
          decks={decks}
          currentDeckId={deck.id}
          translator={translator}
          onAddCandidates={
            onAddPhraseCandidates &&
            ((accepted) => {
              onAddPhraseCandidates(accepted)
              setPhraseSheet(undefined)
            })
          }
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
