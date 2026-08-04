import type { IDBPDatabase } from 'idb'
import type { Library } from '../../domain'
import { openDatabase, SETTINGS_STORE } from './database'

/**
 * The last whole-library snapshot this device and the server are known to
 * have agreed on: what this device pushed and the server accepted (T034).
 *
 * `mergeLibraries` needs it to tell "this Deck changed here" from "this Deck
 * changed there" — without a common ancestor the only honest rule is
 * last-write-wins on the whole record, which is what loses a Phrase when two
 * devices edit one Deck between round-trips.
 */
export interface SyncBaselineStore {
  /** `undefined` before the first successful sync, or after eviction. */
  read(): Promise<Library | undefined>
  /** Replaces the previous baseline. Only ever called after a push the server accepted. */
  write(library: Library): Promise<void>
}

/**
 * The key the baseline sits under. It shares the `settings` object store
 * rather than taking one of its own: an object store is a schema version
 * bump and a migration for every existing database, and this is derived,
 * regenerable bookkeeping — losing it costs a merge its precision for one
 * round-trip, nothing more. `settings-store.ts` reads its three keys by name
 * and never enumerates the store, so it cannot see this one.
 *
 * The corollary, which the code did not hold until T081: nothing migrates what
 * is stored here, so a value written by a build at another schema version is
 * read back as-is. `mergeLibraries` treats such a value as no baseline at all
 * — one round-trip of precision, exactly as claimed above — rather than
 * refusing it, which used to stop sync permanently.
 */
const SYNC_BASELINE = 'syncBaseline'

export function createIndexedDbSyncBaselineStore(): SyncBaselineStore {
  let dbPromise: Promise<IDBPDatabase> | undefined

  // A failed open is forgotten again, so one refusal is not replayed for the
  // rest of the session (T087; see `indexed-db-deck-store.ts` for why). The
  // baseline is derived and regenerable, but a store that has given up writes
  // no baseline at all, so every merge for the rest of the session falls back
  // to whole-record rules — the precise case that loses a Phrase when two
  // devices edit one Deck between round-trips.
  function getDatabase(): Promise<IDBPDatabase> {
    dbPromise ??= openDatabase().catch((error: unknown) => {
      dbPromise = undefined
      throw error
    })
    return dbPromise
  }

  return {
    async read(): Promise<Library | undefined> {
      const db = await getDatabase()
      return (await db.get(SETTINGS_STORE, SYNC_BASELINE)) as Library | undefined
    },

    async write(library: Library): Promise<void> {
      const db = await getDatabase()
      await db.put(SETTINGS_STORE, library, SYNC_BASELINE)
    },
  }
}
