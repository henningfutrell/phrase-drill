import { describe, expect, it } from 'vitest'
import type { Deck, DeckStore, Library } from '../../domain'
import { LIBRARY_FORMAT } from '../../domain'
import type { ClipCache, Settings, SettingsStore } from '../storage'
import type { Voice } from '../../domain'
import { collectDiagnostics, formatDiagnosticsReport } from './diagnostics-report'
import type { RouteHoldSummary } from './diagnostics-report'
import type { ErrorLog, LogEntry } from './error-log'

function fakeDeckStore(decks: readonly Deck[]): DeckStore {
  return {
    async loadAll() {
      return [...decks]
    },
    async get(id) {
      return decks.find((d) => d.id === id)
    },
    async save() {},
    async remove() {},
    async exportAll(): Promise<Library> {
      return { format: LIBRARY_FORMAT, schemaVersion: 1, exportedAt: 0, decks: [] }
    },
    async importAll() {},
    async update(id, apply) {
      return apply(decks.find((d) => d.id === id))
    },
    async updateAll(update) {
      return { library: update(await this.exportAll()), changed: false }
    },
  }
}

function fakeSettingsStore(overrides: Partial<Settings> = {}): SettingsStore {
  const settings: Settings = {
    voice: null,
    lastSyncAt: null,
    lastExportAt: null,
    ...overrides,
  }
  return {
    async load() {
      return settings
    },
    async setVoice() {},
    async adoptVoice() {},
    async recordSync() {},
    async recordExport() {},
  }
}

function fakeClipCache(readyIds: ReadonlySet<string>): ClipCache {
  return {
    async get() {
      return undefined
    },
    async put() {},
    async has() {
      return false
    },
    async readyPhraseIds(phrases) {
      return new Set(phrases.map((p) => p.id).filter((id) => readyIds.has(id)))
    },
  }
}

function fakeErrorLog(entries: readonly LogEntry[]): ErrorLog {
  return {
    async record() {},
    async list() {
      return entries
    },
  }
}

/** A report from a device where the Drill screen was never opened. */
const NEVER_HELD: RouteHoldSummary = {
  starts: 0,
  playResolved: null,
  totalHeldMs: 0,
  advancedMs: 0,
  watchdogFired: false,
}

