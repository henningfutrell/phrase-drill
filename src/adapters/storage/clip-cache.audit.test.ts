import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Clip } from './clip-cache'
import { openDB as fakeOpenDB, resetFakeIdb } from './idb.test-support'

/**
 * T080 audit of T076 (`src/adapters/storage/clip-cache.ts`).
 *
 * These tests are EXPECTED TO FAIL against the code as it stands. They are
 * evidence, not a fix.
 *
 * The `idb` mock here wraps the shared test double so a single named operation
 * on a single store can be made to reject — which is what a phone actually
 * does: `QuotaExceededError` on a write, or a connection iOS killed mid-read.
 * The double itself is unchanged.
 */

interface Fault {
  op: 'get' | 'getAll' | 'getAllKeys' | 'put' | 'delete'
  store: string
  error: Error
  /** Skip this many matching calls before failing. */
  after?: number
}

const faults: Fault[] = []

function checkFault(op: Fault['op'], store: string): void {
  for (const fault of faults) {
    if (fault.op !== op || fault.store !== store) continue
    if (fault.after && fault.after > 0) {
      fault.after -= 1
      continue
    }
    throw fault.error
  }
}

vi.mock('idb', async () => {
  const fake = await import('./idb.test-support')
  return {
    async openDB(name: string, version: number, callbacks?: Record<string, unknown>) {
      const db = (await fake.openDB(name, version, callbacks as never)) as Record<string, unknown>
      const wrap =
        (op: Fault['op']) =>
        async (store: string, ...rest: unknown[]) => {
          checkFault(op, store)
          return (db[op] as (...args: unknown[]) => Promise<unknown>)(store, ...rest)
        }
      return { ...db, get: wrap('get'), getAll: wrap('getAll'), getAllKeys: wrap('getAllKeys'), put: wrap('put'), delete: wrap('delete') }
    },
  }
})

const { createIndexedDbClipCache, computeClipHash } = await import('./clip-cache')
const { CLIPS_STORE, CLIP_META_STORE } = await import('./database')

const VOICE = { provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-1' }

function clip(hash: string, size: number, createdAt = 1): Clip {
  return { hash, bytes: new ArrayBuffer(size), mime: 'audio/mpeg', durationMs: 1_000, createdAt }
}

describe('T080 audit — T076 clip cache', () => {
  beforeEach(() => {
    resetFakeIdb()
    faults.length = 0
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(true) } })
  })

  /**
   * FINDING 4 (low severity, audio only — but it is exactly the condition the
   * 200 MB ceiling exists to survive).
   *
   * `put` mutates the in-memory index and `totalBytes` BEFORE it writes
   * anything:
   *
   *     index.set(clip.hash, meta); totalBytes += meta.bytes
   *     await db.put(CLIPS_STORE, clip)      // <- QuotaExceededError here
   *
   * When that write rejects, the row is never persisted but the in-memory
   * index keeps it for the rest of the session. `has()` is answered from the
   * index, so it answers `true` for audio that does not exist; `readyPhraseIds`
   * therefore reports the Phrase as drillable and the generation queue never
   * re-enqueues it, while `get()` returns `undefined` and there is nothing to
   * play. `totalBytes` is also permanently inflated by a Clip that was never
   * stored, so the next sweep evicts real audio to make room for it.
   *
   * The comment on `reconcileIndex` claims the two directions of drift
   * self-heal. They do — on the NEXT LAUNCH. Within the session that created
   * the drift, nothing does.
   */
  it('a clip whose write was refused is not left in the index as present', async () => {
    const cache = createIndexedDbClipCache()
    const hash = await computeClipHash({ ...VOICE, lang: 'fr-FR', text: 'le pain' })

    faults.push({ op: 'put', store: CLIPS_STORE, error: new Error('QuotaExceededError') })
    await expect(cache.put(clip(hash, 1_000))).rejects.toThrow()
    faults.length = 0

    expect(await cache.get(hash)).toBeUndefined()
    // The index must not claim audio the disk does not have.
    expect(await cache.has(hash)).toBe(false)
    expect((await cache.usage()).bytes).toBe(0)
  })

  /**
   * FINDING 5 (low severity, audio only, session-long).
   *
   * `getIndex` memoizes `indexPromise` with `??=` and the whole of the launch
   * work — `reconcileIndex` plus `evictDownToTarget` — runs inside that one
   * promise. Neither is wrapped, and every step is an unguarded `db.delete` /
   * `db.put` / `db.get`. One transient IndexedDB failure anywhere in there
   * leaves `indexPromise` permanently REJECTED, and the memo is never cleared.
   *
   * From that instant every `has()`, `put()`, `readyPhraseIds()` and `usage()`
   * on this cache rejects for the rest of the session — and the composition
   * root makes exactly one cache. The drill readiness sweep and the generation
   * queue both go down with it. Only relaunching the app clears it, and there
   * is nothing on screen that says so.
   *
   * This is the same shape as the failure T076's own doc comment worries about
   * ("a hang with no timeout, on the index every screen waits for"), reached by
   * rejection rather than by deadlock.
   */
  it('one failed delete during the launch sweep does not disable the cache for the session', async () => {
    // A cache already holding a row whose audio is gone — precisely the orphan
    // T076 added `reconcileIndex` to clean up.
    const { openDatabase } = await import('./database')
    const db = await openDatabase()
    await db.put(CLIP_META_STORE, { hash: 'orphan', bytes: 500, lastUsedAt: 1 })
    await db.put(CLIPS_STORE, clip('real', 100))

    const cache = createIndexedDbClipCache()
    faults.push({ op: 'delete', store: CLIP_META_STORE, error: new Error('connection closed') })

    await expect(cache.has('real')).rejects.toThrow()
    faults.length = 0

    // The condition has passed. The cache must recover on its next call.
    expect(await cache.has('real')).toBe(true)
  })

  /** Control: the launch sweep and the orphan cleanup work when nothing fails. */
  it('control — reconciliation drops an orphaned row and backfills an unindexed clip', async () => {
    const { openDatabase } = await import('./database')
    const db = await openDatabase()
    await db.put(CLIP_META_STORE, { hash: 'orphan', bytes: 500, lastUsedAt: 1 })
    await db.put(CLIPS_STORE, clip('real', 100))

    const cache = createIndexedDbClipCache()
    expect(await cache.has('orphan')).toBe(false)
    expect(await cache.has('real')).toBe(true)
    expect((await cache.usage()).bytes).toBe(100)
  })
})
