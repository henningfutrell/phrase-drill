/**
 * The Worker's whole surface: `/api/library/:key` (see docs/sync.md), and
 * nothing else — every other request is either handled by the static-assets
 * binding before this script even runs (`assets.run_worker_first` in
 * wrangler.jsonc restricts invocation to `/api/*`) or, in a test harness with
 * no ASSETS binding configured, falls through to a plain 404 here.
 */
import { isValidLibraryKey } from './contract'
import { getLibrary, putLibrary } from './library-api'
import { jsonResponse } from './responses'

const LIBRARY_PATH_PREFIX = '/api/library/'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname.startsWith(LIBRARY_PATH_PREFIX)) {
      const key = url.pathname.slice(LIBRARY_PATH_PREFIX.length)
      if (!isValidLibraryKey(key)) {
        return jsonResponse(400, { error: 'invalid-key' })
      }

      if (request.method === 'GET') {
        return getLibrary(env.LIBRARY_BUCKET, key)
      }
      if (request.method === 'PUT') {
        return putLibrary(request, env.LIBRARY_BUCKET, key)
      }
      return jsonResponse(405, { error: 'method-not-allowed' }, { allow: 'GET, PUT' })
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request)
    }
    return jsonResponse(404, { error: 'not-found' })
  },
}
