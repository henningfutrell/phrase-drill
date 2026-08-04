import { useMemo, useState } from 'react'
import type { Deck, DeckId } from '../domain/deck'
import { resolveMixDecks, type Mix, type MixId } from '../domain/mix'
import { NameSheet } from './NameSheet'
import '../styles/tokens.css'
import './MixSelectScreen.css'

/**
 * Mix (glossary): a named, saved selection of Decks. Composing a *new* one
 * is meaningless below 2 Decks — that gates the picker half of this screen.
 * It does not gate the primary button: docs/design.md §3.4 says a 1-Deck
 * selection routes to a plain Drill rather than being a dead button (T008's
 * carried contradiction, resolved in T006).
 *
 * It does not gate the saved half either (T059): her saved Mixes are listed
 * whatever the Deck count is, including after she has deleted Decks down to
 * one. A screen that hid them would look exactly like a screen that had
 * lost them.
 */
const MIN_DECKS_TO_MIX = 2

export interface MixSelectScreenProps {
  /** Every Deck available to pick from, author order (docs/design.md §3.4). */
  readonly decks: readonly Deck[]
  /** Her saved Mixes, in store order. */
  readonly mixes: readonly Mix[]
  /** One tap on a saved Mix: straight into a Drill on it (T059). */
  readonly onStartMix: (mix: Mix) => void
  /**
   * Start a Drill on a selection she has not saved. Not a Mix — an unsaved
   * selection leaves nothing behind, which is exactly what the glossary
   * says a Mix is not.
   */
  readonly onStartSelection: (decks: readonly Deck[]) => void
  readonly onSaveMix: (name: string, deckIds: readonly DeckId[]) => void
  readonly onRenameMix: (id: MixId, name: string) => void
  readonly onEditMixDecks: (id: MixId, deckIds: readonly DeckId[]) => void
  readonly onDeleteMix: (id: MixId) => void
  /** Back to Decks (T006) — optional only for tests that don't exercise it. */
  readonly onBack?: () => void
}

type SheetState = { kind: 'save' } | { kind: 'rename'; mix: Mix } | undefined

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

