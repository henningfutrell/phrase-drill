import type { DeckStore, PassageStore, Voice } from '../../domain'
import { buildLineRep, buildPhraseRep, splitPassageIntoLines } from '../../domain'
import type { ClipCache, SettingsStore } from '../storage'
import { knownVoices } from '../audio/voice-catalogue'
import type { BuildInfo } from './build-info'
import type { ErrorLog, LogEntry } from './error-log'
import type { StorageEstimateResult } from './storage-estimate'

/** How many recent errors ride along in a report by default — enough to see
 * a pattern (a repeated failure, not a one-off) without the report ballooning. */
const DEFAULT_RECENT_ERRORS_LIMIT = 10

/**
 * What the Route hold (T004, `adapters/audio/route-hold.ts`) reports about
 * itself, declared here as plain data rather than imported from that adapter.
 * `App.tsx` maps the port's `stats()` onto it, keeping one adapter's types
 * out of another's — the same discipline `DrillScreenProps` keeps with
 * `DrillReadinessResult`.
 *
 * The pair that matters is `totalHeldMs` against `advancedMs`: wall clock
 * against media clock. Close together means a second `<audio>` element really
 * did play for the whole Drill and the route was held; far apart means iOS
 * stopped it and the hold is a no-op that says so.
 */
export interface RouteHoldSummary {
  readonly starts: number
  readonly playResolved: boolean | null
  readonly lastError?: { readonly name: string; readonly message: string }
  readonly totalHeldMs: number
  readonly advancedMs: number
  readonly watchdogFired: boolean
}

/**
 * Everything Diagnostics shows, gathered in one place. No phrase or passage
 * content — only what T039 asks the report to answer: the pinned voice, Clips
 * ready vs total, storage, last sync, and the last N captured errors.
 * T041 dropped the two provider-key-presence fields this used to carry: the
 * device holds no provider key any more to be present or absent.
 *
 * Readiness is two counts, not one. A merged number cannot tell "their Passage
 * has no audio" from "their Deck has no audio", and that is the first
 * distinction the person reading their pasted report needs.
 */
export interface DiagnosticsSnapshot {
  readonly build: BuildInfo
  readonly voice: Voice | null
  readonly phrasesTotal: number
  readonly phrasesReady: number
  readonly passageLinesTotal: number
  readonly passageLinesReady: number
  readonly routeHold: RouteHoldSummary
  readonly storage: StorageEstimateResult
  readonly lastSyncAt: number | null
  readonly recentErrors: readonly LogEntry[]
}

export interface CollectDiagnosticsDeps {
  readonly deckStore: DeckStore
  /**
   * Required, not optional. The composition root has one, and an optional
   * `passageStore` here is exactly how the readiness count would quietly go
   * back to ignoring every Passage — a report that answers "it's not working"
   * with "everything is ready" while a Passage sits silent.
   */
  readonly passageStore: PassageStore
  readonly settingsStore: SettingsStore
  readonly clipCache: ClipCache
  readonly errorLog: ErrorLog
  readonly recentErrorsLimit?: number
  readonly getBuildInfo: () => BuildInfo
  readonly getRouteHold: () => RouteHoldSummary
  readonly getStorageEstimate: () => Promise<StorageEstimateResult>
}

/**
 * Gathers the diagnostics snapshot from every port this needs — the only
 * place that touches all of DeckStore/PassageStore/SettingsStore/ClipCache/
 * ErrorLog for this purpose. Clips ready is honestly 0 when no voice is
 * pinned, never a guess (mirrors `computeDrillReadiness`'s treatment of "no
 * voice").
 *
 * This is `profile.md`'s reason for the Diagnostic report existing at all:
 * it is the only channel that answers "it's not working" without a round trip
 * through a non-technical user in another country. So readiness is counted
 * over the whole library — Phrase Reps and Passage Line Reps together, in one
 * sweep, exactly as the drill would ask it — and reported as two populations.
 */
export async function collectDiagnostics(deps: CollectDiagnosticsDeps): Promise<DiagnosticsSnapshot> {
  const { deckStore, passageStore, settingsStore, clipCache, errorLog, getBuildInfo, getRouteHold, getStorageEstimate } =
    deps
  const recentErrorsLimit = deps.recentErrorsLimit ?? DEFAULT_RECENT_ERRORS_LIMIT

  const [decks, passages, settings, entries, storage] = await Promise.all([
    deckStore.loadAll(),
    passageStore.loadAll(),
    settingsStore.load(),
    errorLog.list(),
    getStorageEstimate(),
  ])

  const phraseReps = decks.flatMap((deck) => deck.phrases.map(buildPhraseRep))
  // A Line is derived, never stored, so the Lines have to be re-derived here
  // the same way the drill derives them — otherwise the count would answer a
  // question about Passages, and the user drills Lines.
  const lineReps = passages.flatMap((passage) => splitPassageIntoLines(passage).map(buildLineRep))

  // One sweep over both populations, over every voice a Clip could be in, not
  // only the pinned one (T067): these numbers have to be the ones the drill
  // acts on, or a report reads "0 of 200 ready" about a library that drills
  // perfectly.
  const readyIds = settings.voice
    ? await clipCache.readyUnitIds([...phraseReps, ...lineReps], knownVoices(settings.voice))
    : new Set<string>()

  return {
    build: getBuildInfo(),
    voice: settings.voice,
    phrasesTotal: phraseReps.length,
    phrasesReady: phraseReps.filter((rep) => readyIds.has(rep.id)).length,
    passageLinesTotal: lineReps.length,
    passageLinesReady: lineReps.filter((rep) => readyIds.has(rep.id)).length,
    routeHold: getRouteHold(),
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

function formatRouteHold(hold: RouteHoldSummary): string {
  if (hold.starts === 0) return 'Route hold: never held.'
  const held = Math.round(hold.totalHeldMs / 1000)
  const played = Math.round(hold.advancedMs / 1000)
  const detail = hold.lastError
    ? `${hold.lastError.name}: ${hold.lastError.message || '(no message)'}`
    : hold.watchdogFired
      ? 'stopped by watchdog'
      : 'no error'
  const line = `Route hold: ${hold.starts} start${hold.starts === 1 ? '' : 's'}, held ${held}s, played ${played}s, ${detail}`
  // A DOMException message is a sentence and usually brings its own full
  // stop, so appending one unconditionally gives `... user agent..`. Every
  // other line in this report ends in exactly one; the user reads this by eye and
  // pastes it into a message, so the punctuation is the whole tell that the
  // line is finished rather than truncated.
  return line.endsWith('.') ? line : `${line}.`
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
 * to the clipboard for pasting into a message. Counts only, never their Phrase
 * or Passage text.
 *
 * The two readiness lines are unconditional, even at zero. A report that
 * dropped the Passage Lines line when the user has no Passages would be
 * indistinguishable from a build that cannot count them at all, and "does
 * this build even know about my Passage?" is the question the reader is
 * actually asking.
 */
export function formatDiagnosticsReport(snapshot: DiagnosticsSnapshot): string {
  return [
    `Build: ${snapshot.build.sha} (${snapshot.build.builtAt})`,
    formatVoice(snapshot.voice),
    `Clips ready: ${snapshot.phrasesReady} of ${snapshot.phrasesTotal} Phrases`,
    `Clips ready: ${snapshot.passageLinesReady} of ${snapshot.passageLinesTotal} Passage Lines`,
    formatRouteHold(snapshot.routeHold),
    formatStorage(snapshot.storage),
    formatLastSync(snapshot.lastSyncAt),
    formatRecentErrors(snapshot.recentErrors),
  ].join('\n')
}
