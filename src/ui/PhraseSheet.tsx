import { useEffect, useRef, useState } from 'react'
import type { Deck, PhraseCandidate, Translator } from '../domain'

const DEBOUNCE_MS = 500

interface AcceptedCandidate {
  french: string
  english: string
  deckId: string
}

/**
 * Add and edit a Phrase share this one sheet shape — French, then English.
 * When `translator` is supplied (the Add sheet only, T057), typing English
 * proposes one or more French Phrase Candidates to review and choose from;
 * typing French with English still empty proposes a single English
 * suggestion, shown but never saved un-reviewed. Omitting `translator`
 * (the Edit sheet, or a plain manual Add) behaves exactly as before.
 */
export function PhraseSheet({
  initialFrench = '',
  initialEnglish = '',
  deckName = '',
  decks,
  currentDeckId,
  translator,
  onAddCandidates,
  onSave,
  onCancel,
}: {
  initialFrench?: string
  initialEnglish?: string
  deckName?: string
  decks?: Deck[]
  currentDeckId?: string
  translator?: Translator
  onAddCandidates?: (accepted: AcceptedCandidate[]) => void
  onSave: (french: string, english: string) => void
  onCancel: () => void
}) {
  const [french, setFrench] = useState(initialFrench)
  const [english, setEnglish] = useState(initialEnglish)
  const [lastEdited, setLastEdited] = useState<'french' | 'english' | null>(null)
  const [englishSuggested, setEnglishSuggested] = useState(false)
  const [translateStatus, setTranslateStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [candidates, setCandidates] = useState<PhraseCandidate[] | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [candidateDeckIds, setCandidateDeckIds] = useState<Record<number, string>>({})

  const requestId = useRef(0)
  const canSave = french.trim().length > 0 && english.trim().length > 0

  useEffect(() => {
    if (!translator) return

    // EN -> FR: propose French candidates for the English she typed.
    if (lastEdited === 'english' && english.trim().length > 0) {
      const id = ++requestId.current
      const timer = setTimeout(() => {
        setTranslateStatus('loading')
        translator
          .translate(english.trim(), 'en-to-fr', deckName)
          .then((result) => {
            if (requestId.current !== id) return
            setTranslateStatus('idle')
            setCandidates(result)
            setSelected(new Set())
            setCandidateDeckIds(
              Object.fromEntries(result.map((_, i) => [i, currentDeckId ?? ''])),
            )
          })
          .catch(() => {
            if (requestId.current !== id) return
            setTranslateStatus('error')
            setCandidates(null)
          })
      }, DEBOUNCE_MS)
      return () => clearTimeout(timer)
    }

    // FR -> EN: only while English is still empty — never overwrite text
    // she already typed herself.
    if (lastEdited === 'french' && french.trim().length > 0 && english.trim().length === 0) {
      const id = ++requestId.current
      const timer = setTimeout(() => {
        setTranslateStatus('loading')
        translator
          .translate(french.trim(), 'fr-to-en', deckName)
          .then((result) => {
            if (requestId.current !== id) return
            setTranslateStatus('idle')
            if (result.length > 0) {
              setEnglish(result[0].text)
              setEnglishSuggested(true)
            }
          })
          .catch(() => {
            if (requestId.current !== id) return
            setTranslateStatus('error')
          })
      }, DEBOUNCE_MS)
      return () => clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [french, english, lastEdited, translator, deckName])

  function toggleSelected(index: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  function handleAddCandidates() {
    if (!candidates || !onAddCandidates) return
    const accepted: AcceptedCandidate[] = [...selected]
      .sort((a, b) => a - b)
      .map((i) => ({
        french: candidates[i].text,
        english: english.trim(),
        deckId: candidateDeckIds[i] ?? currentDeckId ?? '',
      }))
    onAddCandidates(accepted)
  }

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
        onChange={(e) => {
          setFrench(e.target.value)
          setLastEdited('french')
        }}
      />
      <label className="sheet-label" htmlFor="phrase-english">
        English
        {englishSuggested && (
          <span className="suggested-badge" data-testid="suggested-badge">
            suggested
          </span>
        )}
      </label>
      <input
        id="phrase-english"
        data-testid="phrase-english-input"
        className="sheet-input"
        value={english}
        onChange={(e) => {
          setEnglish(e.target.value)
          setLastEdited('english')
          setEnglishSuggested(false)
        }}
      />

      {translateStatus === 'loading' && (
        <p className="translate-status" data-testid="translate-status">
          Translating…
        </p>
      )}
      {translateStatus === 'error' && (
        <p className="translate-error" data-testid="translate-error">
          Couldn't translate — you can still type it yourself.
        </p>
      )}

      {candidates && candidates.length > 0 && (
        <div className="candidate-list" data-testid="candidate-list">
          {candidates.map((candidate, i) => (
            <div className="candidate-row" data-testid={`candidate-row-${i}`} key={i}>
              <input
                type="checkbox"
                data-testid={`candidate-checkbox-${i}`}
                checked={selected.has(i)}
                onChange={() => toggleSelected(i)}
              />
              <span className="candidate-text">{candidate.text}</span>
              {candidate.register && (
                <span className="candidate-register" data-testid={`candidate-register-${i}`}>
                  {candidate.register}
                </span>
              )}
              {decks && (
                <select
                  data-testid={`candidate-deck-${i}`}
                  value={candidateDeckIds[i] ?? currentDeckId ?? ''}
                  onChange={(e) =>
                    setCandidateDeckIds((prev) => ({ ...prev, [i]: e.target.value }))
                  }
                >
                  {decks.map((deck) => (
                    <option key={deck.id} value={deck.id}>
                      {deck.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ))}
          <div className="sheet-actions">
            <button
              type="button"
              data-testid="add-candidates"
              className="btn-primary"
              disabled={selected.size === 0}
              onClick={handleAddCandidates}
            >
              Add selected
            </button>
          </div>
        </div>
      )}

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
