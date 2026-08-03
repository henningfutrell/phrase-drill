// @vitest-environment node
//
// Runs the actual Worker script against the real Workers runtime (workerd,
// via wrangler's `unstable_dev`) with R2 simulated by the same engine
// `wrangler dev`/`wrangler deploy` use locally — not a hand-rolled mock of
// R2 or of `fetch`. `@cloudflare/vitest-pool-workers` is not installed in
// this repo (nothing here may run `npm install`); `unstable_dev` is the
// next-closest honest option already available via the `wrangler` devDependency.
//
// No `wrangler.jsonc`/assets binding is passed here on purpose: these tests
// exercise only `/api/library/*`, so the harness stays independent of
// whether `dist/` has been built.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unstable_dev, type Unstable_DevWorker } from 'wrangler'
import { CURRENT_SCHEMA_VERSION } from '../src/adapters/storage/migrations'
import { LIBRARY_FORMAT } from '../src/domain'

let worker: Unstable_DevWorker

beforeAll(async () => {
  // unstable_dev reads wrangler.jsonc from this directory regardless (there
  // is no "ignore the config file" option), and that config declares
  // `assets.directory: "./dist"` — required to exist even though these
  // tests only exercise `/api/*`, which `run_worker_first` routes to the
  // Worker before assets are ever consulted. A placeholder is enough; the
  // real dist/ is produced by `npm run build` / pwa.build.test.ts.
  const rootDir = path.dirname(fileURLToPath(import.meta.url))
  const distDir = path.join(rootDir, '..', 'dist')
  if (!existsSync(distDir)) {
    mkdirSync(distDir, { recursive: true })
    writeFileSync(path.join(distDir, 'index.html'), '<!-- placeholder for worker tests -->')
  }

  worker = await unstable_dev('worker/index.ts', {
    r2: [{ binding: 'LIBRARY_BUCKET' }],
    persist: false,
    logLevel: 'error',
    experimental: { disableExperimentalWarning: true },
  })
}, 30_000)

afterAll(async () => {
  await worker.stop()
})

function freshKey(): string {
  return randomUUID().replace(/-/g, '')
}

function library(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    format: LIBRARY_FORMAT,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: 1,
    decks: [],
    ...overrides,
  }
}

describe('GET /api/library/:key', () => {
  it('404s on a key that has never been synced', async () => {
    const res = await worker.fetch(`/api/library/${freshKey()}`)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body).toEqual({ error: 'not-found' })
  })

  it('400s on a malformed key', async () => {
    const res = await worker.fetch('/api/library/short')
    expect(res.status).toBe(400)
  })
})

