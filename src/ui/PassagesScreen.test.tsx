import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PassagesScreen } from './PassagesScreen'
import type { Passage } from '../domain'

function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Two sentences and a newline — three Lines, and the count the row must show. */
const marin: Passage = {
  id: 'g1',
  name: 'Le cimetière marin',
  text: 'Le vent se lève.\nIl faut tenter de vivre. La mer, toujours recommencée.',
}
const chien: Passage = {
  id: 'g2',
  name: 'Un temps de chien',
  text: 'Il faisait un temps de chien.',
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

function testid(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`)
}

function click(id: string): void {
  const el = testid(id)
  if (!el) throw new Error(`no element with data-testid="${id}"`)
  act(() => el.click())
}

function render(props: {
  passages?: readonly Passage[]
  onBack?: () => void
  onCreatePassage?: (name: string, text: string) => void
  onUpdatePassage?: (id: string, name: string, text: string) => void
  onDeletePassage?: (id: string) => void
  onDrillPassage?: (passage: Passage) => void
}): void {
  act(() => {
    root.render(
      <PassagesScreen
        passages={props.passages ?? [marin, chien]}
        onBack={props.onBack ?? vi.fn()}
        onCreatePassage={props.onCreatePassage ?? vi.fn()}
        onUpdatePassage={props.onUpdatePassage ?? vi.fn()}
        onDeletePassage={props.onDeletePassage ?? vi.fn()}
        onDrillPassage={props.onDrillPassage ?? vi.fn()}
      />,
    )
  })
}

describe('PassagesScreen', () => {
  it('is titled Long form — their own words for it', () => {
    render({})
    expect(testid('passages-screen')?.textContent).toContain('Long form')
  })

  it('renders one row per long-form entry, with its name', () => {
    render({})
    expect(testid('passage-name-g1')?.textContent).toBe('Le cimetière marin')
    expect(testid('passage-name-g2')?.textContent).toBe('Un temps de chien')
    expect(testid('passage-row-g1')).not.toBeNull()
  })

  /**
   * The glanceable size, and the only number on this screen. It is the Line
   * count because that is exactly how many pieces the Drill will play — a
   * count of what will be spoken, not a measure of how the user is doing. Nothing
   * here says practised, due, or complete (PRODUCT.md).
   */
  it('states each entry’s Line count, so a paragraph is distinguishable from a page unopened', () => {
    render({})
    expect(testid('passage-lines-g1')?.textContent).toBe('3 lines')
    expect(testid('passage-lines-g2')?.textContent).toBe('1 line')
  })

  it('never puts the body text in the row — a page of text is not a list row', () => {
    render({})
    expect(testid('passage-row-g1')?.textContent).not.toContain('Le vent se lève')
  })

  it('starts a Drill on the entry the user tapped', () => {
    const onDrillPassage = vi.fn()
    render({ onDrillPassage })
    click('passage-drill-g2')
    expect(onDrillPassage).toHaveBeenCalledWith(chien)
  })

  it('refuses to drill an entry with nothing in it to speak', () => {
    // Reachable through sync, not through the sheet: the sheet will not save
    // blank text. Starting a Drill on zero Lines would land on the readiness
    // gate's "audio isn't ready yet", which is not what happened.
    render({ passages: [{ id: 'g3', name: 'Vide', text: '   ' }] })
    expect(testid('passage-lines-g3')?.textContent).toBe('Nothing to read yet')
    expect((testid('passage-drill-g3') as HTMLButtonElement).disabled).toBe(true)
  })

  it('goes back to Decks', () => {
    const onBack = vi.fn()
    render({ onBack })
    click('passages-back')
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('says what a long-form entry is for when there are none, and offers to add one', () => {
    render({ passages: [] })
    const empty = testid('passages-empty')
    expect(empty).not.toBeNull()
    expect(empty?.textContent).toMatch(/read aloud|read it aloud/i)
    expect(testid('passage-new')).not.toBeNull()
  })

  it('shows no empty state once the user has one', () => {
    render({ passages: [chien] })
    expect(testid('passages-empty')).toBeNull()
  })

  it('opens an empty sheet from New', () => {
    render({})
    expect(testid('passage-sheet')).toBeNull()
    click('passage-new')
    expect((testid('passage-sheet-name') as HTMLInputElement).value).toBe('')
    expect((testid('passage-sheet-text') as HTMLTextAreaElement).value).toBe('')
  })

  it('creates a long-form entry from the New sheet, trimmed', () => {
    const onCreatePassage = vi.fn()
    render({ onCreatePassage })
    click('passage-new')
    act(() => typeInto(testid('passage-sheet-name') as HTMLInputElement, '  Valéry  '))
    act(() =>
      typeInto(testid('passage-sheet-text') as HTMLTextAreaElement, '\n Le vent se lève. \n'),
    )
    click('passage-sheet-save')

    expect(onCreatePassage).toHaveBeenCalledWith('Valéry', 'Le vent se lève.')
    expect(testid('passage-sheet')).toBeNull()
  })

  it('opens the sheet on what the user wrote when the user edits, text and all', () => {
    render({})
    click('passage-edit-g1')
    expect((testid('passage-sheet-name') as HTMLInputElement).value).toBe('Le cimetière marin')
    expect((testid('passage-sheet-text') as HTMLTextAreaElement).value).toBe(marin.text)
  })

  it('updates the entry the user was editing, trimmed', () => {
    const onUpdatePassage = vi.fn()
    render({ onUpdatePassage })
    click('passage-edit-g2')
    act(() => typeInto(testid('passage-sheet-name') as HTMLInputElement, 'Le chien  '))
    act(() => typeInto(testid('passage-sheet-text') as HTMLTextAreaElement, ' Quel temps.  '))
    click('passage-sheet-save')

    expect(onUpdatePassage).toHaveBeenCalledWith('g2', 'Le chien', 'Quel temps.')
  })

  it('closes the sheet on Cancel without touching anything', () => {
    const onCreatePassage = vi.fn()
    const onUpdatePassage = vi.fn()
    render({ onCreatePassage, onUpdatePassage })
    click('passage-edit-g1')
    click('passage-sheet-cancel')

    expect(testid('passage-sheet')).toBeNull()
    expect(onCreatePassage).not.toHaveBeenCalled()
    expect(onUpdatePassage).not.toHaveBeenCalled()
  })

  /**
   * A page the user typed is not recoverable from inside the app, so deleting one
   * never happens on a single tap — the same two-step the Decks screen uses,
   * for the same reason.
   */
  it('deletes an entry only after the confirmation is tapped', () => {
    const onDeletePassage = vi.fn()
    render({ onDeletePassage })
    expect(testid('passage-delete-confirm-g1')).toBeNull()

    click('passage-delete-g1')
    expect(onDeletePassage).not.toHaveBeenCalled()

    click('passage-delete-confirm-g1')
    expect(onDeletePassage).toHaveBeenCalledWith('g1')
  })

  it('arms the confirmation on one row only', () => {
    render({})
    click('passage-delete-g1')
    expect(testid('passage-delete-confirm-g1')).not.toBeNull()
    expect(testid('passage-delete-confirm-g2')).toBeNull()
    expect(testid('passage-delete-g2')).not.toBeNull()
  })
})
