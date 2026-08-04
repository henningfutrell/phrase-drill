/**
 * The device's login (T050): a plain username/password form posted to this
 * app's own `/api/login`, in exchange for an opaque session token — a
 * database row on the server, not a JWT. Replaces `keycloak-auth.ts`
 * entirely (deleted, not adapted) along with the whole PKCE/redirect/
 * refresh-token machinery it needed: at two users, an OIDC dance and a
 * vendor login page are cost with no benefit, and a login form inside the
 * app itself is *simpler* for the one non-technical person using it than
 * being bounced to a third party's page.
 *
 * The token is stored in `localStorage` (real, or an injected fake in
 * tests) alongside the `expiresAt` the server returned, so a stale token
 * past its own expiry is refused client-side too, before ever reaching the
 * network. `getAccessToken()` is the same seam the three server-calling
 * adapters (`server-synth-client`, `server-scan-reader`,
 * `library-sync-client`) already depend on — nothing downstream of that
 * interface changed to make this swap.
 *
 * `authFetch` is what makes "a 401 from any call clears it and returns her
 * to the login screen" true without touching any of those three adapters:
 * it wraps whichever `fetchImpl` they're given, and on any 401 response
 * clears the stored token and calls `onUnauthorized()` (the composition
 * root's hook back to rendering the login screen) before handing the
 * response back untouched — the calling adapter still sees its own 401 and
 * maps it to its own error shape exactly as before.
 */

const STORAGE_KEY = 'phrase-drill-session'

export class AuthRequiredError extends Error {
  constructor(reason = 'not-authenticated') {
    super(`login required: ${reason}`)
    this.name = 'AuthRequiredError'
  }
}

export type LoginResult = { ok: true } | { ok: false; reason: 'invalid-credentials' | 'network' }

export interface SessionAuthConfig {
  storage?: Storage
  fetchImpl?: typeof fetch
  now?: () => number
  /** Called once, synchronously, whenever any `authFetch` call comes back 401 — the composition root's hook to show the login screen again. */
  onUnauthorized?: () => void
}

export interface SessionAuth {
  login(username: string, password: string): Promise<LoginResult>
  /** Best-effort — tells the server to delete the session row, then always clears local state regardless of whether that call succeeds. */
  logout(): Promise<void>
  /** Resolves to the stored token, or throws `AuthRequiredError` if there is none or it is past its own `expiresAt`. */
  getAccessToken(): Promise<string>
  /** `fetchImpl`, wrapped to clear the token and fire `onUnauthorized()` on any 401 — hand this to the server-calling adapters as their `fetchImpl`. */
  authFetch: typeof fetch
}

interface StoredSession {
  token: string
  expiresAt: number // epoch ms
}

export function createSessionAuth(config: SessionAuthConfig = {}): SessionAuth {
  const storage = config.storage ?? window.localStorage
  const fetchImpl = config.fetchImpl ?? fetch
  const now = config.now ?? (() => Date.now())
  const onUnauthorized = config.onUnauthorized ?? (() => {})

  function loadSession(): StoredSession | null {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return null
    try {
      return JSON.parse(raw) as StoredSession
    } catch {
      return null
    }
  }

  function saveSession(session: StoredSession): void {
    storage.setItem(STORAGE_KEY, JSON.stringify(session))
  }

  function clearSession(): void {
    storage.removeItem(STORAGE_KEY)
  }

  const authFetch: typeof fetch = async (input, init) => {
    const response = await fetchImpl(input, init)
    if (response.status === 401) {
      clearSession()
      onUnauthorized()
    }
    return response
  }

  return {
    async login(username, password) {
      let response: Response
      try {
        response = await fetchImpl('/api/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username, password }),
        })
      } catch {
        return { ok: false, reason: 'network' }
      }

      if (response.status === 401) return { ok: false, reason: 'invalid-credentials' }
      if (!response.ok) return { ok: false, reason: 'network' }

      const body = (await response.json()) as { token: string; expiresAt: number }
      saveSession({ token: body.token, expiresAt: body.expiresAt })
      return { ok: true }
    },

    async logout() {
      const session = loadSession()
      if (session) {
        try {
          await fetchImpl('/api/logout', {
            method: 'POST',
            headers: { authorization: `Bearer ${session.token}` },
          })
        } catch {
          // Best-effort — the server-side row will just sit until it
          // expires (30 days) if this call never lands; clearing local
          // state below is what actually signs the device out.
        }
      }
      clearSession()
    },

    async getAccessToken() {
      const session = loadSession()
      if (!session) throw new AuthRequiredError()
      if (session.expiresAt <= now()) {
        clearSession()
        throw new AuthRequiredError('expired')
      }
      return session.token
    },

    authFetch,
  }
}
