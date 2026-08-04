import { LIBRARY_FORMAT, type Library } from '../../domain'
import {
  CURRENT_SCHEMA_VERSION,
  migrateDeckRecord,
  type DeckRecord,
  type MixRecord,
  type Tombstone,
} from './migrations'

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
  // `mixes` arrived at schema v4 (T059). Absent is normal — every backup
  // written before then has no such field — but present-and-not-an-array is
  // a corrupt file, not an old one.
  if (candidate.mixes !== undefined && !Array.isArray(candidate.mixes)) {
    return { ok: false, reason: 'invalid' }
  }
  // `tombstones` arrived at schema v5 (T060), and reads the same way:
  // absent is every backup written before then, present-and-not-an-array is
  // corrupt.
  if (candidate.tombstones !== undefined && !Array.isArray(candidate.tombstones)) {
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

/**
 * Wrap a whole-library snapshot with its format, current schema version, and
 * export time. Saved Mixes travel with the Decks (T059): the same envelope
 * is both the backup file and the `/api/library` sync body, so a Mix left
 * out here is a Mix she loses when she gets a new phone.
 */
export function buildLibrary(
  decks: readonly DeckRecord[],
  mixes: readonly MixRecord[],
  tombstones: readonly Tombstone[],
  exportedAt: number,
): Library {
  return {
    format: LIBRARY_FORMAT,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt,
    decks: [...decks],
    mixes: [...mixes],
    tombstones: [...tombstones],
  }
}

/**
 * Bring a library — this device's or the server's — to the current schema
 * and fill in every field a merge reads, so `mergeLibraries` compares two
 * envelopes of the same shape and never has to guess what an absent field
 * meant (T060).
 *
 * The one judgement here is what an absent field means, and it is always
 * "nothing", never "everything": a pre-v5 envelope has no `tombstones`
 * because Tombstones did not exist when it was written, not because she
 * deleted nothing — but "nothing known to be deleted" is exactly what this
 * build can honestly act on. Reading absence as a deletion would let an old
 * envelope wipe her library, which is the defect this whole change exists
 * to end.
 *
 * Nothing is invented for a record's own timestamps: `updatedAt` has been
 * on every deck record since v1 and every mix record since v4, so the merge
 * compares times that were really written at save time, on the device that
 * made the change. No migration here stamps a clock.
 */
export function normalizeLibrary(library: Library): Library {
  return {
    format: LIBRARY_FORMAT,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: library.exportedAt,
    decks: migrateLibraryDecks(library),
    mixes: migrateLibraryMixes(library),
    tombstones: migrateLibraryTombstones(library),
  }
}

/**
 * The Tombstones of a library. Born at schema v5 with one shape, so there
 * is no chain to run — only the question a pre-v5 envelope asks, answered
 * in `normalizeLibrary` above.
 */
export function migrateLibraryTombstones(library: Library): Tombstone[] {
  return [...(library.tombstones ?? [])]
}

/**
 * Migrate every deck record in an imported library to the current schema,
 * using the same pure `migrateDeckRecord` the IDB upgrade path runs — one
 * migration codebase serves both paths.
 */
export function migrateLibraryDecks(library: Library): DeckRecord[] {
  return library.decks.map((record) => migrateDeckRecord(record, library.schemaVersion))
}

/**
 * The saved Mixes of an imported library. Mix records were born at schema
 * v4 and have had exactly one shape since, so there is no chain to run —
 * only the one question a pre-v4 backup asks, which is what "no `mixes`
 * field at all" means. It means no saved Mixes, and it is not an error:
 * refusing an old backup would refuse the very file that exists to rescue
 * her phrases. The version guard itself still runs, on the decks
 * (`migrateLibraryDecks`), so a library newer than this build is still
 * rejected before anything is written.
 */
export function migrateLibraryMixes(library: Library): MixRecord[] {
  return [...(library.mixes ?? [])]
}
