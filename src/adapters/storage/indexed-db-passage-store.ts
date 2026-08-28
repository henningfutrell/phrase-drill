import type { Passage, PassageId, PassageStore } from '../../domain'
import { PASSAGES_STORE, TOMBSTONES_STORE, createDatabaseConnection, runTransaction } from './database'
import { fromPassageRecord, toPassageRecord } from './mapping'
import type { PassageRecord, Tombstone } from './migrations'

/**
 * The IndexedDB implementation of `PassageStore`, via `idb`. Every
 * write is a whole-aggregate put to the `passages` store; no operation here
 * ever touches the `decks` or `mixes` store, which is what makes "deleting a
 * Passage never touches a Deck" a structural fact rather than a promise.
 *
 * There is no `update(id, apply)` here, unlike the deck store: a Deck's
 * content is a list the user edits one Phrase at a time, so a whole-Deck put
 * computed from a stale render could write a Phrase away (T075). A Passage's
 * whole content is one text field, so last-writer-wins is already its merge
 * rule — in `library-merge.ts` and here alike — and a read-apply-write
 * transaction would buy nothing. It matches the mix store for the same reason.
 */
export function createIndexedDbPassageStore(): PassageStore {
  // One connection per store instance, opened lazily and reused — the same
  // shape the deck and mix stores use, against the same database and version,
  // down to giving the handle up again when an open is refused (T087) or the
  // browser closes the connection (T077). `createDatabaseConnection` owns why.
  const getDatabase = createDatabaseConnection()

  return {
    async loadAll(): Promise<Passage[]> {
      const db = await getDatabase()
      const records = (await db.getAll(PASSAGES_STORE)) as PassageRecord[]
      return records.map(fromPassageRecord)
    },

    async save(passage: Passage): Promise<void> {
      const db = await getDatabase()
      // Read first so a rewrite keeps the moment the user first made it: only
      // `updatedAt` is theirs to move, and it is what the merge compares.
      const existing = (await db.get(PASSAGES_STORE, passage.id)) as PassageRecord | undefined
      const now = Date.now()
      await db.put(
        PASSAGES_STORE,
        toPassageRecord(passage, { createdAt: existing?.createdAt ?? now, updatedAt: now }),
      )
    },

    /**
     * Deleting a Passage writes a Tombstone in the same transaction (T060),
     * for the same reason the deck and mix stores do: a delete whose
     * Tombstone did not commit is a delete that comes back on the next sync,
     * pushed by every device that still holds the Passage. One transaction is
     * the only ordering under which that cannot happen — not even if the tab
     * is closed between the two writes.
     *
     * It writes only `kind: 'passage'` rows and never reads another kind's —
     * the `decks` and `mixes` stores are still untouched by anything here.
     */
    async remove(id: PassageId): Promise<void> {
      const db = await getDatabase()
      const tx = db.transaction([PASSAGES_STORE, TOMBSTONES_STORE], 'readwrite')
      await runTransaction(tx, async () => {
        await tx.objectStore(PASSAGES_STORE).delete(id)
        await tx
          .objectStore(TOMBSTONES_STORE)
          .put({ id, kind: 'passage', deletedAt: Date.now() } satisfies Tombstone)
      })
    },
  }
}
