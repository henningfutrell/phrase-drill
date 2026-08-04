import type { DeckStore } from '../../domain'
import type { Voice } from '../../domain'
import type { ClipCache, SettingsStore } from '../storage'
import { knownVoices } from '../audio/voice-catalogue'
import type { BuildInfo } from './build-info'
import type { ErrorLog, LogEntry } from './error-log'
import type { StorageEstimateResult } from './storage-estimate'

/** How many recent errors ride along in a report by default — enough to see
 * a pattern (a repeated failure, not a one-off) without the report ballooning. */
const DEFAULT_RECENT_ERRORS_LIMIT = 10

/**
 * Everything Diagnostics shows, gathered in one place. No phrase content —
 * only what T039 asks the report to answer: the pinned voice, Clips ready
 * vs total Phrases, storage, last sync, and the last N captured errors.
 * T041 dropped the two provider-key-presence fields this used to carry: the
 * device holds no provider key any more to be present or absent.
 */
export interface DiagnosticsSnapshot {
  readonly build: BuildInfo
  readonly voice: Voice | null
  readonly phrasesTotal: number
  readonly clipsReady: number
  readonly storage: StorageEstimateResult
  readonly lastSyncAt: number | null
  readonly recentErrors: readonly LogEntry[]
}

export interface CollectDiagnosticsDeps {
  readonly deckStore: DeckStore
  readonly settingsStore: SettingsStore
  readonly clipCache: ClipCache
  readonly errorLog: ErrorLog
  readonly recentErrorsLimit?: number
  readonly getBuildInfo: () => BuildInfo
  readonly getStorageEstimate: () => Promise<StorageEstimateResult>
}

/**
 * Gathers the diagnostics snapshot from every port this needs — the only
 * place that touches all of DeckStore/SettingsStore/ClipCache/ErrorLog for
 * this purpose. Clips ready is honestly 0 when no voice is pinned, never a
 * guess (mirrors `computeDrillReadiness`'s treatment of "no voice").
 */
export async function collectDiagnostics(deps: CollectDiagnosticsDeps): Promise<DiagnosticsSnapshot> {
  const { deckStore, settingsStore, clipCache, errorLog, getBuildInfo, getStorageEstimate } = deps
  const recentErrorsLimit = deps.recentErrorsLimit ?? DEFAULT_RECENT_ERRORS_LIMIT

  const [decks, settings, entries, storage] = await Promise.all([
    deckStore.loadAll(),
    settingsStore.load(),
    errorLog.list(),
    getStorageEstimate(),
  ])

  const phrases = decks.flatMap((d) => d.phrases)
  // Over every voice a Clip could be in, not only the pinned one (T067):
  // this number has to be the one the drill acts on, or a report reads
  // "0 of 200 ready" about a library that drills perfectly.
  const clipsReady = settings.voice
    ? (await clipCache.readyPhraseIds(phrases, knownVoices(settings.voice))).size
    : 0

  return {
    build: getBuildInfo(),
    voice: settings.voice,
    phrasesTotal: phrases.length,
    clipsReady,
    storage,
    lastSyncAt: settings.lastSyncAt,
    recentErrors: entries.slice(-recentErrorsLimit),
  }
}

function formatBytesMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1)
}

function formatStorage(storage: StorageEstimateResult): string {
  if (!storage.supported) return 'Storage: unavailable on this browser.'
  return `Storage: ${formatBytesMb(storage.usageBytes)} MB used of ${formatBytesMb(storage.quotaBytes)} MB.`
}

function formatVoice(voice: Voice | null): string {
  return voice ? `Voice: pinned (${voice.provider}).` : 'Voice: none pinned.'
}

function formatLastSync(lastSyncAt: number | null): string {
  return lastSyncAt ? `Last sync: ${new Date(lastSyncAt).toISOString()}.` : 'Last sync: never.'
}

function formatRecentErrors(entries: readonly LogEntry[]): string {
  if (entries.length === 0) return 'Recent errors: none.'
  const lines = entries.map((e) => `- [${new Date(e.timestamp).toISOString()}] ${e.source}: ${e.message}`)
  return ['Recent errors:', ...lines].join('\n')
}

/**
 * Formats the snapshot as plain text — the one thing the copy control sends
 * to the clipboard for pasting into a message. Counts only, never phrase
 * text.
 */
export function formatDiagnosticsReport(snapshot: DiagnosticsSnapshot): string {
  return [
    `Build: ${snapshot.build.sha} (${snapshot.build.builtAt})`,
    formatVoice(snapshot.voice),
    `Clips ready: ${snapshot.clipsReady} of ${snapshot.phrasesTotal} Phrases`,
    formatStorage(snapshot.storage),
    formatLastSync(snapshot.lastSyncAt),
    formatRecentErrors(snapshot.recentErrors),
  ].join('\n')
}
