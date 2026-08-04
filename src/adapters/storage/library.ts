import { isVoice, LIBRARY_FORMAT, type Library, type Voice } from '../../domain'
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
  | { ok: false; reason: 'not-json' | 'wrong-format' | 'invalid' | 'needs-update' | 'empty' }

/**
 * Validate a restore file before anything touches storage (docs/design.md
 * §3.6 — restore warns, then replaces; it never merges, and it never runs
 * against a file that isn't actually a backup). Pure and total: whatever
 * garbage is handed in, this returns a result, it never throws.
 *
 * Restore is the one path that CLEARS all three object stores before writing
 * (`importAll`), so every refusal here is a wipe that did not happen (T070):
 *
 * - **`needs-update`** — an envelope from a newer build. It cannot be read
 *   down to this schema; accepting it would write a shape this build does not
 *   understand over the one it does.
 * - **`empty`** — a file with no Decks, no Mixes and no Tombstones in it. It
 *   carries nothing, so restoring it can only destroy: if she genuinely has
 *   none, refusing costs her nothing at all, and if the file was truncated or
 *   hand-edited, refusing costs her everything she still has. That asymmetry
 *   is the whole argument.
 * - **`invalid`** — anything whose records are not records. `decks: [null]` is
 *   shaped like a library and is not one.
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
  // Before anything is read out of it: a file this build cannot understand is
  // refused whether or not it has decks in it. `decks.map(migrateDeckRecord)`
  // used to be the only version check in the app, and an empty array runs zero
  // migrations, so a newer build's envelope normalized silently DOWN (T070).
  if (candidate.schemaVersion > CURRENT_SCHEMA_VERSION) {
    return { ok: false, reason: 'needs-update' }
  }
  if (!Number.isInteger(candidate.schemaVersion) || candidate.schemaVersion < 1) {
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

  // `voice` arrived at T067 and reads like the two above: absent is every
  // backup written before then and means "no voice recorded"; present and
  // not a Voice is a corrupt file. A file she chose is refused outright
  // rather than silently repaired — unlike a pulled envelope, where losing
  // the sync of her phrases over a preference field would be the worse
  // failure (see `normalizeLibrary`).
  if (candidate.voice !== undefined && !isVoice(candidate.voice)) {
    return { ok: false, reason: 'invalid' }
  }

  const mixes = (candidate.mixes ?? []) as unknown[]
  const tombstones = (candidate.tombstones ?? []) as unknown[]
  if (
    !candidate.decks.every(isDeckRecord) ||
    !mixes.every(isMixRecord) ||
    !tombstones.every(isTombstone)
  ) {
    return { ok: false, reason: 'invalid' }
  }
  if (candidate.decks.length === 0 && mixes.length === 0 && tombstones.length === 0) {
    return { ok: false, reason: 'empty' }
  }

  return { ok: true, library: candidate as unknown as Library }
}

/** Every field a record must carry, checked before it can replace her library. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDeckRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    Array.isArray(value.phrases) &&
    value.phrases.every(isPhraseRecord)
  )
}

function isPhraseRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.french === 'string' &&
    typeof value.english === 'string'
  )
}

function isMixRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    Array.isArray(value.deckIds) &&
    value.deckIds.every((id) => typeof id === 'string')
  )
}

function isTombstone(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.kind === 'deck' || value.kind === 'mix') &&
    typeof value.deletedAt === 'number'
  )
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
 * and fill in every field a merge reads (the pinned voice included, T067), so `mergeLibraries` compares two
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
  assertReadableSchemaVersion(library.schemaVersion)
  return {
    format: LIBRARY_FORMAT,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: library.exportedAt,
    decks: migrateLibraryDecks(library),
    mixes: migrateLibraryMixes(library),
    tombstones: migrateLibraryTombstones(library),
    voice: migrateLibraryVoice(library),
  }
}

/**
 * The pinned voice of a library (T067), or `undefined` when it has none —
 * which is every envelope written before T067, and is not an error.
 *
 * A malformed voice is dropped rather than thrown on. This runs on the sync
 * path, where the envelope came from the server rather than from a file she
 * chose: refusing it would stop her phrases syncing over a preference field,
 * and a dropped voice costs one tap in Settings. `parseLibraryFile` is
 * stricter on purpose, because there a bad field means a bad file.
 */
export function migrateLibraryVoice(library: Library): Voice | undefined {
  return isVoice(library.voice) ? library.voice : undefined
}

/**
 * Join the pinned voice onto an envelope the deck store built (T067).
 *
 * This is the whole of what settings contributes to a `Library`, and it is
 * named field by field on purpose: the deck store still reads no settings at
 * all, so nothing else in that store has a route into a backup file or onto
 * the wire. `null` produces an envelope with no voice field, which is what
 * "nothing pinned" means everywhere else.
 */
export function withVoice(library: Library, voice: Voice | null): Library {
  return { ...library, voice: voice ?? undefined }
}

/**
 * The Tombstones of a library. Born at schema v5 with one shape, so there
 * is no chain to run — only the question a pre-v5 envelope asks, answered
 * in `normalizeLibrary` above.
 */
export function migrateLibraryTombstones(library: Library): Tombstone[] {
  assertReadableSchemaVersion(library.schemaVersion)
  return [...(library.tombstones ?? [])]
}

/**
 * The version guard, on the envelope rather than on its contents (T070).
 *
 * It used to live only inside `migrateDeckRecord`, once per deck — so a
 * library with no decks ran no guard at all, and `{schemaVersion: 99,
 * decks: []}` came back stamped as current. An envelope from a newer build
 * must be REFUSED, never read down: this build does not know what changed, and
 * the one thing it must not do is write its guess over her library. Throwing
 * is what the sync engine already turns into `needs-update` — "update the app
 * on this phone", never a lost library.
 */
function assertReadableSchemaVersion(schemaVersion: number): void {
  if (schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `library schema version ${schemaVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}`,
    )
  }
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new Error(`library schema version ${schemaVersion} was never written by this app`)
  }
}

/**
 * Migrate every deck record in an imported library to the current schema,
 * using the same pure `migrateDeckRecord` the IDB upgrade path runs — one
 * migration codebase serves both paths.
 */
export function migrateLibraryDecks(library: Library): DeckRecord[] {
  assertReadableSchemaVersion(library.schemaVersion)
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
  assertReadableSchemaVersion(library.schemaVersion)
  return [...(library.mixes ?? [])]
}
