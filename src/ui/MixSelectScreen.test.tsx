import type { ReactElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { MixSelectScreen, type MixSelectScreenProps } from './MixSelectScreen'
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

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function find(testId: string): Element | null {
  return container.querySelector(`[data-testid="${testId}"]`)
}

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

const home = deck('home', 'Home', 9)
const climbing = deck('climbing', 'Climbing', 14)
const work = deck('work', 'Work', 6)

const NOOP: Omit<MixSelectScreenProps, 'decks' | 'mixes'> = {
  onStartMix: () => {},
  onStartSelection: () => {},
  onSaveMix: () => {},
  onRenameMix: () => {},
  onEditMixDecks: () => {},
  onDeleteMix: () => {},
}

function screen(props: Partial<MixSelectScreenProps> = {}) {
  return <MixSelectScreen decks={[home, climbing, work]} mixes={[]} {...NOOP} {...props} />
}

describe('MixSelectScreen — picking Decks for one run', () => {
  it('renders one chip per Deck with name and phrase count', () => {
    render(screen({ decks: [home, climbing] }))
    expect(find('deck-chip-home')?.textContent).toContain('Home')
    expect(find('deck-chip-home')?.textContent).toContain('9 phrases')
    expect(find('deck-chip-climbing')?.textContent).toContain('14 phrases')
  })

  it('Start is disabled with nothing selected, and enabled from 1 Deck up', () => {
    render(screen())
    const start = find('start-mix') as HTMLButtonElement
    expect(start.disabled).toBe(true)

    click(find('deck-chip-home'))
    expect(start.disabled).toBe(false)

    click(find('deck-chip-climbing'))
    expect(start.disabled).toBe(false)
  })

  it('labels the primary button Start Drill for exactly 1 Deck, Start Mix for 2 or more', () => {
    render(screen())
    click(find('deck-chip-home'))
    expect(find('start-mix')?.textContent).toBe('Start Drill')
    click(find('deck-chip-climbing'))
    expect(find('start-mix')?.textContent).toBe('Start Mix')
  })

  it('tracks a running total of Decks and Phrases selected, singular at 1 Deck', () => {
    render(screen())
    const total = () => find('mix-select-total')?.textContent

    expect(total()).toBe('0 decks selected · 0 phrases')
    click(find('deck-chip-home'))
    expect(total()).toBe('1 deck selected · 9 phrases')
    click(find('deck-chip-work'))
    expect(total()).toBe('2 decks selected · 15 phrases')
  })

  it('toggles a chip back off on a second tap', () => {
    render(screen())
    const chip = find('deck-chip-home') as HTMLButtonElement
    click(chip)
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    click(chip)
    expect(chip.getAttribute('aria-pressed')).toBe('false')
    expect(find('mix-select-total')?.textContent).toBe('0 decks selected · 0 phrases')
  })

  it('hands the selected Decks straight to a Drill, in Deck list order, when Start is tapped', () => {
    let handedOff: readonly Deck[] | undefined
    render(
      screen({
        onStartSelection: (selected) => {
          handedOff = selected
        },
      }),
    )
    // Select in reverse order to prove the hand-off follows the Deck list
    // order, not the order Decks were tapped.
    click(find('deck-chip-work'))
    click(find('deck-chip-home'))
    click(find('start-mix'))

    expect(handedOff?.map((d) => d.id)).toEqual(['home', 'work'])
  })

  it('does nothing when the primary button is tapped with nothing selected', () => {
    let called = false
    render(
      screen({
        onStartSelection: () => {
          called = true
        },
      }),
    )
    click(find('start-mix'))
    expect(called).toBe(false)
  })

  it('shows an inline prompt instead of a picker when fewer than 2 Decks exist', () => {
    render(screen({ decks: [home] }))
    expect(container.textContent).toContain('Add another Deck to mix')
    expect(find('start-mix')).toBeNull()
  })

  it('calls onBack when the Back control is tapped, in both the picker and the prompt', () => {
    let backCount = 0
    const onBack = () => {
      backCount += 1
    }
    render(screen({ onBack }))
    click(find('back'))
    expect(backCount).toBe(1)

    render(screen({ decks: [home], onBack }))
    click(find('back'))
    expect(backCount).toBe(2)
  })
})

describe('MixSelectScreen — saved Mixes', () => {
  const mornings: Mix = { id: 'm1', name: 'Mornings', deckIds: ['home', 'work'] }

  it('lists every saved Mix with its Deck and Phrase counts', () => {
    render(screen({ mixes: [mornings] }))
    expect(find('mix-row-m1')?.textContent).toContain('Mornings')
    expect(find('mix-row-m1')?.textContent).toContain('2 decks · 15 phrases')
  })

  it('says so plainly when nothing has been saved yet', () => {
    render(screen({ mixes: [] }))
    expect(find('mix-row-m1')).toBeNull()
    expect(container.textContent).toContain('No saved mixes yet')
  })

  it('goes straight into a Drill on that Mix in one tap', () => {
    let started: Mix | undefined
    render(
      screen({
        mixes: [mornings],
        onStartMix: (mix) => {
          started = mix
        },
      }),
    )
    click(find('mix-row-m1'))
    expect(started).toEqual(mornings)
  })

  it('saves the current selection as a named Mix', () => {
    const saved: Array<{ name: string; deckIds: readonly string[] }> = []
    render(
      screen({
        onSaveMix: (name, deckIds) => {
          saved.push({ name, deckIds })
        },
      }),
    )
    click(find('deck-chip-home'))
    click(find('deck-chip-work'))
    click(find('save-mix'))
    typeInto(find('deck-name-input') as HTMLInputElement, 'Mornings')
    click(find('deck-name-save'))

    expect(saved).toEqual([{ name: 'Mornings', deckIds: ['home', 'work'] }])
  })

  it('cannot save an empty selection', () => {
    render(screen())
    expect((find('save-mix') as HTMLButtonElement).disabled).toBe(true)
  })

  it('renames a saved Mix without touching its Decks', () => {
    const renames: Array<[string, string]> = []
    render(
      screen({
        mixes: [mornings],
        onRenameMix: (id, name) => {
          renames.push([id, name])
        },
      }),
    )
    click(find('rename-mix-m1'))
    typeInto(find('deck-name-input') as HTMLInputElement, 'Evenings')
    click(find('deck-name-save'))

    expect(renames).toEqual([['m1', 'Evenings']])
  })

  it('edits a saved Mix Deck selection, preloading what it already holds', () => {
    const edits: Array<[string, readonly string[]]> = []
    render(
      screen({
        mixes: [mornings],
        onEditMixDecks: (id, deckIds) => {
          edits.push([id, deckIds])
        },
      }),
    )
    click(find('edit-mix-m1'))

    expect(find('deck-chip-home')?.getAttribute('aria-pressed')).toBe('true')
    expect(find('deck-chip-work')?.getAttribute('aria-pressed')).toBe('true')
    expect(find('deck-chip-climbing')?.getAttribute('aria-pressed')).toBe('false')

    click(find('deck-chip-climbing'))
    click(find('save-mix'))

    expect(edits).toEqual([['m1', ['home', 'climbing', 'work']]])
  })

  it('leaves edit mode without saving when the edit is cancelled', () => {
    let edited = false
    render(
      screen({
        mixes: [mornings],
        onEditMixDecks: () => {
          edited = true
        },
      }),
    )
    click(find('edit-mix-m1'))
    click(find('cancel-mix-edit'))

    expect(edited).toBe(false)
    expect(find('cancel-mix-edit')).toBeNull()
    expect(find('deck-chip-home')?.getAttribute('aria-pressed')).toBe('false')
  })

  it('deletes a saved Mix only after a confirming second tap', () => {
    const deleted: string[] = []
    render(
      screen({
        mixes: [mornings],
        onDeleteMix: (id) => {
          deleted.push(id)
        },
      }),
    )
    click(find('delete-mix-m1'))
    expect(deleted).toEqual([])

    click(find('confirm-delete-mix-m1'))
    expect(deleted).toEqual(['m1'])
  })
})

describe('MixSelectScreen — a Deck deleted out from under a saved Mix', () => {
  const mornings: Mix = { id: 'm1', name: 'Mornings', deckIds: ['home', 'gone'] }
  const orphaned: Mix = { id: 'm2', name: 'Orphaned', deckIds: ['gone', 'also-gone'] }

  it('lists the Mix without crashing, counting only the Decks that still exist', () => {
    render(screen({ mixes: [mornings] }))
    expect(find('mix-row-m1')?.textContent).toContain('1 deck · 9 phrases')
  })

  it('still drills a Mix that has lost one of its Decks', () => {
    let started: Mix | undefined
    render(
      screen({
        mixes: [mornings],
        onStartMix: (mix) => {
          started = mix
        },
      }),
    )
    click(find('mix-row-m1'))
    expect(started).toEqual(mornings)
  })

  it('shows a Mix whose every Deck is gone, and refuses to start an empty Drill', () => {
    let started = false
    render(
      screen({
        mixes: [orphaned],
        onStartMix: () => {
          started = true
        },
      }),
    )
    expect(find('mix-row-m2')?.textContent).toContain('Its decks are gone')
    expect((find('mix-row-m2') as HTMLButtonElement).disabled).toBe(true)

    click(find('mix-row-m2'))
    expect(started).toBe(false)
  })

  it('still lists saved Mixes when too few Decks remain to compose a new one', () => {
    render(screen({ decks: [home], mixes: [mornings] }))
    expect(find('mix-row-m1')).not.toBeNull()
    expect(container.textContent).toContain('Add another Deck to mix')
  })

  it('drops the dead id when she edits and re-saves the Mix — the only place it is rewritten', () => {
    const edits: Array<[string, readonly string[]]> = []
    render(
      screen({
        mixes: [mornings],
        onEditMixDecks: (id, deckIds) => {
          edits.push([id, deckIds])
        },
      }),
    )
    click(find('edit-mix-m1'))
    click(find('save-mix'))

    expect(edits).toEqual([['m1', ['home']]])
  })
})
