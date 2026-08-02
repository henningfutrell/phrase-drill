import { useEffect, useState } from 'react'
import type { Deck, DeckId, DeckStore, Library, PhraseId } from './domain'
import { addPhrase, createDeck, removePhrase, renameDeck, reorderPhrase, updatePhrase } from './domain'
import type { Settings, SettingsStore } from './adapters/storage'
import { backupFilename, parseLibraryFile } from './adapters/storage'
import { shareBackupFile } from './adapters/share/web-share'
import type { SynthClient } from './adapters/audio/eleven-labs-synth-client'
import type { GenerationQueue } from './adapters/audio/generation-queue'
import { FALLBACK_PREVIEW_PHRASE, VOICE_CATALOGUE } from './adapters/audio/voice-catalogue'
import { DecksScreen } from './ui/DecksScreen'
import { DeckDetailScreen } from './ui/DeckDetailScreen'
import { SettingsScreen, type ExportOutcome, type PreviewOutcome, type RestoreFileResult } from './ui/SettingsScreen'

const EMPTY_SETTINGS: Settings = { anthropicApiKey: null, elevenLabsApiKey: null, voice: null }

/**
 * Plays a previewed voice clip. Best-effort: a preview isn't guaranteed on
 * every platform/state (autoplay policy, an unimplemented `Audio` in a
 * headless test environment), and a failed preview is a silent no-op here,
 * not a crash — the outcome the Settings screen actually reports comes from
 * the synth call, not from playback.
 */
function playPreviewClip(bytes: ArrayBuffer, mime: string): void {
  try {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
    const audio = new Audio(url)
    const cleanup = () => URL.revokeObjectURL(url)
    audio.addEventListener('ended', cleanup)
    audio.addEventListener('error', cleanup)
    const playing = audio.play()
    if (playing && typeof playing.catch === 'function') playing.catch(cleanup)
  } catch {
    // See doc comment — playback failure is not this function's problem to raise.
  }
}

/**
 * The fallback for a platform that cannot share files (Web Share Level 2
 * file support is not universal — see adapters/share/web-share.ts). A
 * plain anchor download is the desktop-style pattern docs/design.md §3.6
 * explicitly wants to avoid as the *primary* path, but it is the only
 * available recovery when the share sheet itself is unavailable.
 */
function downloadFile(file: File): void {
  const url = URL.createObjectURL(file)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.name
  anchor.click()
  URL.revokeObjectURL(url)
}

/**
 * Composition root — the only place allowed to import from both `domain/`
 * and `adapters/*` (AGENTS.md). Owns the in-memory Deck list and persists
 * every change through the injected `DeckStore` port; screens themselves
 * only see plain data and callbacks.
 */
