import { describe, expect, it } from 'vitest'
import type { Deck, DeckStore, Library } from '../../domain'
import { LIBRARY_FORMAT } from '../../domain'
import type { ClipCache, Settings, SettingsStore, Voice } from '../storage'
import { collectDiagnostics, formatDiagnosticsReport } from './diagnostics-report'
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
  }
}

function fakeSettingsStore(overrides: Partial<Settings> = {}): SettingsStore {
  const settings: Settings = {
    anthropicApiKey: null,
    elevenLabsApiKey: null,
    voice: null,
    backupNudgeDismissed: false,
    lastSyncAt: null,
    ...overrides,
  }
  return {
    async load() {
      return settings
    },
    async setAnthropicApiKey() {},
    async setElevenLabsApiKey() {},
    async setVoice() {},
    async dismissBackupNudge() {},
    async recordSync() {},
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
  it('reports key presence, never the key value', async () => {
    const snapshot = await collectDiagnostics({
      deckStore: fakeDeckStore([]),
      settingsStore: fakeSettingsStore({ anthropicApiKey: 'sk-ant-secret', elevenLabsApiKey: null }),
      clipCache: fakeClipCache(new Set()),
      errorLog: fakeErrorLog([]),
      getBuildInfo: () => ({ sha: 'abc1234', builtAt: '2026-08-02T00:00:00.000Z' }),
      getStorageEstimate: async () => ({ supported: false }),
    })

    expect(snapshot.anthropicKeyPresent).toBe(true)
    expect(snapshot.elevenLabsKeyPresent).toBe(false)
  })

  it('counts Clips ready against total Phrases, using the pinned voice', async () => {
    const snapshot = await collectDiagnostics({
      deckStore: fakeDeckStore(DECKS),
      settingsStore: fakeSettingsStore({ voice: VOICE }),
      clipCache: fakeClipCache(new Set(['p1'])),
      errorLog: fakeErrorLog([]),
      getBuildInfo: () => ({ sha: 'abc1234', builtAt: '2026-08-02T00:00:00.000Z' }),
      getStorageEstimate: async () => ({ supported: false }),
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
    })

    expect(snapshot.recentErrors.map((e) => e.message)).toEqual(['entry-7', 'entry-8', 'entry-9'])
  })
})

describe('formatDiagnosticsReport', () => {
  it('never includes phrase content — counts only', () => {
    const text = formatDiagnosticsReport({
      build: { sha: 'abc1234', builtAt: '2026-08-02T00:00:00.000Z' },
      anthropicKeyPresent: true,
      elevenLabsKeyPresent: true,
      voice: VOICE,
      phrasesTotal: 2,
      clipsReady: 1,
      storage: { supported: false },
      lastSyncAt: null,
      recentErrors: [],
    })

    expect(text).not.toContain('Bonjour')
    expect(text).not.toContain('Merci')
    expect(text).toContain('2')
    expect(text).toContain('1')
  })

  it('never includes a key value, only presence', () => {
    const text = formatDiagnosticsReport({
      build: { sha: 'abc1234', builtAt: '2026-08-02T00:00:00.000Z' },
      anthropicKeyPresent: true,
      elevenLabsKeyPresent: false,
      voice: null,
      phrasesTotal: 0,
      clipsReady: 0,
      storage: { supported: false },
      lastSyncAt: null,
      recentErrors: [],
    })

    expect(text).not.toMatch(/sk-ant-|el-key/)
  })

  it('states storage as unavailable honestly rather than printing a fabricated zero', () => {
    const text = formatDiagnosticsReport({
      build: { sha: 'abc1234', builtAt: '2026-08-02T00:00:00.000Z' },
      anthropicKeyPresent: false,
      elevenLabsKeyPresent: false,
      voice: null,
      phrasesTotal: 0,
      clipsReady: 0,
      storage: { supported: false },
      lastSyncAt: null,
      recentErrors: [],
    })

    expect(text.toLowerCase()).toContain('unavailable')
  })

  it('reports storage usage against quota when the estimate is available', () => {
    const text = formatDiagnosticsReport({
      build: { sha: 'abc1234', builtAt: '2026-08-02T00:00:00.000Z' },
      anthropicKeyPresent: false,
      elevenLabsKeyPresent: false,
      voice: null,
      phrasesTotal: 0,
      clipsReady: 0,
      storage: { supported: true, usageBytes: 1_048_576, quotaBytes: 10_485_760 },
      lastSyncAt: null,
      recentErrors: [],
    })

    expect(text).toMatch(/1(\.0)? MB/)
    expect(text).toMatch(/10(\.0)? MB/)
  })

  it('reports the build sha and timestamp so a build can be identified over the phone', () => {
    const text = formatDiagnosticsReport({
      build: { sha: 'abc1234', builtAt: '2026-08-02T00:00:00.000Z' },
      anthropicKeyPresent: false,
      elevenLabsKeyPresent: false,
      voice: null,
      phrasesTotal: 0,
      clipsReady: 0,
      storage: { supported: false },
      lastSyncAt: null,
      recentErrors: [],
    })

    expect(text).toContain('abc1234')
  })

  it('reports never for last sync when none has happened', () => {
    const text = formatDiagnosticsReport({
      build: { sha: 'abc1234', builtAt: '2026-08-02T00:00:00.000Z' },
      anthropicKeyPresent: false,
      elevenLabsKeyPresent: false,
      voice: null,
      phrasesTotal: 0,
      clipsReady: 0,
      storage: { supported: false },
      lastSyncAt: null,
      recentErrors: [],
    })

    expect(text).toMatch(/never/i)
  })

  it('includes the last N captured errors, each with a timestamp', () => {
    const text = formatDiagnosticsReport({
      build: { sha: 'abc1234', builtAt: '2026-08-02T00:00:00.000Z' },
      anthropicKeyPresent: false,
      elevenLabsKeyPresent: false,
      voice: null,
      phrasesTotal: 0,
      clipsReady: 0,
      storage: { supported: false },
      lastSyncAt: null,
      recentErrors: [{ id: 1, timestamp: 1_700_000_000_000, source: 'window.onerror', message: 'TypeError: boom' }],
    })

    expect(text).toContain('TypeError: boom')
    expect(text).toContain('window.onerror')
  })

  it('states plainly when no errors have been captured, rather than an empty section', () => {
    const text = formatDiagnosticsReport({
      build: { sha: 'abc1234', builtAt: '2026-08-02T00:00:00.000Z' },
      anthropicKeyPresent: false,
      elevenLabsKeyPresent: false,
      voice: null,
      phrasesTotal: 0,
      clipsReady: 0,
      storage: { supported: false },
      lastSyncAt: null,
      recentErrors: [],
    })

    expect(text.toLowerCase()).toMatch(/none|no errors/)
  })
})
