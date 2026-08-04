import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Clip } from './clip-cache'
import { resetFakeIdb } from './idb.test-support'

/**
 * What the clip cache does when the device refuses a write (T085, from the
 * T080 audit — findings 7 and 8).
 *
 * Only audio is at stake here: a Clip is derived from Phrase text and can
 * always be made again, so nothing of hers is lost either way. What is at
 * stake is whether she can hear anything for the rest of the session. Both
 * defects have the same shape — one refusal, and the cache carries a wrong
 * belief about itself until the app is relaunched:
 *
 * - **A refused write that the index records anyway.** `put` updated its
 *   in-memory index before the database accepted the write, so a
 *   `QuotaExceededError` left the index claiming audio the disk does not
 *   have. `has()` then answers `true`, the readiness sweep calls the Phrase
 *   drillable, nothing is queued for generation, and `get()` returns
 *   `undefined` at the moment she needs the sound. Silence, with no
 *   explanation and nothing trying to fix it.
 * - **A memoized rejection.** The database handle and the size index are each
 *   cached in a promise that is created once. A promise that rejects is still
 *   a settled promise, so one transient failure — iOS killing a transaction
 *   under memory pressure — was remembered and replayed for every later call.
 *
 * The `idb` seam is faked as everywhere else in this directory, wrapped here
 * so a single call can be made to fail on demand.
 */

const control = vi.hoisted(() => ({
  /** How many further `openDB` calls reject. */
  failingOpens: 0,
  /** How many further `put`s reject with a `QuotaExceededError`. */
  quotaPuts: 0,
}))

vi.mock('idb', async () => {
  const fake = await import('./idb.test-support')
  return {
    openDB: async (...args: Parameters<typeof fake.openDB>) => {
      if (control.failingOpens > 0) {
        control.failingOpens--
        throw new Error('idb: the database could not be opened')
      }
      const db = await fake.openDB(...args)
      return {
        ...db,
        put: async (storeName: string, value: unknown, key?: unknown) => {
          if (control.quotaPuts > 0) {
            control.quotaPuts--
            const error = new Error('The quota has been exceeded.')
            error.name = 'QuotaExceededError'
            throw error
          }
          return db.put(storeName, value, key)
        },
      }
    },
  }
})

const { createIndexedDbClipCache } = await import('./clip-cache')

function clipOf(hash: string, size: number): Clip {
  return {
    hash,
    bytes: new ArrayBuffer(size),
    mime: 'audio/mpeg',
    durationMs: 900,
    createdAt: 1_700_000_000_000,
  }
}

describe('the clip cache when a write is refused', () => {
  beforeEach(() => {
    resetFakeIdb()
    control.failingOpens = 0
    control.quotaPuts = 0
  })

  it('frees space and writes the Clip anyway when the device says it is full', async () => {
    const cache = createIndexedDbClipCache()
    await cache.put(clipOf('oldest', 1_000))
    await cache.put(clipOf('newer', 1_000))

    control.quotaPuts = 1
    await cache.put(clipOf('wanted', 1_000))

    expect(await cache.has('wanted')).toBe(true)
    expect(await cache.get('wanted')).toMatchObject({ hash: 'wanted' })
    // Least recently played went first — the Clip she has not drilled longest.
    expect(await cache.has('oldest')).toBe(false)
  })

  it('never claims to hold audio the device refused to write', async () => {
    const cache = createIndexedDbClipCache()

    control.quotaPuts = 10
    await expect(cache.put(clipOf('refused', 1_000))).rejects.toThrow(/quota/i)

    // The index is what `has()` and the readiness sweep answer from. A `true`
    // here is a Phrase reported drillable that plays nothing and is never
    // queued for regeneration.
    expect(await cache.has('refused')).toBe(false)
    expect((await cache.usage()).clipCount).toBe(0)
    expect((await cache.usage()).bytes).toBe(0)
  })

  it('recovers from one transient database failure instead of staying broken for the session', async () => {
    const cache = createIndexedDbClipCache()

    control.failingOpens = 1
    await expect(cache.has('anything')).rejects.toThrow()

    await cache.put(clipOf('later', 1_000))
    expect(await cache.has('later')).toBe(true)
    expect(await cache.get('later')).toMatchObject({ hash: 'later' })
  })

  it('still returns the audio it read when only the play-time bookkeeping fails', async () => {
    const cache = createIndexedDbClipCache()
    await cache.put(clipOf('playable', 1_000))

    // The Clip is on the disk and was read. Failing to re-date it changes
    // which Clip is evicted next; it must not turn into silence now.
    control.quotaPuts = 1
    expect(await cache.get('playable')).toMatchObject({ hash: 'playable' })
  })
})