describe('PUT /api/library/:key', () => {
  it('round-trips a stored library: create, then fetch it back with an ETag', async () => {
    const key = freshKey()
    const body = library({ decks: [{ id: 'd1', name: 'home', phrases: [], createdAt: 1, updatedAt: 1 }] })

    const putRes = await worker.fetch(`/api/library/${key}`, {
      method: 'PUT',
      headers: { 'if-none-match': '*', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(putRes.status).toBe(200)
    const putJson = (await putRes.json()) as { ok: boolean; etag: string }
    expect(putJson.ok).toBe(true)
    expect(putJson.etag).toBeTruthy()

    const getRes = await worker.fetch(`/api/library/${key}`)
    expect(getRes.status).toBe(200)
    expect(getRes.headers.get('etag')).toBe(putJson.etag)
    const fetched = await getRes.json()
    expect(fetched).toEqual(body)
  })

  it('refuses a create (If-None-Match: *) against a key that already has a stored library', async () => {
    const key = freshKey()
    const first = await worker.fetch(`/api/library/${key}`, {
      method: 'PUT',
      headers: { 'if-none-match': '*' },
      body: JSON.stringify(library()),
    })
    expect(first.status).toBe(200)

    const second = await worker.fetch(`/api/library/${key}`, {
      method: 'PUT',
      headers: { 'if-none-match': '*' },
      body: JSON.stringify(library({ exportedAt: 2 })),
    })
    expect(second.status).toBe(409)
    const body = (await second.json()) as Record<string, unknown>
    expect(body.error).toBe('conflict')
  })

  it('refuses a stale write: If-Match against an etag that is no longer current', async () => {
    const key = freshKey()
    const firstPut = await worker.fetch(`/api/library/${key}`, {
      method: 'PUT',
      headers: { 'if-none-match': '*' },
      body: JSON.stringify(library({ exportedAt: 1 })),
    })
    const { etag: staleEtag } = (await firstPut.json()) as { etag: string }

    // A second device updates the library, moving the etag forward.
    const secondPut = await worker.fetch(`/api/library/${key}`, {
      method: 'PUT',
      headers: { 'if-match': staleEtag },
      body: JSON.stringify(library({ exportedAt: 2 })),
    })
    expect(secondPut.status).toBe(200)

    // The first device retries its write against the etag it originally read.
    const staleWrite = await worker.fetch(`/api/library/${key}`, {
      method: 'PUT',
      headers: { 'if-match': staleEtag },
      body: JSON.stringify(library({ exportedAt: 3, decks: [] })),
    })
    expect(staleWrite.status).toBe(409)
    const conflictBody = (await staleWrite.json()) as Record<string, unknown>
    expect(conflictBody.error).toBe('conflict')
    expect(conflictBody.reason).toBe('stale')
    // The losing write is visible: the caller gets back what's actually stored.
    expect(conflictBody.current).toEqual(library({ exportedAt: 2 }))

    // And the server's copy is provably untouched by the refused write.
    const getRes = await worker.fetch(`/api/library/${key}`)
    const stored = await getRes.json()
    expect(stored).toEqual(library({ exportedAt: 2 }))
  })

  it('400s when neither If-Match nor If-None-Match is sent', async () => {
    const res = await worker.fetch(`/api/library/${freshKey()}`, {
      method: 'PUT',
      body: JSON.stringify(library()),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('missing-precondition')
  })

  it('400s on a body that is not JSON', async () => {
    const res = await worker.fetch(`/api/library/${freshKey()}`, {
      method: 'PUT',
      headers: { 'if-none-match': '*' },
      body: 'not json{',
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('malformed-body')
  })

  it('400s on a well-formed JSON body missing the library envelope fields', async () => {
    const res = await worker.fetch(`/api/library/${freshKey()}`, {
      method: 'PUT',
      headers: { 'if-none-match': '*' },
      body: JSON.stringify({ hello: 'world' }),
    })
    expect(res.status).toBe(400)
  })

  it('400s on a schemaVersion newer than this server understands', async () => {
    const res = await worker.fetch(`/api/library/${freshKey()}`, {
      method: 'PUT',
      headers: { 'if-none-match': '*' },
      body: JSON.stringify(library({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 })),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('schema-version-too-new')
    expect(body.serverSchemaVersion).toBe(CURRENT_SCHEMA_VERSION)
  })

  it('413s on a body over the size cap, and does not store it', async () => {
    const key = freshKey()
    const huge = library({
      decks: [{ id: 'd1', name: 'x'.repeat(9 * 1024 * 1024), phrases: [], createdAt: 1, updatedAt: 1 }],
    })
    const res = await worker.fetch(`/api/library/${key}`, {
      method: 'PUT',
      headers: { 'if-none-match': '*' },
      body: JSON.stringify(huge),
    })
    expect(res.status).toBe(413)

    const getRes = await worker.fetch(`/api/library/${key}`)
    expect(getRes.status).toBe(404)
  })
})

describe('unsupported methods on /api/library/:key', () => {
  it('405s on POST', async () => {
    const res = await worker.fetch(`/api/library/${freshKey()}`, { method: 'POST' })
    expect(res.status).toBe(405)
  })
})
