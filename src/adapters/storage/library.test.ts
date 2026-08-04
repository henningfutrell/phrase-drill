import { describe, expect, it } from 'vitest'
import { LIBRARY_FORMAT, type Library, type Tombstone } from '../../domain'
import {
  backupFilename,
  buildLibrary,
  migrateLibraryDecks,
  migrateLibraryMixes,
  normalizeLibrary,
  parseLibraryFile,
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
