import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { Deck, DeckId } from '../domain/deck'
import type { DraftPhrase, ScanError, ScanReader } from '../domain/ports'
import { NameSheet } from './NameSheet'
import { PhraseSheet } from './PhraseSheet'
import '../styles/tokens.css'
import './ImportScreen.css'

/**
 * Where a confirmed batch of Draft Phrases goes: one existing Deck, or a
 * Deck named right here (docs/design.md §3.5 — one Deck for the whole
 * batch). Creating the Deck and persisting the Phrases is the composition
 * root's job, same as every other screen in this set — this component only
 * describes the choice.
 */
export type ImportTarget = { kind: 'existing'; deckId: DeckId } | { kind: 'new'; name: string }

type Step =
  | { kind: 'capture' }
  | { kind: 'reading'; controller: AbortController }
  | { kind: 'empty' }
  | { kind: 'failed'; error: ScanError }
  | { kind: 'review'; drafts: DraftPhrase[] }

type DeckSheet = { kind: 'new' } | undefined
type DraftSheet = { kind: 'edit'; index: number } | undefined

const UNREADABLE_COPY = "Couldn't read phrases from that photo — try better light or a closer shot."
const NETWORK_COPY = "Couldn't reach the scanner — check your connection and try again."
const UNAUTHORIZED_COPY = "Scanning isn't set up on the server yet. Ask whoever runs it to check."

/**
 * Scan / correction (docs/design.md §3.5, glossary: Scan, Draft Phrase).
 * Photograph a page, read it, review every proposed pair, assign the batch
 * to one Deck. Nothing here calls a store directly — `onSave` is the only
 * way a Draft Phrase can leave this screen, and only once the person taps
 * Save. Abandoning the screen (onCancel, or unmounting) discards the drafts
 * with no prompt, per the design's own accepted decision.
 */
