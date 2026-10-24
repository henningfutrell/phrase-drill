// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createClipJobStore } from './clip-job-store.js'
import { createLibraryStore } from './db.js'

/**
 * T096, item 4 — a `ROLLBACK` that itself fails (T091 audit).
 *
 * Both transactions on the server swallow a failed `ROLLBACK`, so the real
 * error reaches the caller. They then called `client.release()` with no
 * argument, which tells `pg` the connection is clean and puts it back in the
 * pool. A connection whose rollback failed is not clean: it can still be
 * inside the aborted transaction, and the next request that leases it fails
 * for no reason of its own. `release(err)` is how `pg` is told to destroy it.
 */
function poolWhereEveryStatementFails() {
  const released = []
  return {
    released,
    async connect() {
      return {
        async query(text) {
          if (text.trim() === 'BEGIN') return { rows: [] }
          throw new Error(
            text.trim() === 'ROLLBACK'
              ? 'rollback: connection lost'
              : 'statement refused',
          )
        },
        release(err) {
          released.push(err)
        },
      }
    },
  }
}

describe('a ROLLBACK that fails destroys the connection instead of pooling it (T096)', () => {
  it('library store put', async () => {
    const pool = poolWhereEveryStatementFails()

    await expect(createLibraryStore(pool).put('key', '{}', 1)).rejects.toThrow(
      'statement refused',
    )

    expect(pool.released).toHaveLength(1)
    expect(pool.released[0]).toBeInstanceOf(Error)
  })

  it('clip job store request', async () => {
    const pool = poolWhereEveryStatementFails()
    const fields = {
      hash: 'h1',
      provider: 'elevenlabs',
      modelId: 'm',
      voiceId: 'v',
      lang: 'fr',
      text: 'bonjour',
    }

    await expect(createClipJobStore(pool).request(fields, 1)).rejects.toThrow(
      'statement refused',
    )

    expect(pool.released).toHaveLength(1)
    expect(pool.released[0]).toBeInstanceOf(Error)
  })

  it('a ROLLBACK that succeeds still returns the connection to the pool', async () => {
    const released = []
    const pool = {
      async connect() {
        return {
          async query(text) {
            if (['BEGIN', 'ROLLBACK'].includes(text.trim())) return { rows: [] }
            throw new Error('statement refused')
          },
          release(err) {
            released.push(err)
          },
        }
      },
    }

    await expect(createLibraryStore(pool).put('key', '{}', 1)).rejects.toThrow(
      'statement refused',
    )

    expect(released).toEqual([undefined])
  })
})
