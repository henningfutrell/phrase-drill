import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DecksScreen } from './DecksScreen'
import type { Deck } from '../domain'

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function click(el: Element): void {
  ;(el as HTMLElement).click()
}

function deck(id: string, name: string, phraseCount: number): Deck {
  return {
    id,
    name,
    phrases: Array.from({ length: phraseCount }, (_, i) => ({
      id: `${id}-p${i}`,
      french: `f${i}`,
      english: `e${i}`,
    })),
  }
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

describe('DecksScreen', () => {
  it('renders every Deck with its name and Phrase count', () => {
    act(() => {
      root.render(
        <DecksScreen
          decks={[deck('d1', 'Home', 3), deck('d2', 'Climbing', 0)]}
          onCreateDeck={vi.fn()}
          onRenameDeck={vi.fn()}
          onDeleteDeck={vi.fn()}
          onOpenDeck={vi.fn()}
        />,
      )
    })
    expect(container.textContent).toContain('Home')
    expect(container.textContent).toContain('3 phrases')
    expect(container.textContent).toContain('Climbing')
  })

  it('shows an empty-state prompt when there are no Decks', () => {
    act(() => {
      root.render(
        <DecksScreen
          decks={[]}
          onCreateDeck={vi.fn()}
          onRenameDeck={vi.fn()}
          onDeleteDeck={vi.fn()}
          onOpenDeck={vi.fn()}
        />,
      )
    })
    expect(container.textContent).toContain('Nothing here yet')
  })

  it('calls onOpenDeck when a Deck row is tapped', () => {
    const onOpenDeck = vi.fn()
    act(() => {
      root.render(
        <DecksScreen
          decks={[deck('d1', 'Home', 3)]}
          onCreateDeck={vi.fn()}
          onRenameDeck={vi.fn()}
          onDeleteDeck={vi.fn()}
          onOpenDeck={onOpenDeck}
        />,
      )
    })
    click(container.querySelector('[data-testid="deck-row-d1"]')!)
    expect(onOpenDeck).toHaveBeenCalledWith('d1')
  })

  it('creates a Deck from the New Deck sheet', () => {
    const onCreateDeck = vi.fn()
    act(() => {
      root.render(
        <DecksScreen
          decks={[]}
          onCreateDeck={onCreateDeck}
          onRenameDeck={vi.fn()}
          onDeleteDeck={vi.fn()}
          onOpenDeck={vi.fn()}
        />,
      )
    })
    act(() => click(container.querySelector('[data-testid="new-deck"]')!))
    const input = container.querySelector('[data-testid="deck-name-input"]') as HTMLInputElement
    act(() => typeInto(input, 'Work'))
    act(() => click(container.querySelector('[data-testid="deck-name-save"]')!))
    expect(onCreateDeck).toHaveBeenCalledWith('Work')
  })

  it('renames a Deck from its Rename sheet, pre-filled with the current name', () => {
    const onRenameDeck = vi.fn()
    act(() => {
      root.render(
        <DecksScreen
          decks={[deck('d1', 'Home', 1)]}
          onCreateDeck={vi.fn()}
          onRenameDeck={onRenameDeck}
          onDeleteDeck={vi.fn()}
          onOpenDeck={vi.fn()}
        />,
      )
    })
    act(() => click(container.querySelector('[data-testid="rename-deck-d1"]')!))
    const input = container.querySelector('[data-testid="deck-name-input"]') as HTMLInputElement
    expect(input.value).toBe('Home')
    act(() => typeInto(input, 'Home base'))
    act(() => click(container.querySelector('[data-testid="deck-name-save"]')!))
    expect(onRenameDeck).toHaveBeenCalledWith('d1', 'Home base')
  })

  it('deletes a Deck only after the inline confirmation is tapped', () => {
    const onDeleteDeck = vi.fn()
    act(() => {
      root.render(
        <DecksScreen
          decks={[deck('d1', 'Home', 1)]}
          onCreateDeck={vi.fn()}
          onRenameDeck={vi.fn()}
          onDeleteDeck={onDeleteDeck}
          onOpenDeck={vi.fn()}
        />,
      )
    })
    act(() => click(container.querySelector('[data-testid="delete-deck-d1"]')!))
    expect(onDeleteDeck).not.toHaveBeenCalled()
    act(() => click(container.querySelector('[data-testid="confirm-delete-deck-d1"]')!))
    expect(onDeleteDeck).toHaveBeenCalledWith('d1')
  })
})