function App({
  deckStore,
  settingsStore,
  synthClient,
  generationQueue,
}: {
  deckStore: DeckStore
  settingsStore: SettingsStore
  synthClient: SynthClient
  generationQueue: GenerationQueue
}) {
  const [decks, setDecks] = useState<Deck[] | undefined>(undefined)
  const [selectedDeckId, setSelectedDeckId] = useState<DeckId | undefined>(undefined)
  const [settings, setSettings] = useState<Settings>(EMPTY_SETTINGS)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pendingRestore, setPendingRestore] = useState<Library | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    void deckStore.loadAll().then((loaded) => {
      if (!cancelled) setDecks(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [deckStore])

  useEffect(() => {
    let cancelled = false
    void settingsStore.load().then((loaded) => {
      if (!cancelled) setSettings(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [settingsStore])

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

  async function handleExportBackup(): Promise<ExportOutcome> {
    const library = await deckStore.exportAll()
    const file = new File([JSON.stringify(library, null, 2)], backupFilename(new Date()), {
      type: 'application/json',
    })
    const outcome = await shareBackupFile(file)
    if (outcome === 'unsupported') {
      downloadFile(file)
      return 'downloaded'
    }
    return outcome
  }

  async function handleRestoreFileChosen(file: File): Promise<RestoreFileResult> {
    const text = await file.text()
    const result = parseLibraryFile(text)
    if (!result.ok) return result
    setPendingRestore(result.library)
    return { ok: true }
  }

  function handleConfirmRestore() {
    const library = pendingRestore
    if (!library) return
    setPendingRestore(undefined)
    void deckStore.importAll(library).then(() => deckStore.loadAll()).then((loaded) => {
      setDecks(loaded)
      setSelectedDeckId(undefined)
      setSettingsOpen(false)
    })
  }

  function handleCancelRestore() {
    setPendingRestore(undefined)
  }

  async function handlePreviewVoice(
    voice: { modelId: string; voiceId: string },
    text: string,
    signal: AbortSignal,
  ): Promise<PreviewOutcome> {
    try {
      const result = await synthClient.synthesize(text, 'fr-FR', voice, signal)
      playPreviewClip(result.bytes, 'audio/mpeg')
      return { ok: true }
    } catch (err) {
      if (signal.aborted) return { ok: true }
      const kind = (err as { kind?: string } | undefined)?.kind
      if (kind === 'unauthorized') return { ok: false, reason: 'unauthorized' }
      if (kind === 'quota') return { ok: false, reason: 'quota' }
      return { ok: false, reason: 'network' }
    }
  }

  function handleChooseVoice(voice: { provider: string; modelId: string; voiceId: string }) {
    setSettings((current) => ({ ...current, voice }))
    void settingsStore.setVoice(voice)
  }

  const selectedDeck = (decks ?? []).find((d) => d.id === selectedDeckId)

  function withSelectedDeck(fn: (deck: Deck) => Deck): Deck | undefined {
    if (!selectedDeck) return undefined
    const updated = fn(selectedDeck)
    persist(updated)
    return updated
  }

  /**
   * Eager generation (T019 §3): queue both Clips as soon as a Phrase's text
   * is saved (add or edit). The text has already been persisted by
   * `withSelectedDeck` above by the time this runs — generation is never on
   * the critical path for the save.
   */
  function queuePhraseGeneration(updated: Deck | undefined, phraseId: PhraseId): void {
    const phrase = updated?.phrases.find((p) => p.id === phraseId)
    if (phrase) generationQueue.enqueue(phrase)
  }

  if (decks === undefined) {
    return <main className="screen" />
  }

  if (settingsOpen) {
    const previewText =
      (decks ?? []).flatMap((d) => d.phrases).find((p) => p.french.trim().length > 0)?.french ??
      FALLBACK_PREVIEW_PHRASE

    return (
      <SettingsScreen
        onBack={() => setSettingsOpen(false)}
        anthropicKeyPresent={settings.anthropicApiKey !== null}
        elevenLabsKeyPresent={settings.elevenLabsApiKey !== null}
        voice={settings.voice}
        voices={VOICE_CATALOGUE}
        previewText={previewText}
        onPreviewVoice={handlePreviewVoice}
        onChooseVoice={handleChooseVoice}
        onSaveAnthropicKey={(key) => {
          setSettings((current) => ({ ...current, anthropicApiKey: key }))
          void settingsStore.setAnthropicApiKey(key)
        }}
        onClearAnthropicKey={() => {
          setSettings((current) => ({ ...current, anthropicApiKey: null }))
          void settingsStore.setAnthropicApiKey(null)
        }}
        onSaveElevenLabsKey={(key) => {
          setSettings((current) => ({ ...current, elevenLabsApiKey: key }))
          void settingsStore.setElevenLabsApiKey(key)
        }}
        onClearElevenLabsKey={() => {
          setSettings((current) => ({ ...current, elevenLabsApiKey: null }))
          void settingsStore.setElevenLabsApiKey(null)
        }}
        onExportBackup={handleExportBackup}
        onRestoreFileChosen={handleRestoreFileChosen}
        onConfirmRestore={handleConfirmRestore}
        onCancelRestore={handleCancelRestore}
      />
    )
  }

  if (selectedDeck) {
    return (
      <DeckDetailScreen
        deck={selectedDeck}
        onBack={() => setSelectedDeckId(undefined)}
        onRenameDeck={(name) => handleRenameDeck(selectedDeck.id, name)}
        onDeleteDeck={() => handleDeleteDeck(selectedDeck.id)}
        onAddPhrase={(french, english) => {
          const id = crypto.randomUUID()
          const updated = withSelectedDeck((deck) => addPhrase(deck, { id, french, english }))
          queuePhraseGeneration(updated, id)
        }}
        onUpdatePhrase={(id: PhraseId, fields) => {
          const updated = withSelectedDeck((deck) => updatePhrase(deck, id, fields))
          queuePhraseGeneration(updated, id)
        }}
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
      onOpenSettings={() => setSettingsOpen(true)}
    />
  )
}

export default App
