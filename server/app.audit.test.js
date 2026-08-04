// @vitest-environment node
/**
 * AUDIT-T080 — the end-to-end version of probe 1, over real HTTP.
 *
 * `server/db.audit.test.js` breaks the store in isolation. This proves the
 * break is reachable through `PUT /api/library` with a body the route accepts
 * as valid, using the wall clock `app.js` actually passes (`Date.now()`), with
 * nothing stubbed but the session and the providers.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.js'
import { createLibraryStore, createClipStore } from './db.js'
import { fakeLibraryPool, fakeClipPool } from './pool.test-support.js'
import { createRateLimiter } from './rate-limiter.js'

const TOKEN = 'valid-token'
const SUB = 'user-1111'

function envelope(phraseCount, deckName) {
  return {
    format: 'phrase-drill-library',
    schemaVersion: 3,
    exportedAt: 0,
    decks: phraseCount === 0 ? [] : [{ id: 'd1', name: deckName, phrases: Array.from({ length: phraseCount }, (_, i) => ({ id: `p${i}`, fr: `f${i}`, en: `e${i}` })) }],
  }
}

describe('AUDIT-T080 — PUT /api/library, end to end', () => {
  let server
  let baseUrl
  let libraryStore
  let distDir

  async function boot() {
    const pool = fakeLibraryPool()
    libraryStore = createLibraryStore(pool)
    await libraryStore.init()
    const clipStore = createClipStore(fakeClipPool())
    await clipStore.init()
    distDir = mkdtempSync(join(tmpdir(), 'phrase-drill-audit-'))
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>x</title>')

    const noop = () => {}
    const handleRequest = createApp({
      libraryStore,
      clipStore,
      elevenLabs: { async synthesize() { throw new Error('unused') } },
      anthropic: { async scan() { throw new Error('unused') }, async translate() { throw new Error('unused') } },
      ttsLimiter: createRateLimiter({ capacity: 100, refillMs: 60_000 }),
      scanLimiter: createRateLimiter({ capacity: 100, refillMs: 60_000 }),
      libraryLimiter: createRateLimiter({ capacity: 100, refillMs: 60_000 }),
      loginLimiter: createRateLimiter({ capacity: 100, refillMs: 60_000 }),
      translateLimiter: createRateLimiter({ capacity: 100, refillMs: 60_000 }),
      distDir,
      logger: { info: noop, warn: noop, error: noop },
      sessionAuth: {
        async verify(token) {
          if (token !== TOKEN) throw new Error('bad token')
          return { sub: SUB }
        },
        async login() { return null },
        async logout() {},
      },
    })

    server = createServer(handleRequest)
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${server.address().port}`
  }

  function put(body) {
    return fetch(`${baseUrl}/api/library`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve))
    if (libraryStore) await libraryStore.close()
    if (distDir) rmSync(distDir, { recursive: true, force: true })
  })

  /**
   * Three pushes in one editing session, exactly as the 2-second sync debounce
   * produces them (docs/sync.md). The route accepts all three with 204 — the
   * third has `decks: []`, which `isLibraryEnvelope` considers perfectly valid
   * and which is what a device whose IndexedDB opened empty would send.
   *
   * The first push archives nothing (no previous row). The second archives the
   * first. The third is inside the hour, so it archives NOTHING: the 900-phrase
   * state is destroyed. Recovery reaches only the 400-phrase state.
   */
  it('A1 — an empty library pushed inside the snapshot hour is accepted 204 and the replaced version is unrecoverable', async () => {
    await boot()

    expect((await put(envelope(400, 'monday'))).status).toBe(204)
    expect((await put(envelope(900, 'monday-plus-500-new'))).status).toBe(204)
    const wipe = await put(envelope(0, 'empty'))
    expect(wipe.status, 'the wipe is accepted').toBe(204)

    // What the device now gets back.
    const served = await fetch(`${baseUrl}/api/library`, { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(await served.json()).toMatchObject({ decks: [] })

    const recoverable = (await libraryStore.versions(SUB)).map((v) => JSON.parse(v.data))
    const deepest = recoverable.flatMap((v) => v.decks).flatMap((d) => d.phrases ?? [])
    expect(deepest.length, 'claim (a): the 900-phrase state the wipe replaced must be archived').toBe(900)
  })
})
