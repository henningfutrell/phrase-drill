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
 * The database refusing to be usable — the two conditions IndexedDB reports
 * through a callback rather than by rejecting anything (T072).
 *
 * - **`blocked`** — another connection is holding an older version open, so
 *   the upgrade cannot start. In this app that is a second tab or a stale
 *   service-worker client. Nothing times out: the open promise simply never
 *   settles, so every screen waits forever on a library that is fine.
 * - **`terminated`** — the browser closed the connection without being asked.
 *   Every later call against that handle fails.
 */
export type DatabaseTrouble = 'blocked' | 'terminated'

export interface DatabaseTroubleSource {
  /** Returns an unsubscribe. */
  subscribe(listener: (trouble: DatabaseTrouble) => void): () => void
}

const troubleListeners = new Set<(trouble: DatabaseTrouble) => void>()

/**
 * Where a blocked or terminated database is reported to (T072). A source, not
 * a message: this adapter names the condition and the UI owns the words, so
 * nothing in `adapters/storage` writes a sentence she reads.
 *
 * One module-level registry rather than a parameter on `openDatabase`, because
 * five adapters open this database and the condition belongs to the database,
 * not to whichever of them happened to ask first.
 */
export const databaseTrouble: DatabaseTroubleSource = {
  subscribe(listener) {
    troubleListeners.add(listener)
    return () => {
      troubleListeners.delete(listener)
    }
  },
}

function reportTrouble(trouble: DatabaseTrouble): void {
  for (const listener of [...troubleListeners]) {
    try {
      listener(trouble)
    } catch {
      // A listener is a screen. A screen that fails to render must not stop
      // the other screens being told (the same rule the sync engine's `emit`
      // follows).
    }
  }
}

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
        //
        // **The store is created EMPTY and nothing is backfilled here (T072).**
        // It used to be filled from one `getAll` over the whole clip store,
        // which is ~890 MB at a full library (docs/scale.md §1) held in memory
        // at once, inside a versionchange transaction. On a phone that is an
        // out-of-memory kill — and the next launch runs the same upgrade
        // again, so it is a crashloop with her phrases behind it: permanently
        // unreachable, not transiently broken. A cursor would bound the
        // memory and still read every byte on the launch that upgrades, with
        // the versionchange transaction's auto-commit-on-yield hazard on top.
        // `clip-cache.ts` backfills instead, outside this transaction, in
        // bounded chunks, resumably — and it owns this store anyway.
        db.createObjectStore(CLIP_META_STORE, { keyPath: 'hash' })
      }
    },

    /**
     * Another connection is holding an older version open, so this upgrade
     * cannot start — and nothing will ever end that wait on its own. Say so:
     * the promise this returns stays pending, so without this the app just
     * never finishes loading (T072).
     */
    blocked() {
      reportTrouble('blocked')
    },

    /** The browser closed the connection underneath us. */
    terminated() {
      reportTrouble('terminated')
    },
  })
}
