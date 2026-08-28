import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PassageSheet } from './PassageSheet'

/**
 * React tracks the DOM value it wrote, so a bare `el.value = …` looks like no
 * change at all. Going through the prototype setter is what makes the input
 * event React sees carry the new value — same trick DecksScreen.test.tsx uses,
 * widened here because this sheet's second field is a textarea.
 */
function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
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

function nameField(): HTMLInputElement {
  return testid('passage-sheet-name') as HTMLInputElement
}

function textField(): HTMLTextAreaElement {
  return testid('passage-sheet-text') as HTMLTextAreaElement
}

function save(): void {
  act(() => (testid('passage-sheet-save') as HTMLElement).click())
}

function render(props: {
  onSave?: (name: string, text: string) => void
  onCancel?: () => void
  initialName?: string
  initialText?: string
  title?: string
}): void {
  act(() => {
    root.render(
      <PassageSheet
        title={props.title ?? 'New long form'}
        initialName={props.initialName}
        initialText={props.initialText}
        onSave={props.onSave ?? vi.fn()}
        onCancel={props.onCancel ?? vi.fn()}
      />,
    )
  })
}

describe('PassageSheet', () => {
  it('opens empty for a new long-form entry', () => {
    render({})
    expect(nameField().value).toBe('')
    expect(textField().value).toBe('')
    expect(testid('passage-sheet-error')).toBeNull()
  })

  it('opens on what the user already wrote when it is given both', () => {
    render({ initialName: 'Valéry', initialText: 'Le vent se lève.' })
    expect(nameField().value).toBe('Valéry')
    expect(textField().value).toBe('Le vent se lève.')
  })

  it('saves the name and the text the user typed', () => {
    const onSave = vi.fn()
    render({ onSave })
    act(() => typeInto(nameField(), 'Valéry'))
    act(() => typeInto(textField(), 'Le vent se lève.'))
    save()
    expect(onSave).toHaveBeenCalledWith('Valéry', 'Le vent se lève.')
  })

  /**
   * A page of text keeps its shape — paragraph breaks are how the user reads it
   * back, and `splitPassageIntoLines` cuts on every newline, so the blank
   * lines between paragraphs are structure rather than noise. Only the outer
   * whitespace goes, which is what a paste from Notes or a website leaves
   * behind.
   */
  it('round-trips a multi-paragraph paste, trimming only its outer whitespace', () => {
    const page =
      'Le vent se lève.\n\nIl faut tenter de vivre.\nL’air immense ouvre et referme mon livre.\n\nLa vague en poudre ose jaillir des rocs.'
    const onSave = vi.fn()
    render({ onSave })
    act(() => typeInto(nameField(), '  Le cimetière marin  '))
    act(() => typeInto(textField(), `\n\n  ${page}\n  \n`))
    save()
    expect(onSave).toHaveBeenCalledWith('Le cimetière marin', page)
  })

  it('refuses to save with no name, and says which one is missing', () => {
    const onSave = vi.fn()
    render({ onSave })
    act(() => typeInto(textField(), 'Le vent se lève.'))
    save()

    expect(onSave).not.toHaveBeenCalled()
    expect(testid('passage-sheet-error')?.textContent).toMatch(/name/i)
  })

  it('refuses to save with no text, and says why', () => {
    const onSave = vi.fn()
    render({ onSave })
    act(() => typeInto(nameField(), 'Valéry'))
    save()

    expect(onSave).not.toHaveBeenCalled()
    expect(testid('passage-sheet-error')?.textContent).toMatch(/nothing to read|text/i)
  })

  /**
   * Whitespace-only text is the one that would get through a `length > 0`
   * check and produce a Passage of zero Lines — a saved entry with nothing to
   * play, and nothing on screen to explain it.
   */
  it('refuses whitespace-only text, which would produce no Lines at all', () => {
    const onSave = vi.fn()
    render({ onSave })
    act(() => typeInto(nameField(), 'Valéry'))
    act(() => typeInto(textField(), '   \n\n \t '))
    save()

    expect(onSave).not.toHaveBeenCalled()
    expect(testid('passage-sheet-error')).not.toBeNull()
  })

  it('clears the refusal once the user fills the missing field in, and then saves', () => {
    const onSave = vi.fn()
    render({ onSave })
    save()
    expect(testid('passage-sheet-error')).not.toBeNull()

    act(() => typeInto(nameField(), 'Valéry'))
    act(() => typeInto(textField(), 'Le vent se lève.'))
    expect(testid('passage-sheet-error')).toBeNull()

    save()
    expect(onSave).toHaveBeenCalledWith('Valéry', 'Le vent se lève.')
  })

  it('cancels without saving anything', () => {
    const onSave = vi.fn()
    const onCancel = vi.fn()
    render({ onSave, onCancel })
    act(() => typeInto(nameField(), 'Valéry'))
    act(() => typeInto(textField(), 'Le vent se lève.'))
    act(() => (testid('passage-sheet-cancel') as HTMLElement).click())

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSave).not.toHaveBeenCalled()
  })

  /**
   * The one place in this app that has to accept pages of French typed or
   * pasted on an iPhone whose keyboard may be set to English. Autocorrect
   * would rewrite French words against an English dictionary, and the spell
   * checker would underline every one of them; both are silently destructive
   * or pure noise here, so both are off and sentence capitalisation — which is
   * French orthography too — is the one thing left on. Pinned because losing
   * any of the three costs their text, not just its looks.
   */
  it('turns off autocorrect and spell-check on the text field, and keeps sentence capitalisation', () => {
    render({})
    const text = textField()
    expect(text.getAttribute('autocapitalize')).toBe('sentences')
    expect(text.getAttribute('autocorrect')).toBe('off')
    // The attribute, not the IDL property: jsdom does not implement
    // `spellcheck` on HTMLTextAreaElement, so the property is undefined there
    // whatever the DOM says.
    expect(text.getAttribute('spellcheck')).toBe('false')
  })
})
