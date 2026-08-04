import { useEffect, useMemo, useState } from 'react'
import type {
  Deck,
  DeckId,
  DeckStore,
  DraftPhrase,
  Library,
  Mix,
  MixId,
  MixStore,
  Phrase,
  PhraseId,
  ScanReader,
  SpeechPort,
  Translator,
} from './domain'
import {
  addPhrase,
  createDeck,
  createMix,
  removePhrase,
  renameDeck,
  renameMix,
  reorderPhrase,
  resolveMixPhrases,
  setMixDecks,
  updatePhrase,
} from './domain'
import type { ClipCache, Settings, SettingsStore } from './adapters/storage'
import { backupFilename, parseLibraryFile } from './adapters/storage'
import type { ErrorLog } from './adapters/diagnostics'
import { collectDiagnostics, copyText, formatDiagnosticsReport, getBuildInfo, getStorageEstimate } from './adapters/diagnostics'
import { shareBackupFile } from './adapters/share/web-share'
import type { SynthClient } from './adapters/audio/server-synth-client'
import type { GenerationQueue } from './adapters/audio/generation-queue'
import type { SyncEngine, SyncSnapshot } from './adapters/sync/sync-engine'
import { syncStatusText } from './ui/sync-status-text'
import { FALLBACK_PREVIEW_PHRASE, VOICE_CATALOGUE } from './adapters/audio/voice-catalogue'
import { createClipPlayer } from './adapters/audio/clip-player'
import { computeDrillReadiness } from './adapters/audio/drill-readiness'
import { createSystemClock } from './adapters/audio/system-clock'
import { createWakeLockPort } from './adapters/device/wake-lock'
import { DecksScreen } from './ui/DecksScreen'
import { DeckDetailScreen } from './ui/DeckDetailScreen'
import { MixSelectScreen } from './ui/MixSelectScreen'
import { ImportScreen, type ImportTarget } from './ui/ImportScreen'
import { DrillScreen, type DrillReadinessResult } from './ui/DrillScreen'
import { SettingsScreen, type ExportOutcome, type PreviewOutcome, type RestoreFileResult } from './ui/SettingsScreen'
import { DiagnosticsScreen } from './ui/DiagnosticsScreen'

const EMPTY_SETTINGS: Settings = {
  voice: null,
  backupNudgeDismissed: false,
  lastSyncAt: null,
}

/**
 * Stands in for the DrillScreen's required `speech` prop while no voice is
 * pinned (the 'no-voice' blocked phase — DrillScreen never actually calls
 * `speak()` there, since Start is unreachable, but the prop is required).
 */
