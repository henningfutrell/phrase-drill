/**
 * Evicting a Clip removes the audio and its index row indivisibly (T078).
 *
 * T076 taught the cache to HEAL an index row whose Clip is gone, on the next
 * launch. That is the right safety net and the wrong place to stop: the rows
 * come from somewhere, and the somewhere is eviction — `evictTo` deleted the
 * Clip and then deleted its `clipMeta` row, as two transactions. Interrupted
 * between them (the tab killed, the phone reclaiming the app while she is in a
 * drill) the row outlives the audio it describes. Until the next launch heals
 * it, `has()` answers `true` for audio that is gone, the readiness sweep calls
 * the Phrase drillable, nothing queues it for regeneration, and she taps play
 * and hears nothing.
 *
 * Nothing of hers is lost either way — a Clip is derived and regenerable — so
 * what is at stake is a silent drill, not her handwriting. That is what makes
 * removing the SOURCE the proportionate fix rather than more healing: one
 * transaction, and the class cannot occur.
 *
 * Both tests run the real `clip-cache.ts` against `fake-indexeddb` (T084), so
 * the transaction really holds both stores and a commit really is durable.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { Clip } from './clip-cache'
import { createIndexedDbClipCache } from './clip-cache'
import { CLIPS_STORE, CLIP_META_STORE, databaseTrouble, openDatabase, type DatabaseTrouble } from './database'
import {
  idbOperations,
  idbTransactions,
  resetFakeIdb,
  settleIdb,
  terminateOnCommitOfNext,
} from './idb.test-support'

function sizedClip(hash: string, bytes: number, createdAt: number): Clip {
  return { hash, bytes: new ArrayBuffer(bytes), mime: 'audio/mpeg', durationMs: 1000, createdAt }
}

/**
 * Three Clips on disk, 1000 bytes each, oldest first. Against a 2500-byte
 * ceiling the launch sweep evicts down to 2250 — which is EXACTLY one Clip,
 * so the interruption below lands in the one gap that matters instead of
 * somewhere in the middle of a long sweep.
 */
async function seedThreeClips(): Promise<void> {
  const db = await openDatabase()
  for (const [index, hash] of ['oldest', 'middle', 'newest'].entries()) {
    await db.put(CLIPS_STORE, sizedClip(hash, 1000, index + 1))
  }
}

const CEILING = 2500

async function residentIn(store: string): Promise<string[]> {
  const db = await openDatabase()
  return ((await db.getAllKeys(store)) as string[]).sort()
}

describe('evicting a Clip is one transaction (T078)', () => {
  beforeEach(() => {
    resetFakeIdb()
  })

  it('leaves no index row behind when the phone dies the instant the audio is gone', async () => {
    await seedThreeClips()

    // The interruption: force-close the connection when the transaction that
    // removes the AUDIO commits. Not a simulation of one — `forceCloseDatabase`
    // is fake-indexeddb's own forced close, fired from the real `complete`
    // event, and every later `db.transaction()` then throws exactly as it does
    // on a connection the browser took away. Whatever the eviction managed to
    // put in that one transaction is on the disk; whatever it deferred to a
    // second one never happens.
    terminateOnCommitOfNext('delete', CLIPS_STORE)

    const reported: DatabaseTrouble[] = []
    const unsubscribe = databaseTrouble.subscribe((trouble) => reported.push(trouble))

    // The sweep may or may not survive its own connection being closed; that
    // is not the claim. The claim is what is on the disk afterwards.
    await createIndexedDbClipCache({ maxBytes: CEILING })
      .usage()
      .catch(() => undefined)
    await settleIdb()
    unsubscribe()

    // The interruption really fired. Without this the test could pass one day
    // because eviction became atomic and the next because the kill silently
    // stopped triggering, and the two are indistinguishable from the stores.
    expect(reported).toContain('terminated')

    // Read back through a fresh connection — the only view iOS and the next
    // launch have. The audio and the row went together, or neither went.
    expect(await residentIn(CLIPS_STORE)).toEqual(['middle', 'newest'])
    expect(await residentIn(CLIP_META_STORE)).toEqual(['middle', 'newest'])
  })

  it('carries the Clip delete and the index-row delete on one readwrite transaction over both stores', async () => {
    await seedThreeClips()
    idbOperations.length = 0

    await createIndexedDbClipCache({ maxBytes: CEILING }).usage()

    const evictions = idbOperations.filter(
      (op) => op.op === 'delete' && (op.store === CLIPS_STORE || op.store === CLIP_META_STORE),
    )
    expect(evictions.map((op) => op.store).sort()).toEqual([CLIPS_STORE, CLIP_META_STORE].sort())

    const carriers = [...new Set(evictions.map((op) => op.transaction))]
    expect(carriers).toHaveLength(1)

    const carrier = idbTransactions.get(carriers[0])
    expect(carrier?.mode).toBe('readwrite')
    expect([...(carrier?.stores ?? [])].sort()).toEqual([CLIPS_STORE, CLIP_META_STORE].sort())
  })
})
