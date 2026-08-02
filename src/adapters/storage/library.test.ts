import { describe, expect, it } from 'vitest'
import { LIBRARY_FORMAT, type Library } from '../../domain'
import { buildLibrary, migrateLibraryDecks } from './library'
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
