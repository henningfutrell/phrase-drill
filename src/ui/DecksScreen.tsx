import { useState } from 'react'
import type { Deck, DeckId } from '../domain'
import { NameSheet } from './NameSheet'
import { RestoreControl, type RestoreFileResult } from './RestoreControl'

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
  onOpenSettings,
  onOpenMix,
  onOpenImport,
  onRestoreFileChosen,
  onConfirmRestore,
  onCancelRestore,
  syncStatus,
}: {
  decks: readonly Deck[]
  onCreateDeck: (name: string) => void
  onRenameDeck: (id: DeckId, name: string) => void
  onDeleteDeck: (id: DeckId) => void
  onOpenDeck: (id: DeckId) => void
  /** Entry point to Settings (docs/design.md §3.6) — omitted only in tests that don't exercise it. */
  onOpenSettings?: () => void
  /** Entry point to the Mix screen (docs/design.md §3.2, T006) — omitted only in tests that don't exercise it. */
  onOpenMix?: () => void
  /** Entry point to Scan / correction (docs/design.md §3.5) — omitted only in tests that don't exercise it. */
  onOpenImport?: () => void
  /**
   * How long since the library was last safe somewhere else (T031). Stated
   * here at every level, including fresh: this is the screen she lands on,
   * so it is the one place the answer is always available rather than only
   * when something is wrong. Omitted only in tests that don't exercise it.
   */
  /**
   * Restore, on the empty state (T031). A wiped or replaced phone opens here
   * and nowhere else, and this is the screen she is looking at when her
   * phrases are gone — so this is where restore has to be, not three taps
   * into a settings screen she has no reason to open. Omitted only in tests
   * that don't exercise it.
   */
  onRestoreFileChosen?: (file: File) => Promise<RestoreFileResult>
  /** Required whenever `onRestoreFileChosen` is passed. */
  onConfirmRestore?: () => void
  /** Required whenever `onRestoreFileChosen` is passed. */
  onCancelRestore?: () => void
  /**
   * One line about sync (T034) — already worded by `sync-status-text.ts`;
   * this screen only places it. Omitted in tests that do not exercise sync,
   * and then nothing is shown rather than an empty line.
   */
  syncStatus?: string
}) {
  const [sheet, setSheet] = useState<SheetState>(undefined)
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<DeckId | undefined>(undefined)

  return (
    <main className="screen">
      <header className="screen-header">
        <h1>Decks</h1>
        <div className="screen-header-actions">
          {onOpenMix && (
            <button
              type="button"
              data-testid="open-mix"
              className="link-action"
              onClick={onOpenMix}
            >
              Mix decks…
            </button>
          )}
          {onOpenImport && (
            <button
              type="button"
              data-testid="open-import"
              className="link-action"
              onClick={onOpenImport}
            >
              Scan a page
            </button>
          )}
          {onOpenSettings && (
            <button
              type="button"
              data-testid="open-settings"
              className="link-action"
              onClick={onOpenSettings}
            >
              Settings
            </button>
          )}
          <button
            type="button"
            data-testid="new-deck"
            className="link-action"
            onClick={() => setSheet({ kind: 'create' })}
          >
            + New Deck
          </button>
        </div>
      </header>

      {syncStatus && (
        <p className="sync-status" data-testid="sync-status">
          {syncStatus}
        </p>
      )}
      {/*
        No file-backup block here (T097). The server holds her library, and the
        sync line above already says where her phrases are and says it
        accurately — including when sync is failing, which it names by cause
        ("sign in again to sync", "will sync when back online"). A second
        indicator on the same screen, pushing a file she has to save herself,
        said the same thing worse and read as an emergency. Saving a file is
        still offered, in Settings, where she goes looking for it.
      */}

      {decks.length === 0 ? (
        <>
          <p className="empty-state">
            Nothing here yet — start a Deck for one of your contexts.
          </p>
          {onRestoreFileChosen && onConfirmRestore && onCancelRestore && (
            <div className="empty-state-recovery">
              <p className="settings-help">Already have a backup file?</p>
              <RestoreControl
                label="Restore from a backup file"
                onRestoreFileChosen={onRestoreFileChosen}
                onConfirmRestore={onConfirmRestore}
                onCancelRestore={onCancelRestore}
              />
            </div>
          )}
        </>
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
