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
 * `distDir` is served as-is; a path that looks like a client-side ROUTE
 * (no file extension, and not under `/assets/`) falls back to
 * `index.html` instead. A path that looks like a static ASSET (has a file
 * extension, or sits under `/assets/`) but does not resolve to a real file
 * 404s instead of falling back — an asset that 404s tells a browser
 * exactly that; an asset that gets the SPA shell back gets an HTML
 * document where it expected JS/CSS/etc. and fails with a parse error
 * that points nowhere near the real cause. The resolved path is
 * `resolve`d and bounds-checked before any read, so `../..` traversal in
 * a request path can never escape the served directory.
 */
export function createStaticHandler(distDir) {
  const root = resolve(distDir)

  return async function serveStatic(req, res, pathname) {
    const candidate = resolve(root, '.' + normalize(pathname))
    const withinRoot = candidate === root || candidate.startsWith(root + sep)
    const target = withinRoot ? candidate : join(root, 'index.html')

    if (await isFile(target)) {
      const type = MIME_TYPES[extname(target)] ?? 'application/octet-stream'
      res.writeHead(200, { 'content-type': type })
      createReadStream(target).pipe(res)
      return
    }

    if (looksLikeAsset(pathname)) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }

    const filePath = join(root, 'index.html')
    if (!(await isFile(filePath))) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }

    res.writeHead(200, { 'content-type': MIME_TYPES['.html'] })
    createReadStream(filePath).pipe(res)
  }
}

/** Has a file extension, or sits under `/assets/` — the built PWA's own
 * asset directory. Anything else is treated as a client-side route. */
function looksLikeAsset(pathname) {
  return extname(pathname) !== '' || pathname.startsWith('/assets/')
}

async function isFile(path) {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}
