import type { IDBPDatabase } from 'idb'
import type { Mix, MixId, MixStore } from '../../domain'
import { MIXES_STORE, openDatabase } from './database'
import { fromMixRecord, toMixRecord } from './mapping'
import type { MixRecord } from './migrations'

/**
 * The IndexedDB implementation of `MixStore` (T059), via `idb`. Every write
 * is a whole-aggregate put to the `mixes` store; no operation here ever
 * touches the `decks` store, which is what makes "deleting a Mix never
 * touches its source Decks" a structural fact rather than a promise.
 */
export function createIndexedDbMixStore(): MixStore {
  let dbPromise: Promise<IDBPDatabase> | undefined

  // One connection per store instance, opened lazily and reused — the same
  // shape the deck store uses, against the same database and version.
  function getDatabase(): Promise<IDBPDatabase> {
    dbPromise ??= openDatabase()
    return dbPromise
  }

  return {
    async loadAll(): Promise<Mix[]> {
      const db = await getDatabase()
      const records = (await db.getAll(MIXES_STORE)) as MixRecord[]
      return records.map(fromMixRecord)
    },

    async save(mix: Mix): Promise<void> {
      const db = await getDatabase()
      const existing = (await db.get(MIXES_STORE, mix.id)) as MixRecord | undefined
      const now = Date.now()
      await db.put(MIXES_STORE, toMixRecord(mix, { createdAt: existing?.createdAt ?? now, updatedAt: now }))
    },

    async remove(id: MixId): Promise<void> {
      const db = await getDatabase()
      await db.delete(MIXES_STORE, id)
    },
  }
}