const VOICE: Voice = { provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-1' }

const DECKS: Deck[] = [
  {
    id: 'd1',
    name: 'Home',
    phrases: [
      { id: 'p1', french: 'Bonjour', english: 'Hello' },
      { id: 'p2', french: 'Merci', english: 'Thanks' },
    ],
  },
]

describe('collectDiagnostics', () => {
  it('counts Clips ready against total Phrases, using the pinned voice', async () => {
    const snapshot = await collectDiagnostics({
      deckStore: fakeDeckStore(DECKS),
      settingsStore: fakeSettingsStore({ voice: VOICE }),
      clipCache: fakeClipCache(new Set(['p1'])),
      errorLog: fakeErrorLog([]),
      getBuildInfo: () => ({ sha: 'abc1234', builtAt: '2026-08-02T00:00:00.000Z' }),
      getStorageEstimate: async () => ({ supported: false }),
      getRouteHold: () => NEVER_HELD,
    })

    expect(snapshot.phrasesTotal).toBe(2)
    expect(snapshot.clipsReady).toBe(1)
    expect(snapshot.voice).toEqual(VOICE)
  })

  it('reports zero Clips ready, honestly, when no voice is pinned rather than guessing', async () => {
    const snapshot = await collectDiagnostics({
      deckStore: fakeDeckStore(DECKS),
      settingsStore: fakeSettingsStore({ voice: null }),
      clipCache: fakeClipCache(new Set(['p1'])),
      errorLog: fakeErrorLog([]),
      getBuildInfo: () => ({ sha: 'abc1234', builtAt: '2026-08-02T00:00:00.000Z' }),
      getStorageEstimate: async () => ({ supported: false }),
      getRouteHold: () => NEVER_HELD,
    })

    expect(snapshot.clipsReady).toBe(0)
    expect(snapshot.voice).toBeNull()
  })

  it('carries the last-sync fact through as-is', async () => {
    const snapshot = await collectDiagnostics({
      deckStore: fakeDeckStore([]),
      settingsStore: fakeSettingsStore({ lastSyncAt: 1_700_000_000_000 }),
      clipCache: fakeClipCache(new Set()),
      errorLog: fakeErrorLog([]),
      getBuildInfo: () => ({ sha: 'abc1234', builtAt: '2026-08-02T00:00:00.000Z' }),
      getStorageEstimate: async () => ({ supported: false }),
      getRouteHold: () => NEVER_HELD,
    })

    expect(snapshot.lastSyncAt).toBe(1_700_000_000_000)
  })

  it('caps the carried error list at the requested recent-errors limit, keeping the newest', async () => {
    const entries: LogEntry[] = Array.from({ length: 10 }, (_, i) => ({
      id: i,
      timestamp: i,
      source: 'window.onerror',
      message: `entry-${i}`,
    }))

    const snapshot = await collectDiagnostics({
      deckStore: fakeDeckStore([]),
      settingsStore: fakeSettingsStore(),
      clipCache: fakeClipCache(new Set()),
      errorLog: fakeErrorLog(entries),
      recentErrorsLimit: 3,
      getBuildInfo: () => ({ sha: 'abc1234', builtAt: '2026-08-02T00:00:00.000Z' }),
      getStorageEstimate: async () => ({ supported: false }),
      getRouteHold: () => NEVER_HELD,
    })

    expect(snapshot.recentErrors.map((e) => e.message)).toEqual(['entry-7', 'entry-8', 'entry-9'])
  })
})

describe('formatDiagnosticsReport', () => {
  it('never includes phrase content — counts only', () => {
    const text = formatDiagnosticsReport({
      build: { sha: 'abc1234', builtAt: '2026-08-02T00:00:00.000Z' },
      voice: VOICE,
      phrasesTotal: 2,
      clipsReady: 1,
      storage: { supported: false },
      lastSyncAt: null,
      routeHold: NEVER_HELD,
      recentErrors: [],
    })

    expect(text).not.toContain('Bonjour')
    expect(text).not.toContain('Merci')
    expect(text).toContain('2')
    expect(text).toContain('1')
  })

  it('states storage as unavailable honestly rather than printing a fabricated zero', () => {
    const text = formatDiagnosticsReport({
      build: { sha: 'abc1234', builtAt: '2026-08-02T00:00:00.000Z' },
      voice: null,
      phrasesTotal: 0,
      clipsReady: 0,
      storage: { supported: false },
      lastSyncAt: null,
      routeHold: NEVER_HELD,
      recentErrors: [],
    })

    expect(text.toLowerCase()).toContain('unavailable')
  })

  it('reports storage usage against quota when the estimate is available', () => {
    const text = formatDiagnosticsReport({
      build: { sha: 'abc1234', builtAt: '2026-08-02T00:00:00.000Z' },
      voice: null,
      phrasesTotal: 0,
      clipsReady: 0,
      storage: { supported: true, usageBytes: 1_048_576, quotaBytes: 10_485_760 },
      lastSyncAt: null,
      routeHold: NEVER_HELD,
      recentErrors: [],
    })

    expect(text).toMatch(/1(\.0)? MB/)
    expect(text).toMatch(/10(\.0)? MB/)
  })

  it('reports the build sha and timestamp so a build can be identified over the phone', () => {
    const text = formatDiagnosticsReport({
      build: { sha: 'abc1234', builtAt: '2026-08-02T00:00:00.000Z' },
      voice: null,
      phrasesTotal: 0,
      clipsReady: 0,
      storage: { supported: false },
      lastSyncAt: null,
      routeHold: NEVER_HELD,
      recentErrors: [],
    })

    expect(text).toContain('abc1234')
  })

  it('reports never for last sync when none has happened', () => {
    const text = formatDiagnosticsReport({
      build: { sha: 'abc1234', builtAt: '2026-08-02T00:00:00.000Z' },
      voice: null,
      phrasesTotal: 0,
      clipsReady: 0,
      storage: { supported: false },
      lastSyncAt: null,
      routeHold: NEVER_HELD,
      recentErrors: [],
    })

    expect(text).toMatch(/never/i)
  })

  it('includes the last N captured errors, each with a timestamp', () => {
    const text = formatDiagnosticsReport({
      build: { sha: 'abc1234', builtAt: '2026-08-02T00:00:00.000Z' },
      voice: null,
      phrasesTotal: 0,
      clipsReady: 0,
      storage: { supported: false },
      lastSyncAt: null,
      routeHold: NEVER_HELD,
      recentErrors: [{ id: 1, timestamp: 1_700_000_000_000, source: 'window.onerror', message: 'TypeError: boom' }],
    })

    expect(text).toContain('TypeError: boom')
    expect(text).toContain('window.onerror')
  })

  it('states plainly when no errors have been captured, rather than an empty section', () => {
    const text = formatDiagnosticsReport({
      build: { sha: 'abc1234', builtAt: '2026-08-02T00:00:00.000Z' },
      voice: null,
      phrasesTotal: 0,
      clipsReady: 0,
      storage: { supported: false },
      lastSyncAt: null,
      routeHold: NEVER_HELD,
      recentErrors: [],
    })

    expect(text.toLowerCase()).toMatch(/none|no errors/)
  })
})

/**
 * The Route hold line (T004). The hold is an experiment — whether a second
 * looping `<audio>` element keeps an iOS Safari A2DP route alive across a
 * Pause cannot be answered from source. These two numbers, read off her
 * Diagnostics screen after one drive, are the answer: `held` is wall clock
 * between hold and release, `played` is media clock. Equal means it worked.
 */
describe('formatDiagnosticsReport — the Route hold line', () => {
  function report(routeHold: RouteHoldSummary): string {
    return formatDiagnosticsReport({
      build: { sha: 'abc1234', builtAt: '2026-08-02T00:00:00.000Z' },
      voice: null,
      phrasesTotal: 0,
      clipsReady: 0,
      storage: { supported: false },
      lastSyncAt: null,
      routeHold,
      recentErrors: [],
    })
  }

  /** The one line, asserted whole — `toContain` cannot see a trailing typo. */
  function holdLine(routeHold: RouteHoldSummary): string {
    const line = report(routeHold)
      .split('\n')
      .find((candidate) => candidate.startsWith('Route hold:'))
    expect(line).toBeDefined()
    return line ?? ''
  }

  it('says plainly that no Drill has been run, rather than printing zeroes', () => {
    expect(holdLine(NEVER_HELD)).toBe('Route hold: never held.')
  })

  it('states held and played side by side, which is the whole measurement', () => {
    expect(
      holdLine({
        starts: 1,
        playResolved: true,
        totalHeldMs: 612_000,
        advancedMs: 611_400,
        watchdogFired: false,
      }),
    ).toBe('Route hold: 1 start, held 612s, played 611s, no error.')
  })

  it('names the DOMException when play() was refused — NotAllowedError and NotSupportedError need opposite fixes', () => {
    // A DOMException `message` is a sentence and ends in its own full stop.
    // Appending another gave the shipped line a doubled period, and this
    // line is pasted verbatim into a message by a non-technical user.
    expect(
      holdLine({
        starts: 1,
        playResolved: false,
        lastError: { name: 'NotAllowedError', message: 'The request is not allowed by the user agent.' },
        totalHeldMs: 612_000,
        advancedMs: 0,
        watchdogFired: false,
      }),
    ).toBe(
      'Route hold: 1 start, held 612s, played 0s, NotAllowedError: The request is not allowed by the user agent.',
    )
  })

  it('still says something when the DOMException carried no message at all', () => {
    expect(
      holdLine({
        starts: 1,
        playResolved: false,
        lastError: { name: 'NotSupportedError', message: '' },
        totalHeldMs: 30_000,
        advancedMs: 0,
        watchdogFired: false,
      }),
    ).toBe('Route hold: 1 start, held 30s, played 0s, NotSupportedError: (no message).')
  })

  it('reports a hold the watchdog had to end — a Drill screen discarded mid-run', () => {
    expect(
      holdLine({
        starts: 3,
        playResolved: true,
        totalHeldMs: 4_801_000,
        advancedMs: 4_798_000,
        watchdogFired: true,
      }),
    ).toBe('Route hold: 3 starts, held 4801s, played 4798s, stopped by watchdog.')
  })

  it('ends every rendered state in exactly one full stop, like its neighbours in this file', () => {
    const states: RouteHoldSummary[] = [
      NEVER_HELD,
      { starts: 1, playResolved: true, totalHeldMs: 612_000, advancedMs: 611_400, watchdogFired: false },
      {
        starts: 1,
        playResolved: false,
        lastError: { name: 'NotAllowedError', message: 'The request is not allowed by the user agent.' },
        totalHeldMs: 612_000,
        advancedMs: 0,
        watchdogFired: false,
      },
      { starts: 3, playResolved: true, totalHeldMs: 4_801_000, advancedMs: 4_798_000, watchdogFired: true },
    ]

    for (const state of states) {
      const line = holdLine(state)
      expect(line.endsWith('.')).toBe(true)
      expect(line.endsWith('..')).toBe(false)
    }
  })

  it('reads between Clips ready and storage — both are playback facts', () => {
    const lines = report(NEVER_HELD).split('\n')
    const clips = lines.findIndex((line) => line.startsWith('Clips ready:'))
    const hold = lines.findIndex((line) => line.startsWith('Route hold:'))
    const storage = lines.findIndex((line) => line.startsWith('Storage:'))

    expect(hold).toBe(clips + 1)
    expect(storage).toBe(hold + 1)
  })
})

describe('collectDiagnostics — the Route hold summary', () => {
  it('carries the hold summary through as the port reported it, adding nothing', async () => {
    const held: RouteHoldSummary = {
      starts: 2,
      playResolved: true,
      totalHeldMs: 1000,
      advancedMs: 998,
      watchdogFired: false,
    }

    const snapshot = await collectDiagnostics({
      deckStore: fakeDeckStore([]),
      settingsStore: fakeSettingsStore(),
      clipCache: fakeClipCache(new Set()),
      errorLog: fakeErrorLog([]),
      getBuildInfo: () => ({ sha: 'abc1234', builtAt: '2026-08-02T00:00:00.000Z' }),
      getStorageEstimate: async () => ({ supported: false }),
      getRouteHold: () => held,
    })

    expect(snapshot.routeHold).toEqual(held)
  })
})