const NOOP_SPEECH: SpeechPort = {
  async speak() {},
  cancel() {},
}

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
  mixStore,
  settingsStore,
  synthClient,
  generationQueue,
  clipCache,
  scanReader,
  errorLog,
  syncEngine,
  translator,
}: {
  deckStore: DeckStore
  mixStore: MixStore
  settingsStore: SettingsStore
  synthClient: SynthClient
  generationQueue: GenerationQueue
  clipCache: ClipCache
  scanReader: ScanReader
  errorLog: ErrorLog
  syncEngine: SyncEngine
  translator: Translator
}) {
  const [decks, setDecks] = useState<Deck[] | undefined>(undefined)
  const [mixes, setMixes] = useState<Mix[]>([])
  const [selectedDeckId, setSelectedDeckId] = useState<DeckId | undefined>(undefined)
  const [settings, setSettings] = useState<Settings>(EMPTY_SETTINGS)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [diagnosticsReport, setDiagnosticsReport] = useState<string | undefined>(undefined)
  const [pendingRestore, setPendingRestore] = useState<Library | undefined>(undefined)
  const [mixOpen, setMixOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [drillTarget, setDrillTarget] = useState<
    { title: string; phrases: readonly Phrase[] } | undefined
  >(undefined)

  // One Wake Lock port for the app's lifetime (T006 carried obligation:
  // hold the screen on for a Drill's duration). Stateless, so a single
  // instance is fine to reuse across every Drill. `useMemo`, not `useRef`:
  // its value is read during render (passed straight into DrillScreen
  // props), and a ref must never be read there (react-hooks/refs).
  const wakeLock = useMemo(() => createWakeLockPort(), [])
  // One ClockPort for the app's lifetime — also stateless.
  const systemClock = useMemo(() => createSystemClock(), [])
  // Rebuilt only when the pinned voice actually changes (`settings.voice`
  // is only ever replaced, never mutated), so the same `<audio>` element
  // keeps serving unlock() and every real Clip across Drills run under the
  // same voice (T023's unlock-persists assumption — unverified on real iOS
  // Safari, confirmed only in T013).
  const clipPlayer = useMemo(
    () => (settings.voice ? createClipPlayer({ element: new Audio(), clipCache, voice: settings.voice }) : null),
    [settings.voice, clipCache],
  )

  const [sync, setSync] = useState<SyncSnapshot>(() => syncEngine.snapshot())

  useEffect(() => {
    let cancelled = false
    // Local first, always: what is on this device is shown without waiting
    // for a network round-trip that may never answer.
    void Promise.all([deckStore.loadAll(), mixStore.loadAll()]).then(([loadedDecks, loadedMixes]) => {
      if (cancelled) return
      setDecks(loadedDecks)
      setMixes(loadedMixes)
    })
    return () => {
      cancelled = true
    }
  }, [deckStore, mixStore])

  // Sync runs itself (T034): the engine syncs at launch, after every change
  // (debounced), on reconnect, and when the app is backgrounded. Nothing here
  // decides when — this only starts it and listens.
  useEffect(() => {
    const unsubscribe = syncEngine.subscribe(setSync)
    syncEngine.start()
    return () => {
      unsubscribe()
      syncEngine.stop()
    }
  }, [syncEngine])

  // A merge replaced the local library with one holding another device's
  // work, so what is on screen is now stale. Re-read both stores; `revision`
  // changes only when that actually happened, never on an ordinary sync.
  const revision = sync.libraryRevision
  useEffect(() => {
    if (revision === 0) return
    let cancelled = false
    void Promise.all([deckStore.loadAll(), mixStore.loadAll()]).then(([loadedDecks, loadedMixes]) => {
      if (cancelled) return
      setDecks(loadedDecks)
      setMixes(loadedMixes)
    })
    return () => {
      cancelled = true
    }
  }, [revision, deckStore, mixStore])

  useEffect(() => {
    let cancelled = false
    void settingsStore.load().then((loaded) => {
      if (!cancelled) setSettings(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [settingsStore])

  /** Whole-Deck upsert into local state and the store — an unknown id is a
   * newly-created Deck (Import's "New Deck…" path shares this with
   * `handleCreateDeck`), a known id replaces in place. */
  function persist(deck: Deck) {
    setDecks((current) => {
      const list = current ?? []
      return list.some((d) => d.id === deck.id) ? list.map((d) => (d.id === deck.id ? deck : d)) : [...list, deck]
    })
    void deckStore.save(deck).then(() => syncToServer())
  }

  /**
   * Tell the engine something changed. Debounced and coalesced there, so a
   * burst of edits is one round-trip; never awaited here, because a local
   * save must never be gated on the network. Every rule about what a sync is
   * allowed to do lives in `adapters/sync/sync-engine.ts`, not here.
   */
  function syncToServer(): void {
    syncEngine.requestSync()
  }

  function handleCreateDeck(name: string) {
    persist(createDeck(crypto.randomUUID(), name))
  }

  function handleRenameDeck(id: DeckId, name: string) {
    const deck = (decks ?? []).find((d) => d.id === id)
    if (!deck) return
    persist(renameDeck(deck, name))
  }

  /** Whole-Mix upsert into local state and the store, same shape as `persist`. */
  function persistMix(mix: Mix) {
    setMixes((current) =>
      current.some((m) => m.id === mix.id) ? current.map((m) => (m.id === mix.id ? mix : m)) : [...current, mix],
    )
    void mixStore.save(mix).then(() => syncToServer())
  }

  function handleSaveMix(name: string, deckIds: readonly DeckId[]) {
    persistMix(createMix(crypto.randomUUID(), name, deckIds))
  }

  function handleRenameMix(id: MixId, name: string) {
    const mix = mixes.find((m) => m.id === id)
    if (!mix) return
    persistMix(renameMix(mix, name))
  }

  function handleEditMixDecks(id: MixId, deckIds: readonly DeckId[]) {
    const mix = mixes.find((m) => m.id === id)
    if (!mix) return
    persistMix(setMixDecks(mix, deckIds))
  }

  /**
   * Deleting a Mix reaches the `mixes` store and nothing else — the Decks
   * it named are untouched, here and in the adapter (they are separate
   * stores, so it is structural, not a promise).
   */
  function handleDeleteMix(id: MixId) {
    setMixes((current) => current.filter((m) => m.id !== id))
    void mixStore.remove(id).then(() => syncToServer())
  }

  function handleDeleteDeck(id: DeckId) {
    setDecks((current) => (current ?? []).filter((d) => d.id !== id))
    void deckStore.remove(id).then(() => syncToServer())
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
    void deckStore
      .importAll(library)
      .then(() => Promise.all([deckStore.loadAll(), mixStore.loadAll()]))
      .then(([loadedDecks, loadedMixes]) => {
        // A restore replaces the whole library, saved Mixes included — read
        // both back so the screens show what is actually stored, not what
        // was stored a moment ago.
        setDecks(loadedDecks)
        setMixes(loadedMixes)
        setSelectedDeckId(undefined)
        setSettingsOpen(false)
        syncToServer()
      })
  }

  function handleCancelRestore() {
    setPendingRestore(undefined)
  }

  async function handlePreviewVoice(
    voice: { provider: string; modelId: string; voiceId: string },
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

  /**
   * The first-run backup nudge (docs/design.md §3.6, T027) — one flag,
   * dismissed once from wherever it's shown (Decks empty state or after a
   * successful Scan), never shown again.
   */
  function handleDismissBackupNudge(): void {
    setSettings((current) => ({ ...current, backupNudgeDismissed: true }))
    void settingsStore.dismissBackupNudge()
  }

  /**
   * Diagnostics (T039): gathers the snapshot fresh every time it's opened —
   * counts and status can change between visits (a key just saved, a Clip
   * that just finished generating) — and formats it once, so the screen
   * only ever shows one already-formatted string, never structured data.
   */
  function handleOpenDiagnostics(): void {
    setDiagnosticsReport(undefined)
    setDiagnosticsOpen(true)
    void collectDiagnostics({
      deckStore,
      settingsStore,
      clipCache,
      errorLog,
      getBuildInfo,
      getStorageEstimate: () => getStorageEstimate(),
    }).then((snapshot) => setDiagnosticsReport(formatDiagnosticsReport(snapshot)))
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

  /**
   * A confirmed Scan (docs/design.md §3.5 Step 3, carried from T024): append
   * every reviewed Draft Phrase to the chosen Deck — an existing one, or one
   * created inline — persist it once, and queue generation for each new
   * Phrase, same as a manually-added one. Leaves Import for the Deck she
   * just filled, so she can see what landed.
   */
  function handleImportSave(target: ImportTarget, drafts: readonly DraftPhrase[]): void {
    const base = target.kind === 'existing' ? (decks ?? []).find((d) => d.id === target.deckId) : createDeck(crypto.randomUUID(), target.name)
    if (!base) return
    const newIds: PhraseId[] = []
    const updated = drafts.reduce((deck, draft) => {
      const id = crypto.randomUUID()
      newIds.push(id)
      return addPhrase(deck, { id, french: draft.french, english: draft.english })
    }, base)
    persist(updated)
    for (const id of newIds) queuePhraseGeneration(updated, id)
    setImportOpen(false)
    setSelectedDeckId(updated.id)
  }

  /**
   * A batch of accepted Phrase Candidates from the Add sheet (T057), each
   * already routed to a chosen Deck. Groups by destination Deck and persists
   * once per Deck, matching `handleImportSave`'s established pattern; queues
   * generation for every new Phrase, same as a manually-added one.
   */
  function handleAddCandidates(accepted: { french: string; english: string; deckId: string }[]): void {
    const byDeck = new Map<string, typeof accepted>()
    for (const c of accepted) {
      const list = byDeck.get(c.deckId) ?? []
      list.push(c)
      byDeck.set(c.deckId, list)
    }
    for (const [deckId, group] of byDeck) {
      const base = (decks ?? []).find((d) => d.id === deckId)
      if (!base) continue
      const newIds: PhraseId[] = []
      const updated = group.reduce((deck, c) => {
        const id = crypto.randomUUID()
        newIds.push(id)
        return addPhrase(deck, { id, french: c.french, english: c.english })
      }, base)
      persist(updated)
      for (const id of newIds) queuePhraseGeneration(updated, id)
    }
  }

  if (decks === undefined) {
    return <main className="screen" />
  }

  if (diagnosticsOpen) {
    return (
      <DiagnosticsScreen
        onBack={() => setDiagnosticsOpen(false)}
        reportText={diagnosticsReport}
        onCopyReport={(text) => copyText(text)}
      />
    )
  }

  if (settingsOpen) {
    const previewText =
      (decks ?? []).flatMap((d) => d.phrases).find((p) => p.french.trim().length > 0)?.french ??
      FALLBACK_PREVIEW_PHRASE

    return (
      <SettingsScreen
        onBack={() => setSettingsOpen(false)}
        voice={settings.voice}
        voices={VOICE_CATALOGUE}
        previewText={previewText}
        onPreviewVoice={handlePreviewVoice}
        onChooseVoice={handleChooseVoice}
        onExportBackup={handleExportBackup}
        onRestoreFileChosen={handleRestoreFileChosen}
        onConfirmRestore={handleConfirmRestore}
        onCancelRestore={handleCancelRestore}
        onOpenDiagnostics={handleOpenDiagnostics}
      />
    )
  }

  if (drillTarget) {
    return (
      <DrillScreen
        title={drillTarget.title}
        checkReadiness={(): Promise<DrillReadinessResult> =>
          computeDrillReadiness(drillTarget.phrases, { clipCache, generationQueue, voice: settings.voice })
        }
        speech={clipPlayer ?? NOOP_SPEECH}
        clock={systemClock}
        unlock={async () => {
          if (!clipPlayer) {
            // Reachable only if readiness said canStart with no pinned voice —
            // a wiring fault, not the phone's doing. Name it as one.
            return { ok: false as const, name: 'NoVoicePinned', message: 'no voice is pinned' }
          }
          const ok = await clipPlayer.unlock()
          if (ok) return { ok: true as const }
          const failure = clipPlayer.lastUnlockFailure
          return {
            ok: false as const,
            name: failure?.name ?? 'UnknownError',
            message: failure?.message ?? '',
          }
        }}
        acquireWakeLock={() => wakeLock.acquire()}
        releaseWakeLock={() => wakeLock.release()}
        onExit={() => setDrillTarget(undefined)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
    )
  }

  if (mixOpen) {
    return (
      <MixSelectScreen
        decks={decks}
        mixes={mixes}
        onBack={() => setMixOpen(false)}
        onStartMix={(mix: Mix) => {
          setMixOpen(false)
          setDrillTarget({ title: mix.name, phrases: resolveMixPhrases(mix, decks) })
        }}
        onStartSelection={(selected) => {
          setMixOpen(false)
          setDrillTarget({ title: 'Mix', phrases: selected.flatMap((deck) => deck.phrases) })
        }}
        onSaveMix={handleSaveMix}
        onRenameMix={handleRenameMix}
        onEditMixDecks={handleEditMixDecks}
        onDeleteMix={handleDeleteMix}
      />
    )
  }

  if (importOpen) {
    return (
      <ImportScreen
        decks={decks}
        scanReader={scanReader}
        onSave={handleImportSave}
        onCancel={() => setImportOpen(false)}
        showBackupNudge={!settings.backupNudgeDismissed}
        onDismissBackupNudge={handleDismissBackupNudge}
      />
    )
  }

  if (selectedDeck) {
    return (
      <DeckDetailScreen
        deck={selectedDeck}
        decks={decks}
        translator={translator}
        onAddPhraseCandidates={handleAddCandidates}
        onBack={() => setSelectedDeckId(undefined)}
        onRenameDeck={(name) => handleRenameDeck(selectedDeck.id, name)}
        onDeleteDeck={() => handleDeleteDeck(selectedDeck.id)}
        onDrillDeck={() => setDrillTarget({ title: selectedDeck.name, phrases: selectedDeck.phrases })}
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
      onOpenMix={() => setMixOpen(true)}
      onOpenImport={() => setImportOpen(true)}
      showBackupNudge={!settings.backupNudgeDismissed}
      onDismissBackupNudge={handleDismissBackupNudge}
      // Computed at render, not on a timer: the engine re-renders this screen
      // on every state change, and a "3 minutes ago" that is occasionally a
      // minute stale is not worth a ticking interval on a phone.
      syncStatus={syncStatusText(sync, Date.now())}
    />
  )
}

export default App
