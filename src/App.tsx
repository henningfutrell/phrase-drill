import { useEffect, useMemo, useState, type ReactNode } from 'react'
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
import type {
  BoundedClipCache,
  ClipCacheUsage,
  DatabaseTrouble,
  DatabaseTroubleSource,
  Settings,
  SettingsStore,
} from './adapters/storage'
import { backupFilename, parseLibraryFile } from './adapters/storage'
import { backupAge, lastBackupAt } from './domain'
import { readInstallStateFromBrowser } from './adapters/device/install-state'
import type { ErrorLog } from './adapters/diagnostics'
import { collectDiagnostics, copyText, formatDiagnosticsReport, getBuildInfo, getStorageEstimate } from './adapters/diagnostics'
import { shareBackupFile } from './adapters/share/web-share'
import type { SynthClient } from './adapters/audio/server-synth-client'
import type { GenerationQueue } from './adapters/audio/generation-queue'
import type { SyncEngine, SyncSnapshot } from './adapters/sync/sync-engine'
import { createSyncedLibrary } from './adapters/sync/synced-library'
import { syncStatusText } from './ui/sync-status-text'
import { FALLBACK_PREVIEW_PHRASE, knownVoices, VOICE_CATALOGUE } from './adapters/audio/voice-catalogue'
import { createClipPlayer } from './adapters/audio/clip-player'
import { computeDrillReadiness } from './adapters/audio/drill-readiness'
import { createSystemClock } from './adapters/audio/system-clock'
import { createWakeLockPort } from './adapters/device/wake-lock'
import { DecksScreen } from './ui/DecksScreen'
import { DeckDetailScreen } from './ui/DeckDetailScreen'
import { MixSelectScreen } from './ui/MixSelectScreen'
import { ImportScreen, type ImportTarget } from './ui/ImportScreen'
import { DrillScreen, type DrillReadinessResult } from './ui/DrillScreen'
import { SettingsScreen, type PreviewOutcome } from './ui/SettingsScreen'
import type { ExportOutcome } from './ui/BackupStatus'
import type { RestoreFileResult } from './ui/RestoreControl'
import { DiagnosticsScreen } from './ui/DiagnosticsScreen'
import { LibraryUnreadableScreen } from './ui/LibraryUnreadableScreen'
import { WriteFailureNotice } from './ui/WriteFailureNotice'

const EMPTY_SETTINGS: Settings = {
  voice: null,
  lastSyncAt: null,
  lastExportAt: null,
}

/**
 * What a launch read that was REFUSED says (T083).
 *
 * It reuses the T069 notice rather than introducing a second way of speaking
 * to her — one alert in the app is what keeps the alert worth reading, and a
 * refused read is the same class of fact as a refused write: this phone's
 * storage did not do what was asked. What it cannot reuse is the *screen*
 * half of the T069 contract, because there is no rendered screen to roll back
 * to at mount; that half is `LibraryUnreadableScreen`.
 *
 * The detail is given explicitly because the default ("this phone may be out
 * of space") is a guess, and every wrong guess here sends her somewhere. The
 * only honest statement is that the storage did not open — and, said out loud,
 * that her phrases were not deleted, because the silence is what makes
 * reinstalling look reasonable.
 */
