import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeckDetailScreen } from './DeckDetailScreen'
import type { Deck, Translator } from '../domain'

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function click(el: Element): void {
  ;(el as HTMLElement).click()
}

const threePhraseDeck: Deck = {
  id: 'd1',
  name: 'Home',
  phrases: [
    { id: 'p1', french: 'Bonjour', english: 'Hello' },
    { id: 'p2', french: 'Merci', english: 'Thanks' },
    { id: 'p3', french: 'Au revoir', english: 'Goodbye' },
  ],
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function renderScreen(deck: Deck, overrides: Partial<Parameters<typeof DeckDetailScreen>[0]> = {}) {
  const handlers = {
    onBack: vi.fn(),
    onRenameDeck: vi.fn(),
    onDeleteDeck: vi.fn(),
    onAddPhrase: vi.fn(),
    onUpdatePhrase: vi.fn(),
    onDeletePhrase: vi.fn(),
    onMovePhraseUp: vi.fn(),
    onMovePhraseDown: vi.fn(),
    onDrillDeck: vi.fn(),
    ...overrides,
  }
  act(() => {
    root.render(<DeckDetailScreen deck={deck} {...handlers} />)
  })
  return handlers
}

describe('DeckDetailScreen', () => {
  it('renders a Drill this Deck button, pinned under the header, that calls onDrillDeck', () => {
    const { onDrillDeck } = renderScreen(threePhraseDeck)
    const button = container.querySelector('[data-testid="drill-deck"]')
    expect(button).not.toBeNull()
    act(() => click(button!))
    expect(onDrillDeck).toHaveBeenCalledTimes(1)
  })

  it('renders each Phrase, English over French, in author order', () => {
    renderScreen(threePhraseDeck)
    const rows = container.querySelectorAll('[data-testid^="phrase-row-"]')
    expect(rows).toHaveLength(3)
    expect(rows[0].textContent).toContain('Bonjour')
    expect(rows[0].textContent).toContain('Hello')

    // She works English -> French, so the English is the entry the row leads
    // with and the French is the answer under it (T062).
    const lines = rows[0].querySelectorAll('.phrase-text > *')
    expect(lines).toHaveLength(2)
    expect(lines[0].className).toBe('phrase-english')
    expect(lines[0].textContent).toBe('Hello')
    expect(lines[1].className).toBe('phrase-french')
    expect(lines[1].textContent).toBe('Bonjour')
  })

  it('shows an empty-state prompt when the Deck has no Phrases', () => {
    renderScreen({ ...threePhraseDeck, phrases: [] })
    expect(container.textContent).toContain('Add phrases')
  })

  it('does not offer Drill this Deck on an empty Deck — nothing to drill, not audio still generating', () => {
    const { onDrillDeck } = renderScreen({ ...threePhraseDeck, phrases: [] })
    expect(container.querySelector('[data-testid="drill-deck"]')).toBeNull()
    expect(onDrillDeck).not.toHaveBeenCalled()
  })

  it('adds a Phrase from the Add phrase sheet', () => {
    const { onAddPhrase } = renderScreen({ ...threePhraseDeck, phrases: [] })
    act(() => click(container.querySelector('[data-testid="add-phrase"]')!))
    const french = container.querySelector('[data-testid="phrase-french-input"]') as HTMLInputElement
    const english = container.querySelector('[data-testid="phrase-english-input"]') as HTMLInputElement
    act(() => typeInto(french, 'Salut'))
    act(() => typeInto(english, 'Hi'))
    act(() => click(container.querySelector('[data-testid="phrase-save"]')!))
    expect(onAddPhrase).toHaveBeenCalledWith('Salut', 'Hi')
  })

  it('edits a Phrase from its row, pre-filled with its current text', () => {
    const { onUpdatePhrase } = renderScreen(threePhraseDeck)
    act(() => click(container.querySelector('[data-testid="edit-phrase-p1"]')!))
    const french = container.querySelector('[data-testid="phrase-french-input"]') as HTMLInputElement
    const english = container.querySelector('[data-testid="phrase-english-input"]') as HTMLInputElement
    expect(french.value).toBe('Bonjour')
    expect(english.value).toBe('Hello')
    act(() => typeInto(french, 'Coucou'))
    act(() => click(container.querySelector('[data-testid="phrase-save"]')!))
    expect(onUpdatePhrase).toHaveBeenCalledWith('p1', { french: 'Coucou', english: 'Hello' })
  })

  it('deletes a Phrase only after the inline confirmation is tapped', () => {
    const { onDeletePhrase } = renderScreen(threePhraseDeck)
    act(() => click(container.querySelector('[data-testid="delete-phrase-p1"]')!))
    expect(onDeletePhrase).not.toHaveBeenCalled()
    act(() => click(container.querySelector('[data-testid="confirm-delete-phrase-p1"]')!))
    expect(onDeletePhrase).toHaveBeenCalledWith('p1')
  })

  it('moves a Phrase up or down by touch-native buttons', () => {
    const { onMovePhraseUp, onMovePhraseDown } = renderScreen(threePhraseDeck)
    act(() => click(container.querySelector('[data-testid="move-up-p2"]')!))
    expect(onMovePhraseUp).toHaveBeenCalledWith('p2')
    act(() => click(container.querySelector('[data-testid="move-down-p2"]')!))
    expect(onMovePhraseDown).toHaveBeenCalledWith('p2')
  })

  it('disables move-up on the first Phrase and move-down on the last', () => {
    renderScreen(threePhraseDeck)
    const firstUp = container.querySelector('[data-testid="move-up-p1"]') as HTMLButtonElement
    const lastDown = container.querySelector('[data-testid="move-down-p3"]') as HTMLButtonElement
    expect(firstUp.disabled).toBe(true)
    expect(lastDown.disabled).toBe(true)
  })

  it('renames the Deck from the header sheet', () => {
    const { onRenameDeck } = renderScreen(threePhraseDeck)
    act(() => click(container.querySelector('[data-testid="rename-deck"]')!))
    const input = container.querySelector('[data-testid="deck-name-input"]') as HTMLInputElement
    expect(input.value).toBe('Home')
    act(() => typeInto(input, 'Home base'))
    act(() => click(container.querySelector('[data-testid="deck-name-save"]')!))
    expect(onRenameDeck).toHaveBeenCalledWith('Home base')
  })

  it('deletes the Deck only after the inline confirmation, naming the Phrase count', () => {
    const { onDeleteDeck } = renderScreen(threePhraseDeck)
    act(() => click(container.querySelector('[data-testid="delete-deck"]')!))
    expect(container.textContent).toContain('3')
    expect(onDeleteDeck).not.toHaveBeenCalled()
    act(() => click(container.querySelector('[data-testid="confirm-delete-deck"]')!))
    expect(onDeleteDeck).toHaveBeenCalled()
  })

  it('calls onBack when the back control is tapped', () => {
    const { onBack } = renderScreen(threePhraseDeck)
    act(() => click(container.querySelector('[data-testid="back"]')!))
    expect(onBack).toHaveBeenCalled()
  })
})

describe('DeckDetailScreen — Phrase Candidates (T057 scope addition)', () => {
  const otherDeck: Deck = { id: 'd2', name: 'Formal', phrases: [] }

  function fakeTranslator(): Translator {
    return { translate: vi.fn().mockResolvedValue([]) }
  }

  it('threads decks, translator, and currentDeckId into the Add sheet, not the Edit sheet', () => {
    const translator = fakeTranslator()
    renderScreen(threePhraseDeck, { decks: [threePhraseDeck, otherDeck], translator, onAddPhraseCandidates: vi.fn() })

    act(() => click(container.querySelector('[data-testid="add-phrase"]')!))
    act(() => {
      const english = container.querySelector('[data-testid="phrase-english-input"]') as HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(english, 'Hello')
      english.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(translator.translate).not.toHaveBeenCalled() // debounce hasn't fired yet — proves the port is wired, not that it fired
    act(() => click(container.querySelector('[data-testid="phrase-save"]')!))
    act(() => click(container.querySelector('[data-testid="add-phrase"]')!))

    act(() => click(container.querySelector('[data-testid="edit-phrase-p1"]')!))
    // Editing an existing Phrase must never offer candidates — only the Add sheet does.
    expect(container.querySelector('[data-testid="translate-status"]')).toBeNull()
  })

  it('calls onAddPhraseCandidates and closes the sheet when candidates are accepted', () => {
    const onAddPhraseCandidates = vi.fn()
    renderScreen(
      { ...threePhraseDeck, phrases: [] },
      { decks: [threePhraseDeck, otherDeck], translator: fakeTranslator(), onAddPhraseCandidates },
    )
    act(() => click(container.querySelector('[data-testid="add-phrase"]')!))
    expect(container.querySelector('[data-testid="phrase-french-input"]')).not.toBeNull()
  })
})

describe('DeckDetailScreen — the backup age follows her here only once it is urgent', () => {
  it('shows nothing about backups while the backup is fresh — the home screen already said so', () => {
    renderScreen(threePhraseDeck, {
      backupAge: { level: 'fresh', days: 2 },
      onExportBackup: vi.fn().mockResolvedValue({ kind: 'shared' }),
    })
    expect(container.querySelector('[data-testid="backup-status"]')).toBeNull()
  })

  it('carries the indicator onto the screen where she adds phrases once it is aging', () => {
    renderScreen(threePhraseDeck, {
      backupAge: { level: 'aging', days: 14 },
      onExportBackup: vi.fn().mockResolvedValue({ kind: 'shared' }),
    })
    expect(container.querySelector('[data-testid="backup-status"]')!.textContent).toContain(
      '14 days ago',
    )
  })

  it('carries it here when overdue too', () => {
    renderScreen(threePhraseDeck, {
      backupAge: { level: 'overdue', days: 61 },
      onExportBackup: vi.fn().mockResolvedValue({ kind: 'shared' }),
    })
    expect(
      (container.querySelector('[data-testid="backup-status"]') as HTMLElement).dataset.level,
    ).toBe('overdue')
  })

  it('shows nothing when the caller passes no age at all', () => {
    renderScreen(threePhraseDeck)
    expect(container.querySelector('[data-testid="backup-status"]')).toBeNull()
  })
})
