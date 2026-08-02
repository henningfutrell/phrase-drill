import { LIBRARY_FORMAT, type Library } from '../../domain'
import { CURRENT_SCHEMA_VERSION, migrateDeckRecord, type DeckRecord } from './migrations'

export type { Library }

/** Wrap a whole-library snapshot with its format, current schema version, and export time. */
export function buildLibrary(decks: readonly DeckRecord[], exportedAt: number): Library {
  return {
    format: LIBRARY_FORMAT,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt,
    decks: [...decks],
  }
}

/**
 * Migrate every deck record in an imported library to the current schema,
 * using the same pure `migrateDeckRecord` the IDB upgrade path runs — one
 * migration codebase serves both paths.
 */
export function migrateLibraryDecks(library: Library): DeckRecord[] {
  return library.decks.map((record) => migrateDeckRecord(record, library.schemaVersion))
}
