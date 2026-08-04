// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.js'
import { createLibraryStore, createClipStore } from './db.js'
import { fakeLibraryPool, fakeClipPool } from './pool.test-support.js'
import { createRateLimiter } from './rate-limiter.js'

/**
 * AUDIT T079 — FINDINGS 4 and 5.
 *
 * `/api/library` PUT validates a PARSED value and then stores a
 * RE-SERIALIZED string. They are not the same value, and nothing checks the
 * second one.
 *
 *   server/app.js:45    typeof value.schemaVersion === 'number' &&
 *   server/app.js:342   if (!isLibraryEnvelope(parsed)) return sendJson(res, 400, ...)
 *   server/app.js:360   if (stored && parsed.schemaVersion < storedSchemaVersion(stored.data)) {
 *   server/app.js:369   await libraryStore.put(key, JSON.stringify(parsed), Date.now())
 *
 * FINDING 4 — a push the server accepts can make her library permanently
 * unservable. `1e999` is legal JSON, parses to `Infinity`, and
 * `typeof Infinity === 'number'`, so app.js:45 passes it. `JSON.stringify`
 * at app.js:369 writes it back as `null`. Her previous library row has
 * already been overwritten by then. Every later GET runs the SAME shape test
 * at app.js:313, now fails it, and returns 500 `library-unreadable`
 * (app.js:315) — forever.
 *
 * The device cannot repair it. `sync-engine.ts:198` skips the push whenever
 * the pull failed, so the good copy on her phone can never be pushed back up;
 * `library-sync-client.ts:85` maps the 500 to `network`, so the engine retries
 * on backoff for the rest of time and the line reads "Saved on this phone ·
 * will sync when back online". `docs/sync.md` names a permanently corrupt row
 * as a residual gap arising from hand repair or a truncated upstream write —
 * not from a request this server validated and answered 204 to.
 *
 * FINDING 5 — `schemaVersion` is unbounded upward, and it is the gate that
 * locks devices out. One push carrying `schemaVersion: 999` is stored, and
 * every subsequent push from a real device (schemaVersion 6) then trips
 * app.js:360 and gets 409 `stale-client`. `sync-engine.ts:313-315` maps that
 * to `needs-update` and STOPS RETRYING — the state that exists precisely
 * because retrying cannot help. Both of her phones stop syncing, permanently,
 * telling her to update an app for which no update exists. The library that
 * did this overwrote hers on the way in.
 */

const TOKEN = 'valid-token'

function fakeSessionAuth() {
  return {
    async verify(token) {
      if (token !== TOKEN) throw new Error('invalid token')
      return { sub: 'her' }
    },
    async login() {
      return null
    },
    async logout() {},
  }
}

const silentLogger = { info() {}, warn() {}, error() {} }

function envelope(overrides) {
  return { format: 'phrase-drill-library', schemaVersion: 6, decks: [], mixes: [], tombstones: [], ...overrides }
}

const HER_LIBRARY = envelope({
  decks: [
    {
      id: 'd1',
      name: 'Market',
      createdAt: 1,
      updatedAt: 2,
      phrases: [{ id: 'p1', french: 'je voudrais un kilo de pommes', english: 'I would like a kilo of apples' }],
    },
  ],
})

describe('AUDIT T079 — the server stores an envelope it will later refuse to serve', () => {
  let server
  let baseUrl
  let libraryStore
  let distDir

  beforeEach(async () => {
    libraryStore = createLibraryStore(fakeLibraryPool())
    await libraryStore.init()
    const clipStore = createClipStore(fakeClipPool())
    await clipStore.init()
    distDir = mkdtempSync(join(tmpdir(), 'phrase-drill-audit-'))
    writeFileSync(join(distDir, 'index.html'), '<!doctype html>')

    const handleRequest = createApp({
      libraryStore,
      clipStore,
      elevenLabs: { async synthesize() { throw new Error('unused') } },
      anthropic: { async readScan() { throw new Error('unused') }, async translate() { throw new Error('unused') } },
      ttsLimiter: createRateLimiter({ capacity: 50, refillMs: 60_000 }),
      scanLimiter: createRateLimiter({ capacity: 50, refillMs: 60_000 }),
      libraryLimiter: createRateLimiter({ capacity: 50, refillMs: 60_000 }),
      loginLimiter: createRateLimiter({ capacity: 50, refillMs: 60_000 }),
      translateLimiter: createRateLimiter({ capacity: 50, refillMs: 60_000 }),
      distDir,
      logger: silentLogger,
      sessionAuth: fakeSessionAuth(),
    })
    server = createServer(handleRequest)
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`
        resolve()
      })
    })
  })

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve))
    await libraryStore.close()
    rmSync(distDir, { recursive: true, force: true })
  })

  function put(raw) {
    return fetch(`${baseUrl}/api/library`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: raw,
    })
  }

  function get() {
    return fetch(`${baseUrl}/api/library`, { headers: { authorization: `Bearer ${TOKEN}` } })
  }

  it('FINDING 4: a 204 push leaves the row permanently unreadable, and her phrases with it', async () => {
    // Her library is safe on the server.
    expect((await put(JSON.stringify(HER_LIBRARY))).status).toBe(204)
    expect((await get()).status).toBe(200)

    // One push with a schemaVersion that survives validation and not
    // serialization. Legal JSON; no NaN literal needed.
    const poison = await put('{"format":"phrase-drill-library","schemaVersion":1e999,"decks":[]}')
    expect(poison.status).toBe(204)

    // DEMONSTRATION: the server accepted it, overwrote her library with it,
    // and can now never serve anything under this key again. Only psql fixes
    // this, and the device is structurally unable to push its good copy back
    // (a failed pull skips the push — sync-engine.ts:198).
    const after = await get()
    expect(after.status).toBe(200)
  })

  it('FINDING 5: one unbounded schemaVersion locks every real device out of sync for good', async () => {
    expect((await put(JSON.stringify(HER_LIBRARY))).status).toBe(204)

    // A build with a bug, a hand `curl`, a replayed body from a future build.
    expect((await put(JSON.stringify(envelope({ schemaVersion: 999 })))).status).toBe(204)

    // DEMONSTRATION: every honest push from her actual phones is now 409
    // `stale-client`, which the engine maps to `needs-update` and stops
    // retrying (sync-engine.ts:313-315). No app update clears it.
    const honest = await put(JSON.stringify(HER_LIBRARY))
    expect(honest.status).toBe(204)
  })
})
