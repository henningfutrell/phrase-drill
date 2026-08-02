import { LIBRARY_FORMAT, type Library } from '../../domain'
import { CURRENT_SCHEMA_VERSION, migrateDeckRecord, type DeckRecord } from './migrations'

export type { Library }

/** Why a chosen file could not be accepted as a backup — each maps to its own
 * plain-language explanation in the UI (never a bare "invalid file"). */
export type ParseLibraryResult =
  | { ok: true; library: Library }
  | { ok: false; reason: 'not-json' | 'wrong-format' | 'invalid' }

/**
 * Validate a restore file before anything touches storage (docs/design.md
 * §3.6 — restore warns, then replaces; it never merges, and it never runs
 * against a file that isn't actually a backup). Pure and total: whatever
 * garbage is handed in, this returns a result, it never throws.
 */
export function parseLibraryFile(raw: string): ParseLibraryResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'not-json' }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid' }
  }

  const candidate = parsed as Record<string, unknown>
  if (candidate.format !== LIBRARY_FORMAT) {
    return { ok: false, reason: 'wrong-format' }
  }
  if (typeof candidate.schemaVersion !== 'number' || !Array.isArray(candidate.decks)) {
    return { ok: false, reason: 'invalid' }
  }

  return { ok: true, library: candidate as unknown as Library }
}

/**
 * The exported backup's filename — stable and dated so a file rediscovered
 * in Files six months later is still identifiable at a glance.
 */
export function backupFilename(date: Date): string {
  const yyyy = date.getUTCFullYear()
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  return `phrase-drill-backup-${yyyy}-${mm}-${dd}.json`
}

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