const LIBRARY_UNREADABLE_NOTICE: { message: string; detail: string } = {
  message: 'This phone could not open your saved phrases.',
  detail: 'Your phrases have not been deleted. Close the app and open it again.',
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
 * The fallback for a platform that cannot share files — **and only in an
 * ordinary browser tab.**
 *
 * In an installed iOS web app this is not a fallback, it is a trap: WebKit
 * 290847 (filed 2025-04-01, still NEW) reports that a download inside a
 * standalone web app opens an "Open in…" splash which "prohibits further
 * navigation inside the Web App" — no chrome, no back gesture, no Done — and
 * the only way out is force-quitting and relaunching. Serving the file inline
 * traps it the same way. Bug 236943 ("File download link in PWA cannot be
 * exited") was closed MOVED in 2022, which is not the same as fixed, and
 * nothing in the Safari 26 release notes addresses it. So an installed app
 * gets the copy-the-text fallback instead: worse than a file, but visible,
 * dismissible, and it loses nothing.
 *
 * Returns whether the download was **handed to the browser without error**.
 * That is the most this can ever report — a download fires no event, settles
 * no promise, and raises nothing when the file does not land — so `true` here
 * means "attempted", never "saved" (T085). `false` means it demonstrably did
 * not happen and the caller must offer her something else.
 */
function downloadFile(file: File): boolean {
  let url: string | undefined
  try {
    url = URL.createObjectURL(file)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = file.name
    anchor.click()
    return true
  } catch {
    return false
  } finally {
    // NOT revoked synchronously after `click()` (T085). The browser fetches
    // the blob URL on its own schedule, after the click returns; revoking
    // first races that fetch and produces a download that quietly writes no
    // file. Deferred instead — long enough that the browser is certainly
    // finished, short enough that the bytes are not held for the session.
    if (url !== undefined) {
      const revoked = url
      setTimeout(() => URL.revokeObjectURL(revoked), BLOB_URL_LIFETIME_MS)
    }
  }
}

/** How long a download's blob URL is left alive before it is revoked. */
const BLOB_URL_LIFETIME_MS = 60_000

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
  databaseTrouble,
}: {
  deckStore: DeckStore
  mixStore: MixStore
  settingsStore: SettingsStore
  synthClient: SynthClient
  generationQueue: GenerationQueue
  clipCache: BoundedClipCache
  scanReader: ScanReader
  errorLog: ErrorLog
  syncEngine: SyncEngine
  translator: Translator
  databaseTrouble: DatabaseTroubleSource
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
  const [backupFile, setBackupFile] = useState<File | undefined>(undefined)
  const [mixOpen, setMixOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [drillTarget, setDrillTarget] = useState<
    { title: string; phrases: readonly Phrase[] } | undefined
  >(undefined)
  // A write to this phone's storage was refused, and she has not read it yet
  // (T069). Holds the sentence naming what did not save; the standing
  // explanation is the notice's own.
  const [writeFailure, setWriteFailure] = useState<{ message: string; detail?: string } | undefined>(undefined)
  // A launch read was REFUSED, not merely slow (T083). Distinct from
  // `decks === undefined`, which is also true for the ordinary half-second
  // before the first read lands — one of those is a spinner and the other is
  // a dead end she needs a way out of.
  const [libraryUnreadable, setLibraryUnreadable] = useState(false)

  // One Wake Lock port for the app's lifetime (T006 carried obligation:
  // hold the screen on for a Drill's duration). Stateless, so a single
  // instance is fine to reuse across every Drill. `useMemo`, not `useRef`:
  // its value is read during render (passed straight into DrillScreen
  // props), and a ref must never be read there (react-hooks/refs).
  // The `Library` envelope as this device holds it: the deck store's stores
  // plus the pinned voice, joined on by name (T067). The same object both
  // builds the backup file and applies a restore, so a file she exports and a
  // file she restores carry the same enumerated set of fields.
  const syncedLibrary = useMemo(
    () => createSyncedLibrary({ deckStore, settingsStore }),
    [deckStore, settingsStore],
  )
  const wakeLock = useMemo(() => createWakeLockPort(), [])
  // One ClockPort for the app's lifetime — also stateless.
  const systemClock = useMemo(() => createSystemClock(), [])
  // Rebuilt only when the pinned voice actually changes (`settings.voice`
  // is only ever replaced, never mutated), so the same `<audio>` element
  // keeps serving unlock() and every real Clip across Drills run under the
  // same voice (T023's unlock-persists assumption — unverified on real iOS
  // Safari, confirmed only in T013).
  const clipPlayer = useMemo(
    () =>
      settings.voice
        ? createClipPlayer({ element: new Audio(), clipCache, voices: knownVoices(settings.voice) })
        : null,
    [settings.voice, clipCache],
  )

  const [sync, setSync] = useState<SyncSnapshot>(() => syncEngine.snapshot())

  useEffect(() => {
    let cancelled = false
    // Local first, always: what is on this device is shown without waiting
    // for a network round-trip that may never answer.
    void Promise.all([deckStore.loadAll(), mixStore.loadAll()]).then(
      ([loadedDecks, loadedMixes]) => {
        if (cancelled) return
        setDecks(loadedDecks)
        setMixes(loadedMixes)
        setLibraryUnreadable(false)
      },
      () => {
        // T083. This used to be a one-argument `.then`, so a database that
        // would not open left `decks` undefined forever and the app rendered
        // a bare `<main>`: no words, no controls, on the app holding phrases
        // that exist nowhere else. See `LibraryUnreadableScreen` for why a
        // blank screen here is the step before a destructive reinstall.
        if (cancelled) return
        setLibraryUnreadable(true)
        setWriteFailure(LIBRARY_UNREADABLE_NOTICE)
      },
    )
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
    void Promise.all([deckStore.loadAll(), mixStore.loadAll()]).then(
      ([loadedDecks, loadedMixes]) => {
        if (cancelled) return
        setDecks(loadedDecks)
        setMixes(loadedMixes)
        setLibraryUnreadable(false)
      },
      () => {
        // Same refusal, different moment (T083). If the first read landed,
        // what is on screen is real stored data and stays on screen — showing
        // the recovery screen would hide her library to report a failed
        // refresh. Only the notice is raised. If nothing has ever been read,
        // `decks` is still undefined and the recovery screen renders.
        if (cancelled) return
        setLibraryUnreadable(true)
        setWriteFailure(LIBRARY_UNREADABLE_NOTICE)
      },
    )
    return () => {
      cancelled = true
    }
  }, [revision, deckStore, mixStore])

  /**
   * The database itself refusing to be usable, said out loud (T072).
   *
   * `blocked` is another tab or a stale service-worker client holding the old
   * version open: the upgrade cannot start, nothing times out, and every
   * screen waits forever on a library that is perfectly fine. `terminated` is
   * the browser closing the connection underneath the app. Both were silent,
   * which is the same failure the T069 notice exists to end — so they use it,
   * with their own detail line, because "this phone may be out of space" is
   * the wrong thing to send her to fix.
   */
  useEffect(() => {
    return databaseTrouble.subscribe((trouble: DatabaseTrouble) => {
      setWriteFailure(
        trouble === 'blocked'
          ? {
              message: 'Your phrases could not be opened, because this app is still open in another window.',
              detail: 'Close the other window, then open this one again. Nothing has been lost.',
            }
          : {
              message: 'This phone closed the app’s connection to your phrases.',
              detail: 'Close the app and open it again. Anything you change before then may not be saved.',
            },
      )
    })
  }, [databaseTrouble])

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

  /**
   * Keeps a backup File built and ready **before** she taps Export (T031).
   *
   * This is not an optimization. WebKit expires transient activation across an
   * `await` (webkit.org/blog/13862/the-user-activation-api/), and its own
   * worked example is this exact shape: a click handler that awaits an async
   * read and then calls `navigator.share()`, annotated "Oh no!!! transient
   * activation expired". Reading the library inside the handler therefore
   * makes Export a button that appears to work and produces nothing. Building
   * the File here, off the gesture, is what lets `handleExportBackup` reach
   * `share()` with no await in front of it.
   *
   * Rebuilt on every change to the library, so the ready file is never stale.
   */
  useEffect(() => {
    if (decks === undefined) return
    let cancelled = false
    void syncedLibrary.readLocal().then((library) => {
      if (cancelled) return
      setBackupFile(
        new File([JSON.stringify(library, null, 2)], backupFilename(new Date()), {
          type: 'application/json',
        }),
      )
    })
    return () => {
      cancelled = true
    }
  }, [syncedLibrary, decks, mixes, settings.voice])

  /**
   * Every write to this phone's storage goes through here (T069).
   *
   * The screen has already been changed by the time this runs — that is what
   * makes the app feel like a phone rather than a form. The debt that creates
   * is settled here and nowhere else: if the store refuses the write, the
   * screens are put back to what is really on disk and she is told, in the
   * same breath, which change did not survive. Without both halves she is
   * looking at a Phrase that does not exist, with nothing to suggest it.
   *
   * A write that failed is also never announced to the sync engine. There is
   * nothing to send.
   */
  function persistLocally(write: Promise<void>, failureMessage: string): void {
    void write.then(
      () => syncToServer(),
      () => {
        setWriteFailure({ message: failureMessage })
        reloadLibraryFromStores()
      },
    )
  }

  /** Make the screens show what the stores actually hold, not what was asked of them. */
  function reloadLibraryFromStores(): void {
    void Promise.all([deckStore.loadAll(), mixStore.loadAll()]).then(
      ([loadedDecks, loadedMixes]) => {
        setDecks(loadedDecks)
        setMixes(loadedMixes)
      },
      () => {
        // The store cannot even be read. Nothing can be rolled back to, and
        // the notice is then the whole of the guarantee — which is why it is
        // set before this is called, never after.
      },
    )
  }

  /** Same, for the Settings the `settings` store holds. */
  function reloadSettings(): void {
    void settingsStore.load().then(setSettings, () => {})
  }

  /**
   * A Deck that does not exist yet, into local state and the store. Its id was
   * generated a moment ago, so there is nothing stored under it to overwrite —
   * which is the only condition under which a whole-Deck put is safe here.
   * Changing a Deck that already exists goes through `mutateDeck`.
   */
  function persistNewDeck(deck: Deck) {
    setDecks((current) => [...(current ?? []), deck])
    persistLocally(deckStore.save(deck), `“${deck.name}” could not be saved on this phone.`)
  }

  /**
   * Every change to a Deck that already exists (T075).
   *
   * The screen is changed straight away, from `base` — that is what makes the
   * app feel like a phone. But **what reaches storage is `apply` run against
   * the stored Deck, inside the store's own transaction**, never the Deck this
   * render computed. React state is a view, and a view is stale by the time a
   * tap lands: a merge can write a Phrase from her other phone between the
   * render she tapped and the write. Putting the rendered Deck back overwrote
   * that Phrase — and the Sync Baseline then held it while the local Deck did
   * not, which `mergePhrases` reads as a deletion (T070) and carried to the
   * server on the next round-trip. One dropped render, gone from both phones.
   *
   * `apply` is a pure domain function of a Deck, so running it twice — once
   * for the screen, once for the store — is the same answer computed against
   * two different Decks, which is exactly what is wanted. The store's answer
   * wins as soon as it lands, so the merged Phrase appears without waiting for
   * the next sync.
   *
   * A Deck the store no longer holds falls back to `base`: her edit is a
   * keystroke, and losing it to protect a deletion made elsewhere is the same
   * defect wearing different clothes.
   *
   * Returns what the SCREEN was set to — used only to queue audio generation
   * for a Phrase she just typed, which needs the text and not the stored Deck.
   */
  function mutateDeck(base: Deck, apply: (deck: Deck) => Deck): Deck {
    const shown = apply(base)
    setDecks((current) => (current ?? []).map((d) => (d.id === shown.id ? shown : d)))
    persistLocally(
      deckStore.update(base.id, (stored) => apply(stored ?? base)).then((saved) => {
        setDecks((current) => (current ?? []).map((d) => (d.id === saved.id ? saved : d)))
      }),
      `“${shown.name}” could not be saved on this phone.`,
    )
    return shown
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
    persistNewDeck(createDeck(crypto.randomUUID(), name))
  }

  function handleRenameDeck(id: DeckId, name: string) {
    const deck = (decks ?? []).find((d) => d.id === id)
    if (!deck) return
    mutateDeck(deck, (d) => renameDeck(d, name))
  }

  /**
   * Whole-Mix upsert into local state and the store. Still a whole-record put
   * from React state — what T075 stopped doing for Decks and deliberately did
   * not for Mixes: the loser of a Mix race is a selection of Deck ids she can
   * re-make in seconds, and this write names one Mix, so it can reach no other
   * record (docs/sync.md, Known gaps).
   */
  function persistMix(mix: Mix) {
    setMixes((current) =>
      current.some((m) => m.id === mix.id) ? current.map((m) => (m.id === mix.id ? mix : m)) : [...current, mix],
    )
    persistLocally(mixStore.save(mix), `“${mix.name}” could not be saved on this phone.`)
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
    const name = mixes.find((m) => m.id === id)?.name
    setMixes((current) => current.filter((m) => m.id !== id))
    persistLocally(mixStore.remove(id), `“${name ?? 'That Mix'}” could not be deleted on this phone.`)
  }

  function handleDeleteDeck(id: DeckId) {
    const name = (decks ?? []).find((d) => d.id === id)?.name
    setDecks((current) => (current ?? []).filter((d) => d.id !== id))
    persistLocally(deckStore.remove(id), `“${name ?? 'That Deck'}” could not be deleted on this phone.`)
    if (selectedDeckId === id) setSelectedDeckId(undefined)
  }

  /**
   * Puts the prepared backup File somewhere she can keep it, and records that
   * it happened (T031).
   *
   * Deliberately NOT `async`: the whole point is that `shareBackupFile` is
   * reached with no await in front of it, so the tap's transient activation is
   * still live when `navigator.share()` runs. Everything asynchronous happens
   * after the share call, never before it.
   *
   * A tap before the first File is ready reports `cancelled` — nothing left
   * the app, and nothing claims otherwise.
   */
  function handleExportBackup(): Promise<ExportOutcome> {
    const file = backupFile
    if (!file) return Promise.resolve<ExportOutcome>({ kind: 'cancelled' })

    return shareBackupFile(file).then(async (outcome): Promise<ExportOutcome> => {
      if (outcome === 'shared') {
        recordExport()
        return { kind: 'shared' }
      }
      if (outcome === 'cancelled') return { kind: 'cancelled' }
      // 'unsupported' — no share sheet. See downloadFile's comment for why an
      // installed app must not be handed a download here.
      if (readInstallStateFromBrowser().installed) {
        return { kind: 'unavailable', text: await file.text(), filename: file.name }
      }
      // **No `recordExport()` on this path (T085).** A download reports
      // nothing back: it fires no event, settles no promise, and raises
      // nothing when the file fails to land, so there is no success path here
      // to write an export time on. `lastSyncAt` is written only on the
      // success path and nowhere else, for the reason that an age written on
      // a failure silences the backup warning with nothing behind it — and
      // this half of the same age was recorded on a guess. The guess is worth
      // less than it costs: sync writes the other half after every save, so
      // the age only stays loud when sync is failing too, which is exactly
      // when she should hear about it. A warning shown once too often costs
      // her a tap; a warning silenced wrongly costs her the library.
      if (!downloadFile(file)) {
        return { kind: 'unavailable', text: await file.text(), filename: file.name }
      }
      return { kind: 'downloaded' }
    })
  }

  /** A backup file actually left the app, so the Backup age starts again from now. */
  function recordExport(): void {
    const timestamp = Date.now()
    setSettings((current) => ({ ...current, lastExportAt: timestamp }))
    void settingsStore.recordExport(timestamp).catch(() => {
      // The file did leave the app; only the note that it did was refused. Say
      // so plainly rather than let the Backup age quietly go back to claiming
      // she has not exported in a month.
      setWriteFailure({ message: 'That backup was made, but this phone could not record that it was.' })
      reloadSettings()
    })
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
    void syncEngine
      // The engine owns both halves of a restore (T081). It used to own only
      // the first — `libraryRestored()` here, `writeLocal` chained after it —
      // and the two could come apart in either direction: a round-trip already
      // pushing put the pre-restore snapshot back over the emptied baseline,
      // and a local write that failed left the emptied baseline over an
      // unchanged library. Handing the write in makes them one operation with
      // one outcome; everything below runs only if that succeeded.
      //
      // Why the baseline is emptied at all (T072): a restore used to undo
      // itself, because `importAll` clears this device's Tombstones, the
      // server keeps its own, and the next round-trip pulled them back and
      // re-deleted the Deck she had just restored. An empty baseline makes
      // every restored record outrank a stale deletion.
      .libraryRestored(() => syncedLibrary.writeLocal(library))
      .then(() => Promise.all([deckStore.loadAll(), mixStore.loadAll(), settingsStore.load()]))
      .then(([loadedDecks, loadedMixes, loadedSettings]) => {
        // A restore replaces the whole library, saved Mixes included — read
        // both back so the screens show what is actually stored, not what
        // was stored a moment ago.
        setDecks(loadedDecks)
        setMixes(loadedMixes)
        // The file may have carried a pinned voice (T067); if it did, it is
        // pinned now, and the drill screen must be told.
        setSettings(loadedSettings)
        setSelectedDeckId(undefined)
        setSettingsOpen(false)
        syncToServer()
      })
      .catch(() => {
        // `importAll` is one transaction over all three stores, so a refusal
        // rolls the whole restore back — nothing was replaced, and the Decks
        // she had are still the Decks she has.
        setWriteFailure({ message: 'That backup could not be restored on this phone.' })
        reloadLibraryFromStores()
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
      if (kind === 'rate-limited') return { ok: false, reason: 'rate-limited' }
      if (kind === 'quota') return { ok: false, reason: 'quota' }
      return { ok: false, reason: 'network' }
    }
  }

  function handleChooseVoice(voice: { provider: string; modelId: string; voiceId: string }) {
    setSettings((current) => ({ ...current, voice }))
    // Push it, so her other phone gets the preference rather than only this
    // one (T067). Nothing is regenerated by this: the audio she has is
    // playable in the voice it was made in, and this decides what the next
    // new Phrase is made in.
    void settingsStore
      .setVoice(voice)
      .then(() => syncToServer())
      .catch(() => {
        // A voice the screen shows as pinned but the store never took is a
        // Drill that will not start, with nothing to explain why (T069).
        setWriteFailure({ message: 'The voice you chose could not be saved on this phone.' })
        reloadSettings()
      })
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
    return mutateDeck(selectedDeck, fn)
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
    // Minted once, outside `append`, because `append` runs twice — once for the
    // screen and once inside the store's transaction (`mutateDeck`). Two runs
    // minting two sets of ids would write every imported Phrase twice.
    const newIds: PhraseId[] = drafts.map(() => crypto.randomUUID())
    const append = (deck: Deck): Deck =>
      drafts.reduce(
        (current, draft, index) =>
          addPhrase(current, { id: newIds[index]!, french: draft.french, english: draft.english }),
        deck,
      )

    let updated: Deck
    if (target.kind === 'existing') {
      updated = mutateDeck(base, append)
    } else {
      updated = append(base)
      persistNewDeck(updated)
    }
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
      // Minted once — see `handleImportSave` for why `append` must not do it.
      const newIds: PhraseId[] = group.map(() => crypto.randomUUID())
      const updated = mutateDeck(base, (deck) =>
        group.reduce(
          (current, c, index) => addPhrase(current, { id: newIds[index]!, french: c.french, english: c.english }),
          deck,
        ),
      )
      for (const id of newIds) queuePhraseGeneration(updated, id)
    }
  }

  return (
    <>
      {writeFailure !== undefined && (
        <WriteFailureNotice
          message={writeFailure.message}
          detail={writeFailure.detail}
          onDismiss={() => setWriteFailure(undefined)}
        />
      )}
      {renderScreen()}
    </>
  )

  /**
   * Which screen she is looking at. Wrapped by the notice above rather than
   * returned beside it: a screen added later cannot forget to surface a
   * write this phone refused, because it has no way to render itself
   * without going through here.
   */
  function renderScreen(): ReactNode {
    /**
     * How long since her library was last safe somewhere else (T031).
     * Measured from whichever of the automatic sync and her own last export
     * happened later — a server-side copy is a backup, so a sync that just
     * succeeded makes the answer honest without her doing anything. Read at
     * render, like the sync line below and for the same reason: the clock
     * moving is not worth a ticking interval on a phone.
     */
    const age = backupAge(lastBackupAt(settings.lastSyncAt, settings.lastExportAt), Date.now())

    if (decks === undefined) {
      // Refused, not merely slow (T083). The blank `<main>` is right for the
      // half-second before the first read lands and wrong forever after a
      // read that will never land — that is a dead end, and Restore is the
      // only way out of it.
      if (libraryUnreadable) {
        return (
          <LibraryUnreadableScreen
            onRestoreFileChosen={handleRestoreFileChosen}
            onConfirmRestore={handleConfirmRestore}
            onCancelRestore={handleCancelRestore}
          />
        )
      }
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
          backupAge={age}
          onExportBackup={handleExportBackup}
          onCopyText={(text) => copyText(text)}
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
        />
      )
    }

    if (selectedDeck) {
      return (
        <DeckDetailScreen
          deck={selectedDeck}
          decks={decks}
          backupAge={age}
          onExportBackup={handleExportBackup}
          onCopyText={(text) => copyText(text)}
          translator={translator}
          onAddPhraseCandidates={handleAddCandidates}
          onBack={() => setSelectedDeckId(undefined)}
          onRenameDeck={(name) => handleRenameDeck(selectedDeck.id, name)}
          onDeleteDeck={() => handleDeleteDeck(selectedDeck.id)}
          onDrillDeck={() => setDrillTarget({ title: selectedDeck.name, phrases: selectedDeck.phrases })}
          onRegenerateDeckAudio={() => {
            for (const phrase of selectedDeck.phrases) generationQueue.enqueue(phrase)
          }}
          onRegeneratePhraseAudio={(id: PhraseId) => {
            const phrase = selectedDeck.phrases.find((p) => p.id === id)
            if (phrase) generationQueue.enqueue(phrase)
          }}
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
        backupAge={age}
        onExportBackup={handleExportBackup}
        onCopyText={(text) => copyText(text)}
        onRestoreFileChosen={handleRestoreFileChosen}
        onConfirmRestore={handleConfirmRestore}
        onCancelRestore={handleCancelRestore}
        // Computed at render, not on a timer: the engine re-renders this screen
        // on every state change, and a "3 minutes ago" that is occasionally a
        // minute stale is not worth a ticking interval on a phone.
        syncStatus={syncStatusText(sync, Date.now())}
      />
    )
  }
}

export default App
