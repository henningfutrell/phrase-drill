import type { Library } from '../../domain'

/**
 * Why a push or pull could not complete. Deliberately smaller than
 * `SynthError`/`ScanError` — there is no `quota` here (T041's rate limit on
 * `/api/library` is generous and sync is not user-initiated per action), and
 * `not-found` is a normal, expected outcome (nothing has ever been pushed
 * before nobody has ever synced, not a failure.
 */
export type PullResult = { ok: true; library: Library } | { ok: false; reason: 'not-found' | 'unauthorized' | 'network' }
export type PushResult = { ok: true } | { ok: false; reason: 'unauthorized' | 'network' }

export interface LibrarySyncClientDeps {
  getAccessToken(): Promise<string>
  fetchImpl?: typeof fetch
}

export interface LibrarySyncClient {
  /** Uploads the whole Library, replacing whatever was stored for this key. */
  push(library: Library): Promise<PushResult>
  /** Downloads the Library last pushed under this key, if any. */
  pull(): Promise<PullResult>
}

/**
 * The device's side of "her library is stored server-side and reloads onto
 * a wiped or replaced phone" (T041): pushes the full local `Library`
 * envelope (the same shape `DeckStore.exportAll()`/backup files already
 * use) to `/api/library`, and pulls it back down. Same-origin,
 * authenticated with a session token (T050).
 */
export function createLibrarySyncClient(deps: LibrarySyncClientDeps): LibrarySyncClient {
  const fetchImpl = deps.fetchImpl ?? fetch

  return {
    async push(library) {
      const accessToken = await deps.getAccessToken()
      let response: Response
      try {
        response = await fetchImpl('/api/library', {
          method: 'PUT',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
          body: JSON.stringify(library),
        })
      } catch {
        return { ok: false, reason: 'network' }
      }
      if (response.status === 401) return { ok: false, reason: 'unauthorized' }
      if (!response.ok) return { ok: false, reason: 'network' }
      return { ok: true }
    },

    async pull() {
      const accessToken = await deps.getAccessToken()
      let response: Response
      try {
        response = await fetchImpl('/api/library', {
          headers: { authorization: `Bearer ${accessToken}` },
        })
      } catch {
        return { ok: false, reason: 'network' }
      }
      if (response.status === 401) return { ok: false, reason: 'unauthorized' }
      if (response.status === 404) return { ok: false, reason: 'not-found' }
      if (!response.ok) return { ok: false, reason: 'network' }
      const library = (await response.json()) as Library
      return { ok: true, library }
    },
  }
}
