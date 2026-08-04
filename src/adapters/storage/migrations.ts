import type { DeckRecord, MixRecord, PhraseRecord } from '../../domain'

/** The current on-disk shapes, re-exported for local use. */
export type { DeckRecord, MixRecord }

/** Schema version 1's shape — identical to `DeckRecord` today, since v1 is current. */
export type DeckRecordV1 = DeckRecord
export type PhraseRecordV1 = PhraseRecord

/**
 * The IndexedDB `upgrade(db, oldVersion)` callback and `importAll` run this
 * exact number as the target of every migration. Bump it, and add the
 * matching step to `DECK_MIGRATIONS`, in the same change as any record shape
 * change — this is the versioning rule the user's saved phrases depend on.
 *
 * v1 -> v2 (T021): the `clips` store was added. Deck records are untouched —
 * see `DECK_MIGRATIONS[1]` below — but the database version, and therefore
 * `Library.schemaVersion`, still advances, because the two are one number
 * by design (T002 §4).
 *
 * v2 -> v3 (T039): the `errors` store was added for the diagnostics ring
 * buffer. Deck records are untouched — see `DECK_MIGRATIONS[2]` below.
 *
 * v3 -> v4 (T059): the `mixes` store was added, for saved Mixes. Deck
 * records are untouched — a Mix names its Decks by id and stores nothing
 * inside them — see `DECK_MIGRATIONS[3]` below.
 */
export const CURRENT_SCHEMA_VERSION = 4

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
 * Indexed by the version each step migrates *from*
 * (`DECK_MIGRATIONS[1]` migrates v1 -> v2). Index 0 (v0 -> v1) never
 * existed — v1 was the first shape a deck record ever had — so it is a
 * throwing placeholder rather than a silent gap.
 */
const neverExisted: RecordMigration = (() => {
  throw new Error('schema version 0 never existed; there is nothing to migrate from')
}) as RecordMigration

/**
 * v1 -> v2: the `clips` store landed beside `decks`, not inside it — the
 * deck record shape itself does not change, so this step is identity.
 */
const v1ToV2: RecordMigration = ((record: DeckRecordV1) => record) as RecordMigration

/**
 * v2 -> v3: the `errors` store landed beside `decks` — the deck record
 * shape itself does not change, so this step is identity, same as v1 -> v2.
 */
const v2ToV3: RecordMigration = ((record: DeckRecordV1) => record) as RecordMigration

/**
 * v3 -> v4: the `mixes` store landed beside `decks`. A saved Mix holds the
 * *ids* of its Decks, so nothing was added to or taken from a deck record
 * and this step is identity too. The database version still advances,
 * because it and `Library.schemaVersion` are one number by design.
 */
const v3ToV4: RecordMigration = ((record: DeckRecordV1) => record) as RecordMigration

/**
 * Exported so `DECK_MIGRATIONS.length` can be checked against
 * `CURRENT_SCHEMA_VERSION` directly (persisted-shape.test.ts) — the two
 * must move together, and that test is what turns a mismatch into a build
 * failure instead of a runtime throw on the user's device.
 */
export const DECK_MIGRATIONS: readonly RecordMigration[] = [neverExisted, v1ToV2, v2ToV3, v3ToV4]

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
