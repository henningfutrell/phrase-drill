import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PhraseSheet } from './PhraseSheet'
import type { Deck, PhraseCandidate, Translator } from '../domain'

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function click(el: Element): void {
  ;(el as HTMLElement).click()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function fakeTranslator(): Translator & { translate: ReturnType<typeof vi.fn> } {
  const translate = vi.fn<Translator['translate']>()
  return { translate }
}

const decks: Deck[] = [
  { id: 'd1', name: 'Home', phrases: [] },
  { id: 'd2', name: 'Formal', phrases: [] },
]

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

async function advanceDebounce(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(600)
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('PhraseSheet — mode without a translator (edit sheet, and Add when unwired)', () => {
  it('behaves exactly as a plain manual French/English sheet when translator is omitted', () => {
    const onSave = vi.fn()
    act(() => {
      root.render(<PhraseSheet onSave={onSave} onCancel={vi.fn()} />)
    })
    expect(container.querySelector('[data-testid="translate-status"]')).toBeNull()
    expect(container.querySelector('[data-testid="add-candidates"]')).toBeNull()

    const french = container.querySelector('[data-testid="phrase-french-input"]') as HTMLInputElement
    const english = container.querySelector('[data-testid="phrase-english-input"]') as HTMLInputElement
    act(() => typeInto(french, 'Salut'))
    act(() => typeInto(english, 'Hi'))
    act(() => click(container.querySelector('[data-testid="phrase-save"]')!))
    expect(onSave).toHaveBeenCalledWith('Salut', 'Hi')
  })

  it('pre-fills from initialFrench/initialEnglish, unaffected by the new props', () => {
    act(() => {
      root.render(<PhraseSheet initialFrench="Bonjour" initialEnglish="Hello" onSave={vi.fn()} onCancel={vi.fn()} />)
    })
    const french = container.querySelector('[data-testid="phrase-french-input"]') as HTMLInputElement
    const english = container.querySelector('[data-testid="phrase-english-input"]') as HTMLInputElement
    expect(french.value).toBe('Bonjour')
    expect(english.value).toBe('Hello')
  })
})

describe('PhraseSheet — EN to FR candidates', () => {
  it('offers a register-labelled checklist after typing English and pausing', async () => {
    const translator = fakeTranslator()
    const { promise, resolve } = deferred<PhraseCandidate[]>()
    translator.translate.mockReturnValue(promise)
    act(() => {
      root.render(
        <PhraseSheet
          onSave={vi.fn()}
          onCancel={vi.fn()}
          deckName="friends"
          decks={decks}
          currentDeckId="d1"
          translator={translator}
          onAddCandidates={vi.fn()}
        />,
      )
    })
    const english = container.querySelector('[data-testid="phrase-english-input"]') as HTMLInputElement
    act(() => typeInto(english, 'Can you come?'))
    await advanceDebounce()

    expect(translator.translate).toHaveBeenCalledWith('Can you come?', 'en-to-fr', 'friends')
    expect(container.querySelector('[data-testid="translate-status"]')).not.toBeNull()

    await act(async () => {
      resolve([
        { text: 'Tu peux venir?', register: 'tu' },
        { text: 'Pouvez-vous venir?', register: 'vous' },
      ])
      await promise
    })

    expect(container.querySelector('[data-testid="candidate-row-0"]')!.textContent).toContain('Tu peux venir?')
    expect(container.querySelector('[data-testid="candidate-register-0"]')!.textContent).toBe('tu')
    expect(container.querySelector('[data-testid="candidate-row-1"]')!.textContent).toContain('Pouvez-vous venir?')
    expect(container.querySelector('[data-testid="candidate-register-1"]')!.textContent).toBe('vous')
  })

  it('renders one unlabelled candidate, without a register badge, when only one natural rendering exists', async () => {
    const translator = fakeTranslator()
    translator.translate.mockResolvedValue([{ text: 'Bonjour' }])
    act(() => {
      root.render(
        <PhraseSheet
          onSave={vi.fn()}
          onCancel={vi.fn()}
          deckName="home"
          decks={decks}
          currentDeckId="d1"
          translator={translator}
          onAddCandidates={vi.fn()}
        />,
      )
    })
    const english = container.querySelector('[data-testid="phrase-english-input"]') as HTMLInputElement
    act(() => typeInto(english, 'Hello'))
    await advanceDebounce()

    expect(container.querySelector('[data-testid="candidate-row-0"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="candidate-register-0"]')).toBeNull()
  })

  it('accepts a selection of candidates into their chosen decks, leaving unselected ones out — nothing saved unseen', async () => {
    const translator = fakeTranslator()
    translator.translate.mockResolvedValue([
      { text: 'Tu peux venir?', register: 'tu' },
      { text: 'Pouvez-vous venir?', register: 'vous' },
    ])
    const onAddCandidates = vi.fn()
    act(() => {
      root.render(
        <PhraseSheet
          onSave={vi.fn()}
          onCancel={vi.fn()}
          deckName="friends"
          decks={decks}
          currentDeckId="d1"
          translator={translator}
          onAddCandidates={onAddCandidates}
        />,
      )
    })
    const english = container.querySelector('[data-testid="phrase-english-input"]') as HTMLInputElement
    act(() => typeInto(english, 'Can you come?'))
    await advanceDebounce()

    act(() => click(container.querySelector('[data-testid="candidate-checkbox-0"]')!))
    act(() => click(container.querySelector('[data-testid="candidate-checkbox-1"]')!))
    const deckSelect1 = container.querySelector('[data-testid="candidate-deck-1"]') as HTMLSelectElement
    act(() => {
      deckSelect1.value = 'd2'
      deckSelect1.dispatchEvent(new Event('change', { bubbles: true }))
    })

    act(() => click(container.querySelector('[data-testid="add-candidates"]')!))
    expect(onAddCandidates).toHaveBeenCalledWith([
      { french: 'Tu peux venir?', english: 'Can you come?', deckId: 'd1' },
      { french: 'Pouvez-vous venir?', english: 'Can you come?', deckId: 'd2' },
    ])
  })

  it('defaults every candidate to the current Deck, never forcing a choice before Add is usable', async () => {
    const translator = fakeTranslator()
    translator.translate.mockResolvedValue([{ text: 'Bonjour', register: '' } as PhraseCandidate])
    act(() => {
      root.render(
        <PhraseSheet
          onSave={vi.fn()}
          onCancel={vi.fn()}
          deckName="home"
          decks={decks}
          currentDeckId="d1"
          translator={translator}
          onAddCandidates={vi.fn()}
        />,
      )
    })
    const english = container.querySelector('[data-testid="phrase-english-input"]') as HTMLInputElement
    act(() => typeInto(english, 'Hello'))
    await advanceDebounce()

    const deckSelect = container.querySelector('[data-testid="candidate-deck-0"]') as HTMLSelectElement
    expect(deckSelect.value).toBe('d1')
  })

  it('picking none — leaving every checkbox unchecked — still saves through the plain manual path', async () => {
    const translator = fakeTranslator()
    translator.translate.mockResolvedValue([{ text: 'Bonjour' }])
    const onSave = vi.fn()
    act(() => {
      root.render(
        <PhraseSheet
          onSave={onSave}
          onCancel={vi.fn()}
          deckName="home"
          decks={decks}
          currentDeckId="d1"
          translator={translator}
          onAddCandidates={vi.fn()}
        />,
      )
    })
    const french = container.querySelector('[data-testid="phrase-french-input"]') as HTMLInputElement
    const english = container.querySelector('[data-testid="phrase-english-input"]') as HTMLInputElement
    act(() => typeInto(english, 'Hello'))
    await advanceDebounce()
    act(() => typeInto(french, 'Salut'))
    act(() => click(container.querySelector('[data-testid="phrase-save"]')!))
    expect(onSave).toHaveBeenCalledWith('Salut', 'Hello')
  })

  it('a failed translate never blocks the plain manual Save', async () => {
    const translator = fakeTranslator()
    translator.translate.mockRejectedValue({ kind: 'network', detail: 'offline' })
    const onSave = vi.fn()
    act(() => {
      root.render(
        <PhraseSheet
          onSave={onSave}
          onCancel={vi.fn()}
          deckName="home"
          decks={decks}
          currentDeckId="d1"
          translator={translator}
          onAddCandidates={vi.fn()}
        />,
      )
    })
    const french = container.querySelector('[data-testid="phrase-french-input"]') as HTMLInputElement
    const english = container.querySelector('[data-testid="phrase-english-input"]') as HTMLInputElement
    act(() => typeInto(english, 'Hello'))
    await advanceDebounce()

    expect(container.querySelector('[data-testid="translate-error"]')).not.toBeNull()

    act(() => typeInto(french, 'Salut'))
    act(() => click(container.querySelector('[data-testid="phrase-save"]')!))
    expect(onSave).toHaveBeenCalledWith('Salut', 'Hello')
  })
})

describe('PhraseSheet — FR to EN suggestion', () => {
  it('auto-fills the single English suggestion, marked as suggested', async () => {
    const translator = fakeTranslator()
    translator.translate.mockResolvedValue([{ text: 'Hello' }])
    act(() => {
      root.render(
        <PhraseSheet
          onSave={vi.fn()}
          onCancel={vi.fn()}
          deckName="home"
          decks={decks}
          currentDeckId="d1"
          translator={translator}
          onAddCandidates={vi.fn()}
        />,
      )
    })
    const french = container.querySelector('[data-testid="phrase-french-input"]') as HTMLInputElement
    act(() => typeInto(french, 'Bonjour'))
    await advanceDebounce()

    expect(translator.translate).toHaveBeenCalledWith('Bonjour', 'fr-to-en', 'home')
    const english = container.querySelector('[data-testid="phrase-english-input"]') as HTMLInputElement
    expect(english.value).toBe('Hello')
    expect(container.querySelector('[data-testid="suggested-badge"]')).not.toBeNull()
  })

  it('clears the suggested marker the moment she edits the English field', async () => {
    const translator = fakeTranslator()
    translator.translate.mockResolvedValue([{ text: 'Hello' }])
    act(() => {
      root.render(
        <PhraseSheet
          onSave={vi.fn()}
          onCancel={vi.fn()}
          deckName="home"
          decks={decks}
          currentDeckId="d1"
          translator={translator}
          onAddCandidates={vi.fn()}
        />,
      )
    })
    const french = container.querySelector('[data-testid="phrase-french-input"]') as HTMLInputElement
    act(() => typeInto(french, 'Bonjour'))
    await advanceDebounce()
    expect(container.querySelector('[data-testid="suggested-badge"]')).not.toBeNull()

    const english = container.querySelector('[data-testid="phrase-english-input"]') as HTMLInputElement
    act(() => typeInto(english, 'Hello there'))
    expect(container.querySelector('[data-testid="suggested-badge"]')).toBeNull()
  })

  it('never overwrites English she already typed herself', async () => {
    const translator = fakeTranslator()
    act(() => {
      root.render(
        <PhraseSheet
          onSave={vi.fn()}
          onCancel={vi.fn()}
          deckName="home"
          decks={decks}
          currentDeckId="d1"
          translator={translator}
          onAddCandidates={vi.fn()}
        />,
      )
    })
    const french = container.querySelector('[data-testid="phrase-french-input"]') as HTMLInputElement
    const english = container.querySelector('[data-testid="phrase-english-input"]') as HTMLInputElement
    act(() => typeInto(english, 'Hi there'))
    act(() => typeInto(french, 'Salut'))
    await advanceDebounce()
    // French changed while English already held her own text — reverse
    // suggestion never fires and never clobbers it.
    expect(english.value).toBe('Hi there')
  })
})
