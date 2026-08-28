import { useMemo, useState } from 'react'
import { splitPassageIntoLines, type Passage, type PassageId } from '../domain'
import { PassageSheet } from './PassageSheet'
import '../styles/tokens.css'
import './PassagesScreen.css'

export interface PassagesScreenProps {
  /** Their long-form texts, in store order. */
  readonly passages: readonly Passage[]
  readonly onBack: () => void
  readonly onCreatePassage: (name: string, text: string) => void
  readonly onUpdatePassage: (id: PassageId, name: string, text: string) => void
  readonly onDeletePassage: (id: PassageId) => void
  readonly onDrillPassage: (passage: Passage) => void
}

type SheetState = { kind: 'create' } | { kind: 'edit'; passage: Passage } | undefined

/**
 * Long form — the screen that lists their Passages. "Long form" is their own name
 * for the feature, so it is the name on the screen and on the action that
 * reaches it from Decks.
 *
 * One screen and one sheet, and no detail screen behind either: a Deck needs a
 * detail screen because it holds many Phrases with per-Phrase controls, and a
 * Passage is one block of text the sheet already shows whole.
 *
 * Purely presentational, like DecksScreen — every persistence decision is the
 * composition root's, reached only through callback props.
 */
export function PassagesScreen({
  passages,
  onBack,
  onCreatePassage,
  onUpdatePassage,
  onDeletePassage,
  onDrillPassage,
}: PassagesScreenProps) {
  const [sheet, setSheet] = useState<SheetState>(undefined)
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<PassageId | undefined>(undefined)

  // Splitting is a full scan of every text, and this screen re-renders on every
  // sheet open, delete arm and confirm — so it happens when their Passages
  // change and not on a tap.
  const lineCounts = useMemo(
    () => new Map(passages.map((passage) => [passage.id, splitPassageIntoLines(passage).length])),
    [passages],
  )

  return (
    <main className="screen" data-testid="passages-screen">
      <header className="screen-header">
        <h1>Long form</h1>
        <div className="screen-header-actions">
          <button type="button" data-testid="passages-back" className="link-action" onClick={onBack}>
            Back
          </button>
          {/* The one control that adds an entry, and it moves: with nothing in
              the list it is the rose button inside the empty state, because
              that is the only thing on the screen worth doing. */}
          {passages.length > 0 && (
            <button
              type="button"
              data-testid="passage-new"
              className="link-action"
              onClick={() => setSheet({ kind: 'create' })}
            >
              + New
            </button>
          )}
        </div>
      </header>

      {passages.length === 0 ? (
        <div className="empty-state" data-testid="passages-empty">
          <p className="passage-empty-copy">
            Nothing here yet. A long-form entry is a page of French you want to read aloud — a poem,
            a letter, a chapter. Paste or type one in and it plays back a line at a time, leaving a
            gap after each one for you to say it back.
          </p>
          <button
            type="button"
            data-testid="passage-new"
            className="btn-primary"
            onClick={() => setSheet({ kind: 'create' })}
          >
            Add a long-form entry
          </button>
        </div>
      ) : (
        <ul className="passage-list">
          {passages.map((passage) => {
            const lines = lineCounts.get(passage.id) ?? 0
            const confirming = confirmingDeleteId === passage.id
            return (
              <li
                key={passage.id}
                // "Confirm delete" is a much wider label than "Delete", and it
                // squeezes the name column to about 190px — a title in the
                // script face breaks into three fragments there. The class
                // lets the name keep the whole first line while the row is
                // armed; see PassagesScreen.css.
                className={confirming ? 'passage-row passage-row--confirming' : 'passage-row'}
                data-testid={`passage-row-${passage.id}`}
              >
                {/*
                  The whole left of the row starts the Drill — the reason the user
                  opened this screen, and a thumb-sized target rather than a
                  small button beside two others.

                  The Line count is the row's second line, and it is the only
                  number on this screen: it is exactly how many pieces the
                  Drill will play, so it tells a paragraph from a page without
                  opening either. Nothing here is progress — no percentage, no
                  last-practised, no streak (PRODUCT.md).
                */}
                <button
                  type="button"
                  data-testid={`passage-drill-${passage.id}`}
                  className="passage-row-main"
                  disabled={lines === 0}
                  onClick={() => onDrillPassage(passage)}
                >
                  <span className="passage-name" data-testid={`passage-name-${passage.id}`}>
                    {passage.name}
                  </span>
                  <span className="passage-lines" data-testid={`passage-lines-${passage.id}`}>
                    {lines === 0 ? 'Nothing to read yet' : `${lines} line${lines === 1 ? '' : 's'}`}
                  </span>
                </button>
                <div className="passage-row-actions">
                  <button
                    type="button"
                    data-testid={`passage-edit-${passage.id}`}
                    className="btn-icon"
                    onClick={() => {
                      setSheet({ kind: 'edit', passage })
                      setConfirmingDeleteId(undefined)
                    }}
                  >
                    Edit
                  </button>
                  {/* Two taps, like a Deck: a page the user typed is not
                      recoverable from inside the app. */}
                  {confirming ? (
                    <button
                      type="button"
                      data-testid={`passage-delete-confirm-${passage.id}`}
                      className="btn-icon btn-danger"
                      onClick={() => {
                        onDeletePassage(passage.id)
                        setConfirmingDeleteId(undefined)
                      }}
                    >
                      Confirm delete
                    </button>
                  ) : (
                    <button
                      type="button"
                      data-testid={`passage-delete-${passage.id}`}
                      className="btn-icon btn-danger"
                      onClick={() => setConfirmingDeleteId(passage.id)}
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

      {sheet?.kind === 'create' && (
        <PassageSheet
          title="New long form"
          onCancel={() => setSheet(undefined)}
          onSave={(name, text) => {
            onCreatePassage(name, text)
            setSheet(undefined)
          }}
        />
      )}
      {sheet?.kind === 'edit' && (
        <PassageSheet
          title="Edit long form"
          initialName={sheet.passage.name}
          initialText={sheet.passage.text}
          onCancel={() => setSheet(undefined)}
          onSave={(name, text) => {
            onUpdatePassage(sheet.passage.id, name, text)
            setSheet(undefined)
          }}
        />
      )}
    </main>
  )
}
