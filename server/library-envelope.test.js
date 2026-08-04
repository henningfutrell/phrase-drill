// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp, LIBRARY_MAX_SCHEMA_VERSION } from './app.js'
import { createLibraryStore, createClipStore } from './db.js'
import { fakeLibraryPool, fakeClipPool } from './pool.test-support.js'
import { createRateLimiter } from './rate-limiter.js'

/**
 * T082, from the T079 audit's findings 2 and 5.
 *
 * `/api/library` PUT used to validate a PARSED value and then store a
 * RE-SERIALIZED string. They are not the same value, and nothing checked the
 * second one.
 *
 *   server/app.js  typeof value.schemaVersion === 'number'
 *   server/app.js  if (!isLibraryEnvelope(parsed)) return sendJson(res, 400, ...)
 *   server/app.js  if (stored && parsed.schemaVersion < storedSchemaVersion(stored.data))
 *   server/app.js  await libraryStore.put(key, JSON.stringify(parsed), Date.now())
 *
 * FINDING 2 — a push the server accepted could make her library permanently
 * unservable. `1e999` is legal JSON, parses to `Infinity`, and
 * `typeof Infinity === 'number'`, so the shape test passed it. `JSON.stringify`
 * wrote it back as `null`. Her previous library row had already been
 * overwritten by then. Every later GET ran the SAME shape test on the way out,
 * now failed it, and returned 500 `library-unreadable` — forever.
 *
 * The device cannot repair that. `sync-engine.ts:198` skips the push whenever
 * the pull failed, so the good copy on her phone can never be pushed back up;
 * `library-sync-client.ts:85` maps the 500 to `network`, so the engine retries
 * on backoff for the rest of time and the line reads "Saved on this phone ·
 * will sync when back online".
 *
 * FINDING 5 — `schemaVersion` was unbounded upward, and it is the gate that
 * locks devices out. One push carrying `schemaVersion: 999` was stored, and
 * every subsequent push from a real device (schemaVersion 6) then tripped the
 * stale-client gate and got 409. `sync-engine.ts:313-315` maps that to
 * `needs-update` and STOPS RETRYING — the state that exists precisely because
 * retrying cannot help. Both of her phones stop syncing, permanently, telling
 * her to update an app for which no update exists.
 *
 * Both are one defect: the accepted set of `schemaVersion` values was wider
 * than the set this server can store, serve and compare. It is now
 * `1 .. LIBRARY_MAX_SCHEMA_VERSION`, integers only, and what is stored is the
 * bytes that were validated rather than a re-serialization of them.
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

describe('/api/library — the server never stores an envelope it will later refuse to serve (T082)', () => {
  let server
  let baseUrl
  let libraryStore
  let distDir

  beforeEach(async () => {
    libraryStore = createLibraryStore(fakeLibraryPool())
    await libraryStore.init()
    const clipStore = createClipStore(fakeClipPool())
    await clipStore.init()
    distDir = mkdtempSync(join(tmpdir(), 'phrase-drill-t082-'))
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

  it('FINDING 2: a schemaVersion that survives validation but not serialization is refused, and her library is untouched', async () => {
    // Her library is safe on the server.
    expect((await put(JSON.stringify(HER_LIBRARY))).status).toBe(204)
    expect((await get()).status).toBe(200)

    // One push with a schemaVersion that survives validation and not
    // serialization. Legal JSON; no NaN literal needed. It is refused BEFORE
    // the store is touched — the audit's version of this line asserted the
    // 204 the server used to answer here, which is the defect itself, and it
    // is one of the two assertions this file inverts.
    const poison = await put('{"format":"phrase-drill-library","schemaVersion":1e999,"decks":[]}')
    expect(poison.status).toBe(400)

    // Her library is still there, still servable.
    const after = await get()
    expect(after.status).toBe(200)
    expect(JSON.parse(await after.text())).toEqual(HER_LIBRARY)
  })

  it('FINDING 5: a schemaVersion above this build’s own is refused, so no push can lock her phones out', async () => {
    expect((await put(JSON.stringify(HER_LIBRARY))).status).toBe(204)

    // A build with a bug, a hand `curl`, a replayed body from a future build.
    // The audit asserted 204 here too; that acceptance is the defect.
    expect((await put(JSON.stringify(envelope({ schemaVersion: 999 })))).status).toBe(400)

    // Every honest push from her actual phones still lands. Before this they
    // were 409 `stale-client` for good, which `sync-engine.ts:313-315` maps
    // to `needs-update` — the one state that stops retrying.
    const honest = await put(JSON.stringify(HER_LIBRARY))
    expect(honest.status).toBe(204)
  })

  it.each([
    ['Infinity, written as legal JSON', '{"format":"phrase-drill-library","schemaVersion":1e999,"decks":[]}'],
    ['-Infinity', '{"format":"phrase-drill-library","schemaVersion":-1e999,"decks":[]}'],
    ['a fraction', '{"format":"phrase-drill-library","schemaVersion":6.5,"decks":[]}'],
    ['zero', '{"format":"phrase-drill-library","schemaVersion":0,"decks":[]}'],
    ['a negative version', '{"format":"phrase-drill-library","schemaVersion":-1,"decks":[]}'],
    ['above this build’s own', '{"format":"phrase-drill-library","schemaVersion":999,"decks":[]}'],
  ])('refuses a schemaVersion that is %s', async (_name, raw) => {
    expect((await put(raw)).status).toBe(400)
    // Nothing was written: there is no row at all for this key.
    expect((await get()).status).toBe(404)
  })

  it('still accepts every version this build can actually produce', async () => {
    for (let version = 1; version <= LIBRARY_MAX_SCHEMA_VERSION; version += 1) {
      expect((await put(JSON.stringify(envelope({ schemaVersion: version })))).status).toBe(204)
    }
  })

  it('stores the bytes it validated, not a re-serialization of them, so GET is byte for byte on both paths', async () => {
    // Whitespace and key order a client is free to send and this server has
    // no business normalizing. The old path round-tripped through
    // `JSON.parse`/`JSON.stringify`, which is what let a value change between
    // being checked and being written.
    const raw = '{\n  "decks": [],\n  "schemaVersion": 6,\n  "format": "phrase-drill-library"\n}'
    expect((await put(raw)).status).toBe(204)

    const served = await get()
    expect(served.status).toBe(200)
    expect(await served.text()).toBe(raw)
  })

  it('a stored version out of range does not lock a real device out — it reads as 0, and her push repairs the row', async () => {
    // The row an already-deployed server may be holding right now, written
    // before this fix. Seeded past the route, because the route can no longer
    // produce it.
    await libraryStore.put('her', JSON.stringify(envelope({ schemaVersion: 999 })), 1)

    // Her phone pushes its honest 6. Before this, `storedSchemaVersion`
    // answered 999 and this was 409 `stale-client` for good.
    expect((await put(JSON.stringify(HER_LIBRARY))).status).toBe(204)
    expect(JSON.parse(await (await get()).text())).toEqual(HER_LIBRARY)
  })

  it('a stored version that is Infinity reads as 0 too, rather than out-ranking every client', async () => {
    await libraryStore.put('her', '{"format":"phrase-drill-library","schemaVersion":1e999,"decks":[]}', 1)

    expect((await put(JSON.stringify(HER_LIBRARY))).status).toBe(204)
  })

  it('still refuses a genuinely stale client — the T060 gate is intact', async () => {
    expect((await put(JSON.stringify(HER_LIBRARY))).status).toBe(204)

    const older = await put(JSON.stringify(envelope({ schemaVersion: 5 })))
    expect(older.status).toBe(409)
    expect(await older.json()).toEqual({ error: 'stale-client' })

    // And her library is untouched by the refusal.
    expect(JSON.parse(await (await get()).text())).toEqual(HER_LIBRARY)
  })
})

describe('LIBRARY_MAX_SCHEMA_VERSION tracks the build it ships with', () => {
  it('equals the client’s CURRENT_SCHEMA_VERSION, because they are one deploy', () => {
    // The app and the PWA it serves are the same Render service and the same
    // build, so no device can ever push a version higher than the server's
    // own. Read as text rather than imported: this is a JS server test and
    // the constant lives in TypeScript, and the point is to fail loudly when
    // a schema bump forgets this file — not to couple the two modules.
    const source = readFileSync(fileURLToPath(new URL('../src/adapters/storage/migrations.ts', import.meta.url)), 'utf8')
    const current = Number(/export const CURRENT_SCHEMA_VERSION = (\d+)/.exec(source)?.[1])

    expect(Number.isInteger(current)).toBe(true)
    expect(LIBRARY_MAX_SCHEMA_VERSION).toBe(current)
  })
})
