import { describe, expect, it } from 'vitest'
import { LIBRARY_FORMAT, type Library } from '../../domain'
import { backupFilename, buildLibrary, migrateLibraryDecks, parseLibraryFile } from './library'
import { CURRENT_SCHEMA_VERSION } from './migrations'

describe('buildLibrary', () => {
  it('wraps deck records with the format, current schema version, and export time', () => {
    const records = [
      { id: 'd1', name: 'Home', phrases: [], createdAt: 1, updatedAt: 1 },
    ]

    expect(buildLibrary(records, 12345)).toEqual({
      format: LIBRARY_FORMAT,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      exportedAt: 12345,
      decks: records,
    })
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
    const { schemaVersion: _schemaVersion, ...withoutVersion } = validLibrary
    const result = parseLibraryFile(JSON.stringify(withoutVersion))
    expect(result).toEqual({ ok: false, reason: 'invalid' })
  })

  it('refuses a library whose decks field is not an array', () => {
    const result = parseLibraryFile(JSON.stringify({ ...validLibrary, decks: 'not-an-array' }))
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
