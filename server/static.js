import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
}

/**
 * Serves the built PWA (`dist/`, produced by `npm run build`) alongside the
 * API, from the same container/port — the "one container serves the built
 * PWA and an API" obligation. A path that resolves to a real file under
 * `distDir` is served as-is; anything else falls back to `index.html`
 * (client-side routing) as long as the resolved path stays inside
 * `distDir` — `resolve`d and bounds-checked before any read, so `../..`
 * traversal in a request path can never escape the served directory.
 */
export function createStaticHandler(distDir) {
  const root = resolve(distDir)

  return async function serveStatic(req, res, pathname) {
    const candidate = resolve(root, '.' + normalize(pathname))
    const withinRoot = candidate === root || candidate.startsWith(root + sep)
    const target = withinRoot ? candidate : join(root, 'index.html')

    const filePath = (await isFile(target)) ? target : join(root, 'index.html')
    if (!(await isFile(filePath))) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }

    const type = MIME_TYPES[extname(filePath)] ?? 'application/octet-stream'
    res.writeHead(200, { 'content-type': type })
    createReadStream(filePath).pipe(res)
  }
}

async function isFile(path) {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}
