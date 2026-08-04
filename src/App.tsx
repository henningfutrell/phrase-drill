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
  mergeLibraries,
  removePhrase,
  renameDeck,
  renameMix,
  reorderPhrase,
  resolveMixPhrases,
  setMixDecks,
  updatePhrase,
} from './domain'
import type { BoundedClipCache, ClipCacheUsage, Settings, SettingsStore } from './adapters/storage'
import { backupFilename, normalizeLibrary, parseLibraryFile } from './adapters/storage'
import type { ErrorLog } from './adapters/diagnostics'
import { collectDiagnostics, copyText, formatDiagnosticsReport, getBuildInfo, getStorageEstimate } from './adapters/diagnostics'
import { shareBackupFile } from './adapters/share/web-share'
import type { SynthClient } from './adapters/audio/server-synth-client'
import type { GenerationQueue } from './adapters/audio/generation-queue'
import type { LibrarySyncClient } from './adapters/sync/library-sync-client'
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
  librarySyncClient,
  translator,
}: {
  deckStore: DeckStore
  mixStore: MixStore
  settingsStore: SettingsStore
  synthClient: SynthClient
  generationQueue: GenerationQueue
  clipCache: BoundedClipCache
  scanReader: ScanReader
  errorLog: ErrorLog
  librarySyncClient: LibrarySyncClient
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
  // What the clip cache is holding, read when Settings opens (T036). Not held
  // from boot: it changes every time a Clip is generated or evicted, and a
  // stale number here is a number she would act on.
  const [savedAudio, setSavedAudio] = useState<ClipCacheUsage | undefined>(undefined)
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

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // Local first, always: what is on this device is shown without
      // waiting for a network round-trip that may never answer.
      const [loadedDecks, loadedMixes] = await Promise.all([deckStore.loadAll(), mixStore.loadAll()])
      if (cancelled) return
      setDecks(loadedDecks)
      setMixes(loadedMixes)

      // Then pull, on every boot — not only when local storage is empty
      // (T060). The old gate meant a device holding even one Deck never
      // asked the server anything again, so a Deck made on the web was
      // never seen by the phone. `not-found`/`unauthorized`/`network` all
      // leave her exactly where she is: pulling is a bonus on top of local
      // storage, never a blocker in front of it.
      const pulled = await librarySyncClient.pull()
      if (cancelled || !pulled.ok) return

      // Merge, never replace. The server copy is another device's snapshot,
      // not an authority: replacing local with it would delete anything
      // saved here while offline. Boot deliberately does NOT push the
      // result — opening the app must not be able to change the server
      // copy; only a save or a delete pushes.
      const merged = mergeLibraries(
        normalizeLibrary(await deckStore.exportAll()),
        normalizeLibrary(pulled.library),
      )
      await deckStore.importAll(merged)
      const [mergedDecks, mergedMixes] = await Promise.all([deckStore.loadAll(), mixStore.loadAll()])
      if (cancelled) return
      setDecks(mergedDecks)
      setMixes(mergedMixes)
    })()
    return () => {
      cancelled = true
    }
  }, [deckStore, mixStore, librarySyncClient])

  useEffect(() => {
    let cancelled = false
    void settingsStore.load().then((loaded) => {
      if (!cancelled) setSettings(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [settingsStore])

  /**
   * Opens Settings and asks the clip cache what it is holding, fresh every
   * time — the number changes with every Clip generated or evicted, and a
   * stale one is a number she would act on. Same shape as
   * `handleOpenDiagnostics` below, and for the same reason.
   */
  function handleOpenSettings(): void {
    setSavedAudio(undefined)
    setSettingsOpen(true)
    void clipCache.usage().then(setSavedAudio)
  }

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
   * Pushes the whole Library to the server after a local change (T041:
   * "her library is stored server-side"). Fire-and-forget from the caller's
   * point of view — a failed push never blocks the local save, which has
   * already happened by the time this runs; it only updates `lastSyncAt` on
   * success, so Diagnostics can show how stale the server copy might be.
   *
   * Read-merge-write, not write (T060). The push carries the whole library,
   * so pushing this device's copy blind overwrites whatever only the other
   * device had — which is how a Deck she made on the web was deleted by the
   * next save on her phone. So: pull first, merge, push the union.
   *
   * A pull that fails means this device cannot know what it would be
   * overwriting, and it does not push at all. Her change is already saved
   * locally and goes up on the next successful sync; the alternative —
   * pushing anyway — is exactly the destructive write this exists to
   * prevent. `not-found` is not a failure: it means the server holds
   * nothing yet, so there is nothing to merge with and nothing to lose.
   */
  function syncToServer(): void {
    void (async () => {
      const pulled = await librarySyncClient.pull()
      if (!pulled.ok && pulled.reason !== 'not-found') return

      const local = await deckStore.exportAll()
      const outgoing = pulled.ok
        ? mergeLibraries(normalizeLibrary(local), normalizeLibrary(pulled.library))
        : local

      const result = await librarySyncClient.push(outgoing)
      if (!result.ok) return
      const timestamp = Date.now()
      setSettings((current) => ({ ...current, lastSyncAt: timestamp }))
      void settingsStore.recordSync(timestamp)
    })()
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
        savedAudio={savedAudio}
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
        onOpenSettings={handleOpenSettings}
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
      onOpenSettings={handleOpenSettings}
      onOpenMix={() => setMixOpen(true)}
      onOpenImport={() => setImportOpen(true)}
      showBackupNudge={!settings.backupNudgeDismissed}
      onDismissBackupNudge={handleDismissBackupNudge}
    />
  )
}

export default App
