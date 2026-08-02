import { useEffect, useState } from 'react'
import type { Deck, DeckId, DeckStore, PhraseId } from './domain'
import { addPhrase, createDeck, removePhrase, renameDeck, reorderPhrase, updatePhrase } from './domain'
import { DecksScreen } from './ui/DecksScreen'
import { DeckDetailScreen } from './ui/DeckDetailScreen'

/**
 * Composition root — the only place allowed to import from both `domain/`
 * and `adapters/*` (AGENTS.md). Owns the in-memory Deck list and persists
 * every change through the injected `DeckStore` port; screens themselves
 * only see plain data and callbacks.
 */
function App({ deckStore }: { deckStore: DeckStore }) {
  const [decks, setDecks] = useState<Deck[] | undefined>(undefined)
  const [selectedDeckId, setSelectedDeckId] = useState<DeckId | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    void deckStore.loadAll().then((loaded) => {
      if (!cancelled) setDecks(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [deckStore])

  function persist(deck: Deck) {
    setDecks((current) => (current ?? []).map((d) => (d.id === deck.id ? deck : d)))
    void deckStore.save(deck)
  }

  function handleCreateDeck(name: string) {
    const deck = createDeck(crypto.randomUUID(), name)
    setDecks((current) => [...(current ?? []), deck])
    void deckStore.save(deck)
  }

  function handleRenameDeck(id: DeckId, name: string) {
    const deck = (decks ?? []).find((d) => d.id === id)
    if (!deck) return
    persist(renameDeck(deck, name))
  }

  function handleDeleteDeck(id: DeckId) {
    setDecks((current) => (current ?? []).filter((d) => d.id !== id))
    void deckStore.remove(id)
    if (selectedDeckId === id) setSelectedDeckId(undefined)
  }

  const selectedDeck = (decks ?? []).find((d) => d.id === selectedDeckId)

  function withSelectedDeck(fn: (deck: Deck) => Deck) {
    if (!selectedDeck) return
    persist(fn(selectedDeck))
  }

  if (decks === undefined) {
    return <main className="screen" />
  }

  if (selectedDeck) {
    return (
      <DeckDetailScreen
        deck={selectedDeck}
        onBack={() => setSelectedDeckId(undefined)}
        onRenameDeck={(name) => handleRenameDeck(selectedDeck.id, name)}
        onDeleteDeck={() => handleDeleteDeck(selectedDeck.id)}
        onAddPhrase={(french, english) =>
          withSelectedDeck((deck) => addPhrase(deck, { id: crypto.randomUUID(), french, english }))
        }
        onUpdatePhrase={(id: PhraseId, fields) =>
          withSelectedDeck((deck) => updatePhrase(deck, id, fields))
        }
        onDeletePhrase={(id: PhraseId) => withSelectedDeck((deck) => removePhrase(deck, id))}
        onMovePhraseUp={(id: PhraseId) =>
          withSelectedDeck((deck) => {
            const index = deck.phrases.findIndex((p) => p.id === id)
            return index <= 0 ? deck : reorderPhrase(deck, index, index - 1)
          })
        }
        onMovePhraseDown={(id: PhraseId) =>
          withSelectedDeck((deck) => {
            const index = deck.phrases.findIndex((p) => p.id === id)
            return index === -1 || index >= deck.phrases.length - 1
              ? deck
              : reorderPhrase(deck, index, index + 1)
          })
        }
      />
    )
  }

  return (
    <DecksScreen
      decks={decks}
      onCreateDeck={handleCreateDeck}
      onRenameDeck={handleRenameDeck}
      onDeleteDeck={handleDeleteDeck}
      onOpenDeck={setSelectedDeckId}
    />
  )
}

export default App
