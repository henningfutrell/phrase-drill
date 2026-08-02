import type { DeckRecord, PhraseRecord } from '../../domain'

/** The current on-disk shape for a deck record, re-exported for local use. */
export type { DeckRecord }

/** Schema version 1's shape — identical to `DeckRecord` today, since v1 is current. */
export type DeckRecordV1 = DeckRecord
export type PhraseRecordV1 = PhraseRecord

/**
 * The IndexedDB `upgrade(db, oldVersion)` callback and `importAll` run this
 * exact number as the target of every migration. Bump it, and add the
 * matching step to `DECK_MIGRATIONS`, in the same change as any record shape
 * change — this is the versioning rule the user's saved phrases depend on.
 */
export const CURRENT_SCHEMA_VERSION = 1

/** One step of a migration chain: a pure transform from a version-n record to version-(n+1). */
export type RecordMigration = (record: never) => unknown

/**
 * Apply a chain of pure migrations to bring a record from `fromVersion` to
 * `toVersion`, oldest-to-newest. `migrations[n]` must transform a version-n
 * record to a version-(n+1) record. Kept generic (independent of the deck
 * record shape) so the chaining behaviour itself is testable with fixture
 * migrations, regardless of how many real deck schema versions exist.
 */
export function applyMigrations(
  record: unknown,
  fromVersion: number,
  toVersion: number,
  migrations: readonly RecordMigration[],
): unknown {
  if (fromVersion > toVersion) {
    throw new Error(
      `record schema version ${fromVersion} is newer than supported version ${toVersion}`,
    )
  }
  let migrated = record
  for (let version = fromVersion; version < toVersion; version += 1) {
    const migrate = migrations[version]
    if (!migrate) {
      throw new Error(`no migration registered from schema version ${version} to ${version + 1}`)
    }
    migrated = migrate(migrated as never)
  }
  return migrated
}

/**
 * No migrations yet — schema version 1 is the only shape a deck record has
 * ever had. The next record shape change adds a step here, indexed by the
 * version it migrates *from* (`DECK_MIGRATIONS[1]` migrates v1 -> v2).
 */
const DECK_MIGRATIONS: readonly RecordMigration[] = []

/**
 * Bring a deck record from `fromVersion` up to the current schema. The same
 * function is called from the IDB `upgrade` callback (one record shape
 * change at a time, on the browser's own copy) and from `importAll` (an
 * imported file's `schemaVersion` may lag) — one migration codebase serves
 * both, per the versioning rule.
 */
export function migrateDeckRecord(record: unknown, fromVersion: number): DeckRecord {
  return applyMigrations(record, fromVersion, CURRENT_SCHEMA_VERSION, DECK_MIGRATIONS) as DeckRecord
}
