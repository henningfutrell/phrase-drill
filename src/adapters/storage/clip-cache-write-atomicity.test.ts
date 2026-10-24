/**
 * Writing a Clip commits the audio and its index row indivisibly — the mirror
 * image of T078 (`clip-cache-eviction-atomicity.test.ts`).
 *
 * `writeClip` put the Clip and its `clipMeta` row as two `idb` convenience
 * calls — `db.put(...)` auto-commits its own transaction — so an interruption
 * between them leaves audio on disk with no row describing it. `has()` and
 * `readyClips` answer from the index alone, so that orphan reports real,
 * playable audio as NOT ready: silently excluded from the drill, or silently
 * regenerated at cost, and never charged against the 200 MB ceiling either
 * (the ceiling under-counts exactly what it is supposed to bind). It only
 * self-heals at the next launch's `reconcileIndex`.
 *
 * All four tests run the real `clip-cache.ts` against `fake-indexeddb`
 * (T084), so a transaction really holds both stores, an abort really rolls
 * back, and a commit is really durable.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { Clip } from './clip-cache'
import { createIndexedDbClipCache } from './clip-cache'
import { CLIPS_STORE, CLIP_META_STORE, databaseTrouble, openDatabase, type DatabaseTrouble } from './database'
import {
  failNextWriteTo,
  idbOperations,
  idbTransactions,
  resetFakeIdb,
  settleIdb,
  terminateOnCommitOfNext,
} from './idb.test-support'

function clipOf(hash: string, size = 1000): Clip {
  return { hash, bytes: new ArrayBuffer(size), mime: 'audio/mpeg', durationMs: 900, createdAt: 1_700_000_000_000 }
}

async function residentIn(store: string): Promise<string[]> {
  const db = await openDatabase()
  return ((await db.getAllKeys(store)) as string[]).sort()
}

describe('writing a Clip is one transaction', () => {
  beforeEach(() => {
    resetFakeIdb()
  })

  it('leaves no orphaned audio when the phone dies the instant the first write commits', async () => {
    const reported: DatabaseTrouble[] = []
    const unsubscribe = databaseTrouble.subscribe((trouble) => reported.push(trouble))

    // The interruption: force-close the connection the moment the transaction
    // carrying the CLIPS_STORE put commits. Two transactions: that fires
    // before the meta row is ever written, so the row never lands. One
    // transaction spanning both stores: `complete` fires only once the whole
    // pair — audio AND row — is already durable, so the close lands too late
    // to split them.
    terminateOnCommitOfNext('put', CLIPS_STORE)

    await createIndexedDbClipCache()
      .put(clipOf('solo'))
      .catch(() => undefined)
    await settleIdb()
    unsubscribe()

    // The interruption really fired, so this is not passing by the fixture
    // silently failing to trigger.
    expect(reported).toContain('terminated')

    // Read back through a fresh connection — the only view iOS and the next
    // launch have. The audio and its row went together, or neither went.
    expect(await residentIn(CLIPS_STORE)).toEqual(['solo'])
    expect(await residentIn(CLIP_META_STORE)).toEqual(['solo'])
  })

  it('carries the Clip put and the index-row put on one readwrite transaction over both stores', async () => {
    idbOperations.length = 0

    await createIndexedDbClipCache().put(clipOf('paired'))

    const writes = idbOperations.filter(
      (op) => op.op === 'put' && (op.store === CLIPS_STORE || op.store === CLIP_META_STORE),
    )
    expect(writes.map((op) => op.store).sort()).toEqual([CLIPS_STORE, CLIP_META_STORE].sort())

    const carriers = [...new Set(writes.map((op) => op.transaction))]
    expect(carriers).toHaveLength(1)

    const carrier = idbTransactions.get(carriers[0])
    expect(carrier?.mode).toBe('readwrite')
    expect([...(carrier?.stores ?? [])].sort()).toEqual([CLIPS_STORE, CLIP_META_STORE].sort())
  })

  it('leaves neither audio nor row when the retry after eviction is also refused — no crash required', async () => {
    // A full origin alone reproduces this: both the first attempt and the
    // single post-eviction retry get refused on the META store, and nothing
    // ever throws anything but QuotaExceededError. With two transactions the
    // audio put never fails, so the old code committed it every time
    // regardless of whether put() itself threw — an orphan with no
    // interruption in sight. One transaction rolls the audio back with the
    // row it failed to write.
    failNextWriteTo(CLIP_META_STORE, 'QuotaExceededError', 2)

    const cache = createIndexedDbClipCache()
    await expect(cache.put(clipOf('doomed'))).rejects.toThrow(/quota/i)

    expect(await residentIn(CLIPS_STORE)).toEqual([])
    expect(await residentIn(CLIP_META_STORE)).toEqual([])
  })

  it('commits audio and row exactly once when the retry after eviction succeeds', async () => {
    // T085's quota retry is the second transaction `writeClip` can open. The
    // first attempt is refused on the META store, eviction makes room, and the
    // retry writes the pair again. Each attempt must span both stores, so the
    // refused one leaves nothing behind and the retry leaves exactly one Clip
    // and one row — not a stray audio write, and not a lost index row.
    const cache = createIndexedDbClipCache()
    for (const hash of ['old-a', 'old-b', 'old-c']) await cache.put(clipOf(hash))

    idbOperations.length = 0
    failNextWriteTo(CLIP_META_STORE, 'QuotaExceededError', 1)

    await cache.put(clipOf('fresh'))

    // Eviction ran (the oldest Clip went), and the stores agree with each
    // other through a fresh connection.
    expect(await residentIn(CLIPS_STORE)).toEqual(['fresh', 'old-b', 'old-c'])
    expect(await residentIn(CLIP_META_STORE)).toEqual(['fresh', 'old-b', 'old-c'])

    // The in-memory index counts the retried Clip once.
    expect(await cache.has('fresh')).toBe(true)
    expect(await cache.usage()).toMatchObject({ clipCount: 3, bytes: 3000 })

    // Two attempts, and each one carried the Clip and its row together.
    const writes = idbOperations.filter(
      (op) => op.op === 'put' && (op.store === CLIPS_STORE || op.store === CLIP_META_STORE),
    )
    const carriers = [...new Set(writes.map((op) => op.transaction))]
    expect(carriers).toHaveLength(2)
    for (const id of carriers) {
      expect([...(idbTransactions.get(id)?.stores ?? [])].sort()).toEqual([CLIPS_STORE, CLIP_META_STORE].sort())
    }
  })
})