export function ImportScreen({
  decks,
  scanReader,
  onSave,
  onCancel,
  showBackupNudge = false,
  onDismissBackupNudge,
}: {
  readonly decks: readonly Deck[]
  readonly scanReader: ScanReader
  onSave(target: ImportTarget, phrases: readonly DraftPhrase[]): void
  onCancel(): void
  /**
   * The first-run backup nudge (docs/design.md §3.6, T027) — shown once the
   * Scan has succeeded and produced Draft Phrases to review, and only until
   * she's dismissed it once (anywhere it appears; shared with the Decks
   * empty-state nudge).
   */
  showBackupNudge?: boolean
  /** Required whenever `showBackupNudge` can be true. */
  onDismissBackupNudge?(): void
}) {
  const [step, setStep] = useState<Step>({ kind: 'capture' })
  const [target, setTarget] = useState<ImportTarget | undefined>(undefined)
  const [deckSheet, setDeckSheet] = useState<DeckSheet>(undefined)
  const [draftSheet, setDraftSheet] = useState<DraftSheet>(undefined)
  const takePhotoInput = useRef<HTMLInputElement>(null)
  const chooseLibraryInput = useRef<HTMLInputElement>(null)

  function startRead(file: File) {
    const controller = new AbortController()
    setStep({ kind: 'reading', controller })
    scanReader.read(file, controller.signal).then(
      (drafts) => setStep(drafts.length === 0 ? { kind: 'empty' } : { kind: 'review', drafts: [...drafts] }),
      (error: ScanError) => setStep({ kind: 'failed', error }),
    )
  }

  function handleFileChosen(e: ChangeEvent<HTMLInputElement>) {
    const chosen = e.target.files?.[0]
    e.target.value = ''
    if (chosen) startRead(chosen)
  }

  function cancelReading() {
    if (step.kind === 'reading') step.controller.abort()
    setStep({ kind: 'capture' })
  }

  function backToCapture() {
    setStep({ kind: 'capture' })
  }

  function updateDraft(index: number, french: string, english: string) {
    if (step.kind !== 'review') return
    setStep({ kind: 'review', drafts: step.drafts.map((d, i) => (i === index ? { french, english } : d)) })
  }

  function removeDraft(index: number) {
    if (step.kind !== 'review') return
    setStep({ kind: 'review', drafts: step.drafts.filter((_, i) => i !== index) })
  }

  const drafts = step.kind === 'review' ? step.drafts : []
  const targetName =
    target?.kind === 'existing' ? decks.find((d) => d.id === target.deckId)?.name : target?.kind === 'new' ? target.name : undefined
  const canSave = step.kind === 'review' && target !== undefined && drafts.length > 0

  function handleSave() {
    if (!canSave) return
    onSave(target!, drafts)
  }

  return (
    <main className="screen import-screen">
      <header className="screen-header">
        <button type="button" data-testid="cancel-import" className="btn-icon" onClick={onCancel}>
          Cancel
        </button>
        <h1>Scan a page</h1>
      </header>

      {step.kind === 'capture' && (
        <div className="import-capture">
          <input
            ref={takePhotoInput}
            data-testid="take-photo-input"
            className="visually-hidden"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFileChosen}
          />
          <input
            ref={chooseLibraryInput}
            data-testid="choose-from-library-input"
            className="visually-hidden"
            type="file"
            accept="image/*"
            onChange={handleFileChosen}
          />
          <button
            type="button"
            data-testid="take-photo"
            className="btn-primary btn-add-row"
            onClick={() => takePhotoInput.current?.click()}
          >
            Take Photo
          </button>
          <button
            type="button"
            data-testid="choose-from-library"
            className="btn-secondary"
            onClick={() => chooseLibraryInput.current?.click()}
          >
            Choose from Library
          </button>
        </div>
      )}

      {step.kind === 'reading' && (
        <div className="import-reading">
          <p className="import-reading__status">Reading your photo…</p>
          <button type="button" data-testid="scan-cancel" className="btn-secondary" onClick={cancelReading}>
            Cancel
          </button>
        </div>
      )}

      {step.kind === 'empty' && (
        <div className="import-status" data-testid="scan-empty">
          <p>No phrases found on that photo — nothing to correct here.</p>
          <button type="button" data-testid="scan-try-again" className="btn-secondary" onClick={backToCapture}>
            Try another photo
          </button>
        </div>
      )}

      {step.kind === 'failed' && (
        <div className="import-status import-status--failed" data-testid="scan-failed">
          <p>{failureCopy(step.error)}</p>
          {step.error.kind === 'unauthorized' ? (
            <button type="button" data-testid="scan-back-to-capture" className="btn-secondary" onClick={backToCapture}>
              Back
            </button>
          ) : (
            <button type="button" data-testid="scan-try-again" className="btn-secondary" onClick={backToCapture}>
              Try again
            </button>
          )}
        </div>
      )}

      {step.kind === 'review' && (
        <>
          {showBackupNudge && (
            <p className="backup-nudge" data-testid="backup-nudge">
              Tip: back up your phrases in Settings.{' '}
              <button
                type="button"
                data-testid="dismiss-backup-nudge"
                className="link-action"
                onClick={onDismissBackupNudge}
              >
                Got it
              </button>
            </p>
          )}
          {drafts.length === 0 ? (
            <p className="empty-state">Every Draft Phrase was removed — nothing left to save.</p>
          ) : (
            <ul className="phrase-list draft-list">
              {drafts.map((draft, index) => (
                <li key={index} data-testid={`draft-row-${index}`} className="phrase-row draft-row">
                  <div className="phrase-text">
                    <div className="phrase-english">{draft.english}</div>
                    <div className="phrase-french">{draft.french}</div>
                  </div>
                  <div className="phrase-actions">
                    <button
                      type="button"
                      data-testid={`edit-draft-${index}`}
                      className="btn-icon"
                      onClick={() => setDraftSheet({ kind: 'edit', index })}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      data-testid={`delete-draft-${index}`}
                      className="btn-icon btn-danger"
                      onClick={() => removeDraft(index)}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="import-deck-picker">
            <p className="sheet-label">Save to</p>
            <ul className="deck-list">
              {decks.map((deck) => (
                <li key={deck.id}>
                  <button
                    type="button"
                    data-testid={`deck-option-${deck.id}`}
                    className={
                      target?.kind === 'existing' && target.deckId === deck.id
                        ? 'deck-chip deck-chip--selected'
                        : 'deck-chip'
                    }
                    aria-pressed={target?.kind === 'existing' && target.deckId === deck.id}
                    onClick={() => setTarget({ kind: 'existing', deckId: deck.id })}
                  >
                    {deck.name}
                  </button>
                </li>
              ))}
              <li>
                <button
                  type="button"
                  data-testid="new-deck-option"
                  className={target?.kind === 'new' ? 'deck-chip deck-chip--selected' : 'deck-chip'}
                  aria-pressed={target?.kind === 'new'}
                  onClick={() => setDeckSheet({ kind: 'new' })}
                >
                  {target?.kind === 'new' ? target.name : '+ New Deck…'}
                </button>
              </li>
            </ul>
          </div>

          <button
            type="button"
            data-testid="save-import"
            className="btn-primary btn-add-row"
            disabled={!canSave}
            onClick={handleSave}
          >
            {targetName ? `Save ${drafts.length} phrases to "${targetName}"` : `Save ${drafts.length} phrases`}
          </button>
        </>
      )}

      {deckSheet?.kind === 'new' && (
        <NameSheet
          title="New Deck"
          onCancel={() => setDeckSheet(undefined)}
          onSave={(name) => {
            setTarget({ kind: 'new', name })
            setDeckSheet(undefined)
          }}
        />
      )}

      {draftSheet?.kind === 'edit' && drafts[draftSheet.index] && (
        <PhraseSheet
          initialFrench={drafts[draftSheet.index].french}
          initialEnglish={drafts[draftSheet.index].english}
          onCancel={() => setDraftSheet(undefined)}
          onSave={(french, english) => {
            updateDraft(draftSheet.index, french, english)
            setDraftSheet(undefined)
          }}
        />
      )}
    </main>
  )
}

function failureCopy(error: ScanError): string {
  switch (error.kind) {
    case 'unreadable':
      return UNREADABLE_COPY
    case 'network':
      return NETWORK_COPY
    case 'unauthorized':
      return UNAUTHORIZED_COPY
  }
}
