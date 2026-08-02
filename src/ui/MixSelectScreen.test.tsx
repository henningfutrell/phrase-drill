import type { ReactElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { MixSelectScreen } from './MixSelectScreen'
import type { Deck } from '../domain/deck'
import type { Mix } from '../domain/mix'

function deck(id: string, name: string, phraseCount: number): Deck {
  return {
    id,
    name,
    phrases: Array.from({ length: phraseCount }, (_, i) => ({
      id: `${id}-p${i}`,
      french: `fr-${id}-${i}`,
      english: `en-${id}-${i}`,
    })),
  }
}

let container: HTMLDivElement
let root: Root

function render(ui: ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(ui)
  })
}

function click(el: Element | null) {
  if (!el) throw new Error('element not found')
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('MixSelectScreen', () => {
  const home = deck('home', 'Home', 9)
  const climbing = deck('climbing', 'Climbing', 14)
  const work = deck('work', 'Work', 6)

  it('renders one chip per Deck with name and phrase count', () => {
    render(<MixSelectScreen decks={[home, climbing]} onStartMix={() => {}} />)
    expect(
      container.querySelector('[data-testid="deck-chip-home"]')?.textContent,
    ).toContain('Home')
    expect(
      container.querySelector('[data-testid="deck-chip-home"]')?.textContent,
    ).toContain('9 phrases')
    expect(
      container.querySelector('[data-testid="deck-chip-climbing"]')?.textContent,
    ).toContain('14 phrases')
  })

  it('Start Mix is disabled until 2 or more Decks are selected', () => {
    render(
      <MixSelectScreen decks={[home, climbing, work]} onStartMix={() => {}} />,
    )
    const start = container.querySelector(
      '[data-testid="start-mix"]',
    ) as HTMLButtonElement
    expect(start.disabled).toBe(true)

    click(container.querySelector('[data-testid="deck-chip-home"]'))
    expect(start.disabled).toBe(true)

    click(container.querySelector('[data-testid="deck-chip-climbing"]'))
    expect(start.disabled).toBe(false)
  })

  it('tracks a running total of Decks and Phrases selected', () => {
    render(
      <MixSelectScreen decks={[home, climbing, work]} onStartMix={() => {}} />,
    )
    const total = () =>
      container.querySelector('[data-testid="mix-select-total"]')?.textContent

    expect(total()).toBe('0 decks selected · 0 phrases')
    click(container.querySelector('[data-testid="deck-chip-home"]'))
    expect(total()).toBe('1 decks selected · 9 phrases')
    click(container.querySelector('[data-testid="deck-chip-work"]'))
    expect(total()).toBe('2 decks selected · 15 phrases')
  })

  it('toggles a chip back off on a second tap', () => {
    render(
      <MixSelectScreen decks={[home, climbing, work]} onStartMix={() => {}} />,
    )
    const chip = container.querySelector(
      '[data-testid="deck-chip-home"]',
    ) as HTMLButtonElement
    click(chip)
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    click(chip)
    expect(chip.getAttribute('aria-pressed')).toBe('false')
    expect(
      container.querySelector('[data-testid="mix-select-total"]')?.textContent,
    ).toBe('0 decks selected · 0 phrases')
  })

  it('produces a Mix from the selected Decks, in Deck list order, when Start Mix is tapped', () => {
    let handedOff: Mix | undefined
    render(
      <MixSelectScreen
        decks={[home, climbing, work]}
        onStartMix={(mix) => {
          handedOff = mix
        }}
      />,
    )
    // Select in reverse order to prove the Mix follows the Deck list order,
    // not the order Decks were tapped.
    click(container.querySelector('[data-testid="deck-chip-work"]'))
    click(container.querySelector('[data-testid="deck-chip-home"]'))
    click(container.querySelector('[data-testid="start-mix"]'))

    expect(handedOff?.phrases.map((p) => p.id)).toEqual([
      ...home.phrases.map((p) => p.id),
      ...work.phrases.map((p) => p.id),
    ])
  })

  it('does nothing when Start Mix is tapped with fewer than 2 Decks selected', () => {
    let called = false
    render(
      <MixSelectScreen
        decks={[home, climbing, work]}
        onStartMix={() => {
          called = true
        }}
      />,
    )
    click(container.querySelector('[data-testid="deck-chip-home"]'))
    click(container.querySelector('[data-testid="start-mix"]'))
    expect(called).toBe(false)
  })

  it('shows an inline prompt instead of a picker when fewer than 2 Decks exist', () => {
    render(<MixSelectScreen decks={[home]} onStartMix={() => {}} />)
    expect(container.textContent).toContain('Add another Deck to mix')
    expect(container.querySelector('[data-testid="start-mix"]')).toBeNull()
  })
})
