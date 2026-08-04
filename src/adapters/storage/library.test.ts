import { describe, expect, it } from 'vitest'
import { LIBRARY_FORMAT, type Library, type Tombstone } from '../../domain'
import {
  backupFilename,
  buildLibrary,
  migrateLibraryDecks,
  migrateLibraryMixes,
  normalizeLibrary,
  parseLibraryFile,
  withVoice,
} from './library'
import { CURRENT_SCHEMA_VERSION } from './migrations'

const MIX_RECORDS = [{ id: 'm1', name: 'Mornings', deckIds: ['d1'], createdAt: 2, updatedAt: 2 }]
const TOMBSTONES: Tombstone[] = [{ id: 'gone', kind: 'deck', deletedAt: 999 }]

describe('buildLibrary', () => {
  it('wraps deck records, mix records and Tombstones with the format, current schema version, and export time', () => {
    const records = [
      { id: 'd1', name: 'Home', phrases: [], createdAt: 1, updatedAt: 1 },
    ]

    expect(buildLibrary(records, MIX_RECORDS, TOMBSTONES, 12345)).toEqual({
      format: LIBRARY_FORMAT,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      exportedAt: 12345,
      decks: records,
      mixes: MIX_RECORDS,
      tombstones: TOMBSTONES,
    })
  })

  it('carries saved Mixes so they survive a new phone — the whole point of the sync envelope (T059)', () => {
    expect(buildLibrary([], MIX_RECORDS, [], 1).mixes).toEqual(MIX_RECORDS)
  })

  it('carries Tombstones, so another device learns what was deleted rather than pushing it back (T060)', () => {
    expect(buildLibrary([], [], TOMBSTONES, 1).tombstones).toEqual(TOMBSTONES)
  })
})

describe('migrateLibraryMixes', () => {
  it('returns the mix records of a current library unchanged', () => {
    const library: Library = {
      format: LIBRARY_FORMAT,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      exportedAt: 1,
      decks: [],
      mixes: MIX_RECORDS,
    }

    expect(migrateLibraryMixes(library)).toEqual(MIX_RECORDS)
  })

  it('reads a pre-v4 backup, which has no mixes field at all, as no saved Mixes', () => {
    const library: Library = {
      format: LIBRARY_FORMAT,
      schemaVersion: 3,
      exportedAt: 1,
      decks: [{ id: 'd1', name: 'Home', phrases: [], createdAt: 1, updatedAt: 1 }],
    }

    expect(migrateLibraryMixes(library)).toEqual([])
  })
})

describe('normalizeLibrary', () => {
  it('brings an older library up to the current schema version, decks intact and every optional field filled in', () => {
    const older: Library = {
      format: LIBRARY_FORMAT,
      schemaVersion: 1,
      exportedAt: 7,
      decks: [{ id: 'd1', name: 'Home', phrases: [], createdAt: 1, updatedAt: 1 }],
    }

    expect(normalizeLibrary(older)).toEqual({
      format: LIBRARY_FORMAT,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      exportedAt: 7,
      decks: older.decks,
      mixes: [],
      tombstones: [],
    })
  })

  it('keeps the Mixes and Tombstones a current library already carries', () => {
    const current: Library = {
      format: LIBRARY_FORMAT,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      exportedAt: 7,
      decks: [],
      mixes: MIX_RECORDS,
      tombstones: TOMBSTONES,
    }

    expect(normalizeLibrary(current).mixes).toEqual(MIX_RECORDS)
    expect(normalizeLibrary(current).tombstones).toEqual(TOMBSTONES)
  })
})

describe('migrateLibraryDecks', () => {
  it('returns the deck records unchanged when the library is already current', () => {
    const records = [{ id: 'd1', name: 'Home', phrases: [], createdAt: 1, updatedAt: 1 }]
    const library: Library = {
      format: LIBRARY_FORMAT,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      exportedAt: 1,
      decks: records,
    }

    expect(migrateLibraryDecks(library)).toEqual(records)
  })

  it('runs every deck through the same version guard migrateDeckRecord enforces, rejecting a library newer than this build supports', () => {
    const library: Library = {
      format: LIBRARY_FORMAT,
      schemaVersion: CURRENT_SCHEMA_VERSION + 1,
      exportedAt: 1,
      decks: [{ id: 'd1', name: 'Home', phrases: [], createdAt: 1, updatedAt: 1 }],
    }

    expect(() => migrateLibraryDecks(library)).toThrow(/newer/)
  })
})

