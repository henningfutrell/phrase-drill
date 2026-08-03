// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStaticHandler } from './static.js'

/**
 * Unmatched-path behaviour (T051): a path that looks like a route (no file
 * extension, not under /assets/) falls back to index.html for client-side
 * routing; a path that looks like a static asset (has an extension, or sits
 * under /assets/) 404s instead of silently returning an HTML document a
 * browser will try to parse as the asset's real type.
 */
describe('createStaticHandler', () => {
  let server
  let baseUrl
  let distDir

  beforeEach(async () => {
    distDir = mkdtempSync(join(tmpdir(), 'phrase-drill-static-'))
    mkdirSync(join(distDir, 'assets'), { recursive: true })
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>phrase-drill</title>')
    writeFileSync(join(distDir, 'assets', 'app.js'), 'console.log("app")')

    const serveStatic = createStaticHandler(distDir)
    server = createServer((req, res) => {
      const url = new URL(req.url, 'http://internal')
      serveStatic(req, res, url.pathname)
    })
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`
        resolve()
      })
    })
  })

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve))
    rmSync(distDir, { recursive: true, force: true })
  })

  it('falls back to index.html for a route-shaped path with no extension', async () => {
    const res = await fetch(`${baseUrl}/settings`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('phrase-drill')
  })

  it('falls back to index.html for a nested route-shaped path with no extension', async () => {
    const res = await fetch(`${baseUrl}/a/b`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('phrase-drill')
  })

  it('404s a missing path under /assets/', async () => {
    const res = await fetch(`${baseUrl}/assets/nope.js`)
    expect(res.status).toBe(404)
  })

  it('404s a missing nested asset path under /assets/', async () => {
    const res = await fetch(`${baseUrl}/a/assets/index-CWcIJOvu.js`)
    expect(res.status).toBe(404)
  })

  it('404s a missing file with an extension outside /assets/', async () => {
    const res = await fetch(`${baseUrl}/favicon.svg`)
    expect(res.status).toBe(404)
  })

  it('still serves a real existing asset with its correct content type', async () => {
    const res = await fetch(`${baseUrl}/assets/app.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/javascript')
    expect(await res.text()).toContain('console.log')
  })
})
