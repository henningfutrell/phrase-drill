/**
 * Deleting one Clip on purpose — the device half of **Regenerate**.
 *
 * A broken Clip (truncated, garbled) is cached on this phone, and `has()`
 * answers `true` for it for as long as it is there: the generation queue
 * skips it, the readiness sweep calls the Phrase drillable, and asking for it
 * again changes nothing. Regenerating has to take it out of the cache first,
 * and take it out the same way eviction does (T078): the audio and its
 * `clipMeta` row in ONE transaction, or an interruption between them leaves
 * an orphaned index row promising audio that is gone.
 *
 * Every test runs the real `clip-cache.ts` against `fake-indexeddb` (T084).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { Clip } from './clip-cache'
import { createIndexedDbClipCache } from './clip-cache'
import { CLIPS_STORE, CLIP_META_STORE, databaseTrouble, openDatabase, type DatabaseTrouble } from './database'
import {
  idbDestructiveOperations,
  idbOperations,
  idbTransactions,
  resetFakeIdb,
  settleIdb,
  terminateOnCommitOfNext,
} from './idb.test-support'

function sizedClip(hash: string, bytes: number): Clip {
  return { hash, bytes: new ArrayBuffer(bytes), mime: 'audio/mpeg', durationMs: 1000, createdAt: 1 }
}

async function residentIn(store: string): Promise<string[]> {
  const db = await openDatabase()
  return ((await db.getAllKeys(store)) as string[]).sort()
}

describe('ClipCache.delete', () => {
  beforeEach(() => {
    resetFakeIdb()
  })

  it('takes the Clip out of the cache: has() is false, get() finds nothing, and usage drops by its bytes', async () => {
    const cache = createIndexedDbClipCache()
    await cache.put(sizedClip('broken', 1000))
    await cache.put(sizedClip('kept', 300))

    await cache.delete('broken')

    expect(await cache.has('broken')).toBe(false)
    expect(await cache.get('broken')).toBeUndefined()
    expect(await cache.has('kept')).toBe(true)
    expect(await cache.usage()).toMatchObject({ bytes: 300, clipCount: 1 })
  })

  it('removes the audio and its index row from the disk, not only from memory', async () => {
    const cache = createIndexedDbClipCache()
    await cache.put(sizedClip('broken', 1000))
    await cache.put(sizedClip('kept', 300))

    await cache.delete('broken')

    // Read back through a fresh connection — what the next launch sees.
    expect(await residentIn(CLIPS_STORE)).toEqual(['kept'])
    expect(await residentIn(CLIP_META_STORE)).toEqual(['kept'])
  })

  it('carries the Clip delete and the index-row delete on one readwrite transaction over both stores (T078)', async () => {
    const cache = createIndexedDbClipCache()
    await cache.put(sizedClip('broken', 1000))
    idbOperations.length = 0

    await cache.delete('broken')

    const deletes = idbOperations.filter((op) => op.op === 'delete')
    expect(deletes.map((op) => op.store).sort()).toEqual([CLIPS_STORE, CLIP_META_STORE].sort())
    const carriers = [...new Set(deletes.map((op) => op.transaction))]
    expect(carriers).toHaveLength(1)
    const carrier = idbTransactions.get(carriers[0])
    expect(carrier?.mode).toBe('readwrite')
    expect([...(carrier?.stores ?? [])].sort()).toEqual([CLIPS_STORE, CLIP_META_STORE].sort())
  })

  it('leaves no index row behind when the phone dies the instant the audio is gone', async () => {
    const cache = createIndexedDbClipCache()
    await cache.put(sizedClip('broken', 1000))
    await cache.put(sizedClip('kept', 300))
    terminateOnCommitOfNext('delete', CLIPS_STORE)
    const reported: DatabaseTrouble[] = []
    const unsubscribe = databaseTrouble.subscribe((trouble) => reported.push(trouble))

    await cache.delete('broken').catch(() => undefined)
    await settleIdb()
    unsubscribe()

    expect(reported).toContain('terminated')
    expect(await residentIn(CLIPS_STORE)).toEqual(['kept'])
    expect(await residentIn(CLIP_META_STORE)).toEqual(['kept'])
  })

  it('is a no-op for a hash the cache does not hold — nothing thrown, nothing else touched', async () => {
    const cache = createIndexedDbClipCache()
    await cache.put(sizedClip('kept', 300))

    await expect(cache.delete('never-cached')).resolves.toBeUndefined()

    expect(await cache.has('kept')).toBe(true)
    expect(await cache.usage()).toMatchObject({ bytes: 300, clipCount: 1 })
  })

  it('reaches the clips and clipMeta stores and nothing else — never a Phrase', async () => {
    const cache = createIndexedDbClipCache()
    await cache.put(sizedClip('broken', 1000))
    idbDestructiveOperations.length = 0

    await cache.delete('broken')

    const touched = new Set(idbDestructiveOperations.map((op) => op.store))
    expect([...touched].sort()).toEqual([CLIPS_STORE, CLIP_META_STORE].sort())
  })
})
