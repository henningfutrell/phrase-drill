import type { Library } from '../../domain'

/**
 * Why a push or pull could not complete. Deliberately smaller than
 * `SynthError`/`ScanError` — there is no `quota` here (T041's rate limit on
 * `/api/library` is generous and sync is not user-initiated per action), and
 * `not-found` is a normal, expected outcome (nothing has ever been pushed
 * before nobody has ever synced, not a failure.
 */
export type PullResult =
  | { ok: true; library: Library }
  | { ok: false; reason: 'not-found' | 'unauthorized' | 'network' | 'server-copy-unreadable' }

/**
 * The exact body `server/app.js` handleLibraryGet answers with when it has
 * read its own `libraries.data` row and the row is not a library envelope.
 * Duplicated across the process boundary on purpose — there is no module both
 * a browser bundle and a plain-Node server can import — and asserted on both
 * sides (`server/app.test.js`, this file's tests) so the two cannot drift
 * apart in silence.
 */
const SERVER_COPY_UNREADABLE = 'library-unreadable'
/**
 * `stale-client` is the server refusing a push from a build older than the
 * envelope it already holds (T060) — this device would strip fields it does
 * not know about, so it is told to keep its changes local until it updates.
 * Not a failure to retry: retrying the same build gets the same answer.
 */
export type PushResult = { ok: true } | { ok: false; reason: 'unauthorized' | 'stale-client' | 'network' }

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
      let accessToken: string
      try {
        accessToken = await deps.getAccessToken()
      } catch {
        // The only reason there is no token is that there is no session:
        // none stored, or the stored one is past its expiry. Retrying cannot
        // mint one, which is exactly what `unauthorized` means here.
        return { ok: false, reason: 'unauthorized' }
      }
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
      if (response.status === 409) return { ok: false, reason: 'stale-client' }
      if (!response.ok) return { ok: false, reason: 'network' }
      return { ok: true }
    },

    async pull() {
      let accessToken: string
      try {
        accessToken = await deps.getAccessToken()
      } catch {
        return { ok: false, reason: 'unauthorized' }
      }
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
      // The one failure that is a statement about the STORED BYTES rather
      // than about this request (T089). The server parsed its own row and
      // reports that it is not a library envelope — so there is nothing
      // readable on the server to lose, which is the only condition under
      // which the engine is allowed to push over it.
      //
      // Narrow deliberately, because the cost of a false positive is her
      // library. The status alone is not enough: 500 is also what the
      // catch-all in `handleRequest` answers (`server-error`), and what a
      // proxy or the platform edge answers with an HTML page. So the status
      // AND this server's own error code, read out of a body that parsed as
      // JSON; anything else is `network`, which does not push. 502/503 are
      // not this server speaking at all and fall through to `network` below.
      if (response.status === 500) {
        let body: unknown
        try {
          body = await response.json()
        } catch {
          return { ok: false, reason: 'network' }
        }
        if (!!body && typeof body === 'object' && (body as { error?: unknown }).error === SERVER_COPY_UNREADABLE) {
          return { ok: false, reason: 'server-copy-unreadable' }
        }
        return { ok: false, reason: 'network' }
      }
      if (!response.ok) return { ok: false, reason: 'network' }
      // Reading the body is part of the request, not something that happens
      // after it: a truncated response makes this throw. Reported as
      // `network` — a body this device cannot read is a round-trip that did
      // not complete, and it is retryable because the likeliest cause is a
      // truncated transfer. It is not `stale-client`: an app update cannot
      // repair a corrupt server row, and saying so would stop sync for good
      // over something transient. It is not `server-copy-unreadable` either:
      // this device failing to read a body says nothing about what the server
      // holds, and only the server's own verdict may license a push (T089).
      try {
        return { ok: true, library: (await response.json()) as Library }
      } catch {
        return { ok: false, reason: 'network' }
      }
    },
  }
}