describe('parseLibraryFile', () => {
  const validLibrary: Library = {
    format: LIBRARY_FORMAT,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: 1,
    decks: [{ id: 'd1', name: 'Home', phrases: [], createdAt: 1, updatedAt: 1 }],
  }

  it('parses a well-formed exported library', () => {
    const result = parseLibraryFile(JSON.stringify(validLibrary))
    expect(result).toEqual({ ok: true, library: validLibrary })
  })

  it('refuses text that is not JSON at all, without throwing', () => {
    const result = parseLibraryFile('not json { at all')
    expect(result).toEqual({ ok: false, reason: 'not-json' })
  })

  it('refuses JSON that is not an object', () => {
    const result = parseLibraryFile('[1, 2, 3]')
    expect(result).toEqual({ ok: false, reason: 'invalid' })
  })

  it('refuses a JSON object whose format field is not this app\'s library format', () => {
    const result = parseLibraryFile(JSON.stringify({ ...validLibrary, format: 'some-other-app-export' }))
    expect(result).toEqual({ ok: false, reason: 'wrong-format' })
  })

  it('refuses a library missing a schemaVersion', () => {
    const withoutVersion: Record<string, unknown> = { ...validLibrary }
    delete withoutVersion.schemaVersion
    const result = parseLibraryFile(JSON.stringify(withoutVersion))
    expect(result).toEqual({ ok: false, reason: 'invalid' })
  })

  it('refuses a library whose decks field is not an array', () => {
    const result = parseLibraryFile(JSON.stringify({ ...validLibrary, decks: 'not-an-array' }))
    expect(result).toEqual({ ok: false, reason: 'invalid' })
  })

  it('accepts a pre-v4 backup that has no mixes field — an old file is still a valid backup', () => {
    const withoutMixes: Record<string, unknown> = { ...validLibrary, schemaVersion: 3 }
    delete withoutMixes.mixes
    const result = parseLibraryFile(JSON.stringify(withoutMixes))
    expect(result.ok).toBe(true)
  })

  it('accepts a library carrying saved Mixes', () => {
    const withMixes = { ...validLibrary, mixes: [{ id: 'm1', name: 'Mornings', deckIds: ['d1'], createdAt: 1, updatedAt: 1 }] }
    expect(parseLibraryFile(JSON.stringify(withMixes))).toEqual({ ok: true, library: withMixes })
  })

  it('refuses a library whose mixes field is present but not an array', () => {
    const result = parseLibraryFile(JSON.stringify({ ...validLibrary, mixes: 'not-an-array' }))
    expect(result).toEqual({ ok: false, reason: 'invalid' })
  })

  it('never throws, whatever garbage it is given', () => {
    expect(() => parseLibraryFile('')).not.toThrow()
    expect(() => parseLibraryFile('null')).not.toThrow()
    expect(() => parseLibraryFile('42')).not.toThrow()
  })
})

describe('backupFilename', () => {
  it('names the file with the app name and the export date, so it is identifiable months later', () => {
    expect(backupFilename(new Date('2026-08-02T14:23:00Z'))).toBe('phrase-drill-backup-2026-08-02.json')
  })

  it('zero-pads single-digit months and days', () => {
    expect(backupFilename(new Date('2026-01-05T00:00:00Z'))).toBe('phrase-drill-backup-2026-01-05.json')
  })
})

/**
 * T067 — the pinned voice travels in the envelope, as its own named field.
 * The property that field replaces is worth restating: nothing here reads
 * the `settings` store wholesale, so only what is enumerated crosses the
 * wire or lands in a backup file.
 */
describe('the pinned voice on the envelope (T067)', () => {
  const VOICE = { provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-1' }
  const base: Library = {
    format: LIBRARY_FORMAT,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: 1,
    decks: [],
    mixes: [],
    tombstones: [],
  }

  it('adds the pinned voice to an envelope the deck store built without one', () => {
    expect(withVoice(base, VOICE).voice).toEqual(VOICE)
  })

  it('adds no voice field at all when nothing is pinned', () => {
    expect(withVoice(base, null).voice).toBeUndefined()
  })

  it('carries only the voice — the rest of the settings record has no way in', () => {
    const serialized = JSON.stringify(withVoice(base, VOICE))
    expect(serialized).not.toContain('lastSyncAt')
    expect(serialized).not.toContain('lastExportAt')
  })

  it('keeps the voice through normalization, so a pulled envelope does not lose it before the merge', () => {
    expect(normalizeLibrary({ ...base, voice: VOICE }).voice).toEqual(VOICE)
  })

  it('normalizes an envelope with no voice to no voice, never to a throw', () => {
    expect(normalizeLibrary(base).voice).toBeUndefined()
  })

  it('drops a malformed voice from a pulled envelope rather than blocking the sync of her phrases', () => {
    const wrong = { ...base, voice: { provider: 'elevenlabs' } } as unknown as Library
    expect(normalizeLibrary(wrong).voice).toBeUndefined()
  })

  it('accepts a backup file that carries a voice', () => {
    const result = parseLibraryFile(JSON.stringify({ ...base, voice: VOICE }))
    expect(result).toEqual({ ok: true, library: { ...base, voice: VOICE } })
  })

  it('accepts an older backup file with no voice field — absent means "no voice recorded", never "invalid file"', () => {
    const result = parseLibraryFile(JSON.stringify(base))
    expect(result.ok).toBe(true)
  })

  it('refuses a file whose voice field is present but not a Voice', () => {
    const result = parseLibraryFile(JSON.stringify({ ...base, voice: 'Rachel' }))
    expect(result).toEqual({ ok: false, reason: 'invalid' })
  })

  it('refuses a file whose voice is an object missing part of the content address', () => {
    const result = parseLibraryFile(JSON.stringify({ ...base, voice: { provider: 'elevenlabs', voiceId: 'v' } }))
    expect(result).toEqual({ ok: false, reason: 'invalid' })
  })
})