export function MixSelectScreen({
  decks,
  mixes,
  onStartMix,
  onStartSelection,
  onSaveMix,
  onRenameMix,
  onEditMixDecks,
  onDeleteMix,
  onBack,
}: MixSelectScreenProps) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<DeckId>>(new Set())
  const [editingMixId, setEditingMixId] = useState<MixId | undefined>(undefined)
  const [sheet, setSheet] = useState<SheetState>(undefined)
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<MixId | undefined>(undefined)

  // Deck list order, not tap order: two Mixes over the same Decks are the
  // same Mix, and a pool that changed order with her taps would be a third
  // thing nobody asked for.
  const selectedDecks = useMemo(
    () => decks.filter((deck) => selectedIds.has(deck.id)),
    [decks, selectedIds],
  )
  const phraseCount = useMemo(
    () => selectedDecks.reduce((total, deck) => total + deck.phrases.length, 0),
    [selectedDecks],
  )
  const canStart = selectedDecks.length >= 1

  function toggle(id: DeckId) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function clearSelection() {
    setSelectedIds(new Set())
    setEditingMixId(undefined)
  }

  function handleStart() {
    if (!canStart) return
    onStartSelection(selectedDecks)
  }

  /**
   * One control, two jobs, decided by whether she is editing: saving a new
   * Mix needs a name (the sheet), re-saving an existing one already has
   * one. Re-saving is also the only moment the id of a deleted Deck leaves
   * a Mix — `selectedDecks` holds only Decks that still exist.
   */
  function handleSave() {
    if (!canStart) return
    if (editingMixId) {
      onEditMixDecks(editingMixId, selectedDecks.map((deck) => deck.id))
      clearSelection()
      return
    }
    setSheet({ kind: 'save' })
  }

  function startEditing(mix: Mix) {
    setEditingMixId(mix.id)
    setSelectedIds(new Set(mix.deckIds))
    setConfirmingDeleteId(undefined)
  }

  const canPick = decks.length >= MIN_DECKS_TO_MIX

  return (
    <main className="mix-select">
      {onBack && (
        <button type="button" data-testid="back" className="link-action" onClick={onBack}>
          Back
        </button>
      )}
      <h1 className="mix-select__title">Mixes</h1>

      {mixes.length === 0 ? (
        <p className="mix-select__saved-empty">No saved mixes yet</p>
      ) : (
        <ul className="mix-select__saved">
          {mixes.map((mix) => {
            const liveDecks = resolveMixDecks(mix, decks)
            const phrases = liveDecks.reduce((total, deck) => total + deck.phrases.length, 0)
            return (
              <li key={mix.id} className="mix-row">
                <button
                  type="button"
                  className="mix-row__main"
                  data-testid={`mix-row-${mix.id}`}
                  disabled={phrases === 0}
                  onClick={() => onStartMix(mix)}
                >
                  <span className="mix-row__name">{mix.name}</span>
                  <span className="mix-row__count">
                    {liveDecks.length === 0
                      ? 'Its decks are gone'
                      : `${plural(liveDecks.length, 'deck')} · ${plural(phrases, 'phrase')}`}
                  </span>
                </button>
                <div className="mix-row__actions">
                  <button
                    type="button"
                    className="btn-icon"
                    data-testid={`rename-mix-${mix.id}`}
                    onClick={() => setSheet({ kind: 'rename', mix })}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="btn-icon"
                    data-testid={`edit-mix-${mix.id}`}
                    onClick={() => startEditing(mix)}
                  >
                    Edit decks
                  </button>
                  {confirmingDeleteId === mix.id ? (
                    <button
                      type="button"
                      className="btn-icon btn-danger"
                      data-testid={`confirm-delete-mix-${mix.id}`}
                      onClick={() => {
                        onDeleteMix(mix.id)
                        setConfirmingDeleteId(undefined)
                        if (editingMixId === mix.id) clearSelection()
                      }}
                    >
                      Confirm delete
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn-icon btn-danger"
                      data-testid={`delete-mix-${mix.id}`}
                      onClick={() => setConfirmingDeleteId(mix.id)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {!canPick ? (
        <p className="mix-select__empty-caption">Add another Deck to mix</p>
      ) : (
        <>
          <ul className="mix-select__list">
            {decks.map((deck) => {
              const isSelected = selectedIds.has(deck.id)
              return (
                <li key={deck.id}>
                  <button
                    type="button"
                    className={isSelected ? 'deck-chip deck-chip--selected' : 'deck-chip'}
                    aria-pressed={isSelected}
                    data-testid={`deck-chip-${deck.id}`}
                    onClick={() => toggle(deck.id)}
                  >
                    <span className="deck-chip__name">{deck.name}</span>
                    <span className="deck-chip__count">{deck.phrases.length} phrases</span>
                  </button>
                </li>
              )
            })}
          </ul>
          <p className="mix-select__total" data-testid="mix-select-total">
            {plural(selectedDecks.length, 'deck')} selected · {phraseCount} phrases
          </p>
          <div className="mix-select__actions">
            <button
              type="button"
              className="btn-secondary"
              disabled={!canStart}
              data-testid="save-mix"
              onClick={handleSave}
            >
              {editingMixId ? 'Save changes' : 'Save mix'}
            </button>
            {editingMixId && (
              <button
                type="button"
                className="btn-secondary"
                data-testid="cancel-mix-edit"
                onClick={clearSelection}
              >
                Cancel
              </button>
            )}
          </div>
          <button
            type="button"
            className="primary-button"
            disabled={!canStart}
            data-testid="start-mix"
            onClick={handleStart}
          >
            {selectedDecks.length === 1 ? 'Start Drill' : 'Start Mix'}
          </button>
          <p className="mix-select__hint">Phrases play in random order</p>
        </>
      )}

      {sheet?.kind === 'save' && (
        <NameSheet
          title="Name this mix"
          onCancel={() => setSheet(undefined)}
          onSave={(name) => {
            onSaveMix(name, selectedDecks.map((deck) => deck.id))
            setSheet(undefined)
            clearSelection()
          }}
        />
      )}
      {sheet?.kind === 'rename' && (
        <NameSheet
          title="Rename mix"
          initialValue={sheet.mix.name}
          onCancel={() => setSheet(undefined)}
          onSave={(name) => {
            onRenameMix(sheet.mix.id, name)
            setSheet(undefined)
          }}
        />
      )}
    </main>
  )
}
