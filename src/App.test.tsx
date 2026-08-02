import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from './App'
import type { Deck, DeckStore, Library } from './domain'
import { LIBRARY_FORMAT } from './domain'

/** In-memory DeckStore fake — the real DeckStore is exercised in
 * src/adapters/storage; this fake only lets App's wiring to the port be
 * asserted without a browser IndexedDB. */
function createFakeDeckStore(initial: readonly Deck[] = []): DeckStore & { decks: Map<string, Deck> } {
  const decks = new Map(initial.map((d) => [d.id, d]))
  return {
    decks,
    async loadAll() {
      return [...decks.values()]
    },
    async get(id) {
      return decks.get(id)
    },
    async save(deck) {
      decks.set(deck.id, deck)
    },
    async remove(id) {
      decks.delete(id)
    },
    async exportAll(): Promise<Library> {
      return { format: LIBRARY_FORMAT, schemaVersion: 1, exportedAt: 0, decks: [] }
    },
    async importAll() {},
  }
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function click(el: Element): void {
  ;(el as HTMLElement).click()
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

async function renderApp(store: DeckStore) {
  await act(async () => {
    root.render(<App deckStore={store} />)
  })
}

describe('App wired to DeckStore', () => {
  it('loads Decks from the store on mount and renders them', async () => {
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    await renderApp(store)
    expect(container.textContent).toContain('Home')
  })

  it('creating a Deck persists it through DeckStore.save', async () => {
    const store = createFakeDeckStore([])
    await renderApp(store)
    act(() => click(container.querySelector('[data-testid="new-deck"]')!))
    const input = container.querySelector('[data-testid="deck-name-input"]') as HTMLInputElement
    act(() => typeInto(input, 'Work'))
    await act(async () => click(container.querySelector('[data-testid="deck-name-save"]')!))

    expect(store.decks.size).toBe(1)
    const saved = [...store.decks.values()][0]
    expect(saved.name).toBe('Work')
    expect(saved.phrases).toEqual([])
    expect(typeof saved.id).toBe('string')
    expect(saved.id.length).toBeGreaterThan(0)
  })

  it('opens a Deck and adds a Phrase, persisting the whole Deck through save', async () => {
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    await renderApp(store)
    act(() => click(container.querySelector('[data-testid="deck-row-d1"]')!))
    act(() => click(container.querySelector('[data-testid="add-phrase"]')!))
    const french = container.querySelector('[data-testid="phrase-french-input"]') as HTMLInputElement
    const english = container.querySelector('[data-testid="phrase-english-input"]') as HTMLInputElement
    act(() => typeInto(french, 'Bonjour'))
    act(() => typeInto(english, 'Hello'))
    await act(async () => click(container.querySelector('[data-testid="phrase-save"]')!))

    const saved = store.decks.get('d1')!
    expect(saved.phrases).toHaveLength(1)
    expect(saved.phrases[0]).toMatchObject({ french: 'Bonjour', english: 'Hello' })
  })

  it('reordering a Phrase persists the new order through save', async () => {
    const store = createFakeDeckStore([
      {
        id: 'd1',
        name: 'Home',
        phrases: [
          { id: 'p1', french: 'a', english: 'a' },
          { id: 'p2', french: 'b', english: 'b' },
        ],
      },
    ])
    await renderApp(store)
    act(() => click(container.querySelector('[data-testid="deck-row-d1"]')!))
    await act(async () => click(container.querySelector('[data-testid="move-down-p1"]')!))

    const saved = store.decks.get('d1')!
    expect(saved.phrases.map((p) => p.id)).toEqual(['p2', 'p1'])
  })

  it('deleting a Deck removes it through DeckStore.remove and returns to the list', async () => {
    const store = createFakeDeckStore([{ id: 'd1', name: 'Home', phrases: [] }])
    await renderApp(store)
    act(() => click(container.querySelector('[data-testid="deck-row-d1"]')!))
    act(() => click(container.querySelector('[data-testid="delete-deck"]')!))
    await act(async () => click(container.querySelector('[data-testid="confirm-delete-deck"]')!))

    expect(store.decks.has('d1')).toBe(false)
    expect(container.querySelector('[data-testid="deck-row-d1"]')).toBeNull()
  })
})
