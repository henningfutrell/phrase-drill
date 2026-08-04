import { openDB, type IDBPDatabase } from 'idb'
import { CURRENT_SCHEMA_VERSION, migrateDeckRecord } from './migrations'

export const DB_NAME = 'phrase-drill'
export const DECKS_STORE = 'decks'
export const SETTINGS_STORE = 'settings'
/**
 * Content-addressed cache of synthesized audio (T019 §5.2). Keyed by a
 * SHA-256 hash of `provider|modelId|voiceId|lang|text` — see `clip-cache.ts`.
 * Derived, regenerable cache, not user data: never read by `exportAll`.
 */
export const CLIPS_STORE = 'clips'
/**
 * The size index over `clips` (T036): one tiny `{ hash, bytes, lastUsedAt }`
 * row per cached Clip, so the cache can answer "how much am I holding?" and
 * "what has she not drilled in longest?" without loading a single byte of
 * audio. `clip-cache.ts` owns the record shape and is the only writer.
 *
 * A separate store rather than fields on the Clip itself, because the whole
 * point is that reading the index is cheap: `getAll` over `clips` pulls every
 * `ArrayBuffer` off disk through structured clone (docs/scale.md §3), which
 * at a full cache is hundreds of MB for a question about numbers.
 */
export const CLIP_META_STORE = 'clipMeta'
/**
 * Bounded ring buffer of captured errors (T039 diagnostics — `error-log.ts`
 * owns the cap/trim logic; this store just holds whatever it decides to
 * keep). Keyed by an incrementing numeric `id` so entries can be listed
 * oldest-to-newest and the oldest trimmed first.
 */
export const ERRORS_STORE = 'errors'
/**
 * Saved Mixes (T059 — `indexed-db-mix-store.ts` owns the record shape).
 * Keyed by the Mix's own id. A Mix names its Decks by id and lives in its
 * own store: deleting a Mix cannot reach the `decks` store, and deleting a
 * Deck cannot reach this one.
 */
export const MIXES_STORE = 'mixes'
/**
 * What has been deleted, and when (T060 — `Tombstone` in the domain owns
 * why a deletion has to be data). One row per deleted Deck or Mix, keyed by
 * the id it names, carrying `kind` so a Deck's Tombstone can never reach a
 * Mix.
 *
 * Written by both the deck store and the mix store, which is the one place
 * those two adapters share a store. Each writes only its own `kind`, and
 * neither ever reads or removes the other's rows, so "deleting a Mix never
 * touches a Deck" still holds.
 *
 * **Never garbage-collected, deliberately.** A Tombstone is what stops a
 * device that has been offline from pushing a deleted Deck back, so any
 * expiry window is also the window after which an old device resurrects her
 * data. Two devices in one pair of hands produce a handful of these — a few
 * dozen bytes each — so unbounded growth is cheaper than the resurrection
 * bug, and there is no size at which that trade flips for this app.
 */
export const TOMBSTONES_STORE = 'tombstones'

/**
 * Opens the one IndexedDB database this app uses. All stores are declared
 * here, in the single upgrade path, even though `decks`, `settings`, and
 * `clips` are each exposed through their own adapter
 * (`indexed-db-deck-store.ts`, `settings-store.ts`, `clip-cache.ts`): they
 * share one database and one version number (T002 §4), so they share one
 * place that defines the schema. Nothing outside `adapters/storage` opens
 * this database.
 */
export function openDatabase(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, CURRENT_SCHEMA_VERSION, {
    async upgrade(db, oldVersion, _newVersion, transaction) {
      if (!db.objectStoreNames.contains(DECKS_STORE)) {
        db.createObjectStore(DECKS_STORE, { keyPath: 'id' })
      } else if (oldVersion < CURRENT_SCHEMA_VERSION) {
        // A schema bump lands its migration here, running the same pure
        // migrateDeckRecord that importAll runs — one migration codebase
        // for both paths. Awaited (not fire-and-forget) so the versionchange
        // transaction genuinely waits for every record to be rewritten
        // before it can auto-commit.
        const store = transaction.objectStore(DECKS_STORE)
        const records = (await store.getAll()) as unknown[]
        for (const record of records) {
          await store.put(migrateDeckRecord(record, oldVersion))
        }
      }
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE)
      }
      if (!db.objectStoreNames.contains(CLIPS_STORE)) {
        // v1 -> v2, additive: existing decks/settings pass through
        // untouched (see the branches above); this store is new.
        db.createObjectStore(CLIPS_STORE, { keyPath: 'hash' })
      }
      if (!db.objectStoreNames.contains(ERRORS_STORE)) {
        // v2 -> v3, additive: every other store passes through untouched.
        db.createObjectStore(ERRORS_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(MIXES_STORE)) {
        // v3 -> v4, additive: saved Mixes land in their own store, so every
        // existing Deck and Phrase passes through untouched (the branches
        // above).
        db.createObjectStore(MIXES_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(TOMBSTONES_STORE)) {
        // v4 -> v5, additive: an existing database gains one empty store.
        // Empty is the truth — nothing was recorded as deleted before v5 —
        // and every existing Deck, Phrase and Mix passes through untouched
        // (the branches above).
        db.createObjectStore(TOMBSTONES_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(CLIP_META_STORE)) {
        // v5 -> v6, additive: the size index over an already-existing clip
        // cache. Every Deck, Phrase, Mix and Tombstone passes through
        // untouched (the branches above).
        db.createObjectStore(CLIP_META_STORE, { keyPath: 'hash' })
        // Backfill from whatever is already cached, so a phone upgrading into
        // this build keeps its audio instead of re-fetching it. `lastUsedAt`
        // seeds from `createdAt`: nothing recorded when a Clip was last
        // played before this store existed, and generation order is the only
        // honest answer available. This reads the whole clip store once, in
        // the versionchange transaction — the one time that cost is paid.
        const clips = (await transaction.objectStore(CLIPS_STORE).getAll()) as {
          hash: string
          bytes: ArrayBuffer
          createdAt: number
        }[]
        const meta = transaction.objectStore(CLIP_META_STORE)
        for (const clip of clips) {
          await meta.put({ hash: clip.hash, bytes: clip.bytes.byteLength, lastUsedAt: clip.createdAt })
        }
      }
    },
  })
}
