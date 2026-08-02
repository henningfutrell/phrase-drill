import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeckDetailScreen } from './DeckDetailScreen'
import type { Deck } from '../domain'

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
    ...overrides,
  }
  act(() => {
    root.render(<DeckDetailScreen deck={deck} {...handlers} />)
  })
  return handlers
}

describe('DeckDetailScreen', () => {
  it('renders each Phrase, French over English, in author order', () => {
    renderScreen(threePhraseDeck)
    const rows = container.querySelectorAll('[data-testid^="phrase-row-"]')
    expect(rows).toHaveLength(3)
    expect(rows[0].textContent).toContain('Bonjour')
    expect(rows[0].textContent).toContain('Hello')
  })

  it('shows an empty-state prompt when the Deck has no Phrases', () => {
    renderScreen({ ...threePhraseDeck, phrases: [] })
    expect(container.textContent).toContain('Add phrases')
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
