import { useMemo, useState } from 'react'
import type { Deck, DeckId } from '../domain/deck'
import { createMix, type Mix } from '../domain/mix'
import '../styles/tokens.css'
import './MixSelectScreen.css'

/** Mix (glossary): several Decks combined into one pool, meaningless below 2. */
const MIN_DECKS_TO_MIX = 2

export interface MixSelectScreenProps {
  /** Every Deck available to pick from, author order (docs/design.md §3.4). */
  readonly decks: readonly Deck[]
  /**
   * The seam to the Drill screen (T006, not built here): called with the
   * shuffle-ready Mix once the owner taps Start Mix. Shuffle itself is a
   * Drill-start property (glossary), applied by whoever creates the
   * DrillPlayer from `mix.phrases` — not here.
   */
  readonly onStartMix: (mix: Mix) => void
}

export function MixSelectScreen({ decks, onStartMix }: MixSelectScreenProps) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<DeckId>>(
    new Set(),
  )

  const selectedDecks = useMemo(
    () => decks.filter((deck) => selectedIds.has(deck.id)),
    [decks, selectedIds],
  )
  const phraseCount = useMemo(
    () =>
      selectedDecks.reduce((total, deck) => total + deck.phrases.length, 0),
    [selectedDecks],
  )
  const canStart = selectedDecks.length >= MIN_DECKS_TO_MIX

  function toggle(id: DeckId) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function handleStart() {
    if (!canStart) return
    onStartMix(createMix(selectedDecks))
  }

  if (decks.length < MIN_DECKS_TO_MIX) {
    return (
      <main className="mix-select mix-select--empty">
        <h1 className="mix-select__title">Mix</h1>
        <p className="mix-select__empty-caption">Add another Deck to mix</p>
      </main>
    )
  }

  return (
    <main className="mix-select">
      <h1 className="mix-select__title">Mix</h1>
      <ul className="mix-select__list">
        {decks.map((deck) => {
          const isSelected = selectedIds.has(deck.id)
          return (
            <li key={deck.id}>
              <button
                type="button"
                className={
                  isSelected ? 'deck-chip deck-chip--selected' : 'deck-chip'
                }
                aria-pressed={isSelected}
                data-testid={`deck-chip-${deck.id}`}
                onClick={() => toggle(deck.id)}
              >
                <span className="deck-chip__name">{deck.name}</span>
                <span className="deck-chip__count">
                  {deck.phrases.length} phrases
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      <p className="mix-select__total" data-testid="mix-select-total">
        {selectedDecks.length} decks selected · {phraseCount} phrases
      </p>
      <button
        type="button"
        className="primary-button"
        disabled={!canStart}
        data-testid="start-mix"
        onClick={handleStart}
      >
        Start Mix
      </button>
      <p className="mix-select__hint">Phrases play in random order</p>
    </main>
  )
}
