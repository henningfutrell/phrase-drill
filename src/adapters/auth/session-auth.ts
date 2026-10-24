/**
 * The device's login: Supabase Auth, through `@supabase/supabase-js`. The user
 * signs in with their email and password; the client keeps the session
 * (access token + refresh token) in its own storage and refreshes it before
 * it lapses, so `getAccessToken()` is always `getSession()` and nothing here
 * stores a credential. The access token is a JWT the server verifies without
 * a database lookup.
 *
 * `AuthClient` is the narrow slice of the Supabase client this adapter
 * uses — the seam. The real client satisfies it structurally, tests fake it,
 * and no Supabase type reaches the domain or the UI.
 *
 * `authFetch` is what makes "a 401 from any call returns them to the login
 * screen" true without touching the server-calling adapters: it wraps
 * `fetchImpl`, adds the bearer token, and on any 401 signs out and calls
 * `onUnauthorized()` before handing the response back untouched. Signing out
 * clears the auth client's own storage only — IndexedDB (their library, the
 * clip cache) is never an auth concern.
 */

/** The `localStorage` key of the retired opaque session token. */
const LEGACY_SESSION_KEY = 'phrase-drill-session'

/** Deletes the dead credential of the retired server-issued session token. */
export function purgeLegacySession(storage: Storage): void {
  storage.removeItem(LEGACY_SESSION_KEY)
}

export class AuthRequiredError extends Error {
  constructor(reason = 'not-authenticated') {
    super(`login required: ${reason}`)
    this.name = 'AuthRequiredError'
  }
}

/** The session could not be read or refreshed (typically offline) — not the same as being signed out. */
export class AuthUnavailableError extends Error {
  constructor(reason: string) {
    super(`login state unavailable: ${reason}`)
    this.name = 'AuthUnavailableError'
  }
}

export type LoginResult = { ok: true } | { ok: false; reason: 'invalid-credentials' | 'network' }

/** Why the server refused a new password she can fix by choosing another. */
const PASSWORD_REFUSALS = ['too-short', 'no-letter', 'no-digit', 'breached', 'same-password', 'weak-password'] as const
type PasswordRefusal = (typeof PASSWORD_REFUSALS)[number]

export type PasswordChangeResult =
  | { ok: true }
  | { ok: false; reason: PasswordRefusal | 'unverified' | 'signed-out' | 'network' }

interface AuthFailure {
  message: string
  status?: number
  code?: string
  name?: string
}

export interface AuthClient {
  auth: {
    signInWithPassword(credentials: { email: string; password: string }): Promise<{ error: AuthFailure | null }>
    getSession(): Promise<{ data: { session: { access_token: string } | null }; error: AuthFailure | null }>
    signOut(): Promise<{ error: AuthFailure | null }>
  }
}

export interface SessionAuthConfig {
  client: AuthClient
  fetchImpl?: typeof fetch
  /** Called once, synchronously, whenever any `authFetch` call comes back 401 — the composition root's hook to show the login screen again. */
  onUnauthorized?: () => void
}

export interface SessionAuth {
  login(email: string, password: string): Promise<LoginResult>
  /** Signs the device out of Supabase Auth. Local library data is untouched. */
  logout(): Promise<void>
  /** Resolves to the current access token (refreshed if due); throws `AuthRequiredError` when signed out, `AuthUnavailableError` when the session cannot be read. */
  getAccessToken(): Promise<string>
  /**
   * Sets a new password on the signed-in account, through the server's
   * `POST /api/password`: the server checks it (rules + HaveIBeenPwned) and
   * sets it. Never Supabase's `updateUser` from here — that path skips the
   * check (workflow issue #35).
   */
  changePassword(newPassword: string): Promise<PasswordChangeResult>
  /** `fetchImpl`, adding the bearer token and signing out + firing `onUnauthorized()` on any 401 — hand this to the server-calling adapters as their `fetchImpl`. */
  authFetch: typeof fetch
}

function isRefusal(error: AuthFailure): boolean {
  return error.status !== undefined && error.status >= 400 && error.status < 500
}

/** Runs one Supabase Auth call; a thrown error (no connection) is `network`, a returned one is `classify`'s. */
async function attempt<R extends string>(
  call: () => Promise<{ error: AuthFailure | null }>,
  classify: (error: AuthFailure) => R | 'network',
): Promise<{ ok: true } | { ok: false; reason: R | 'network' }> {
  try {
    const { error } = await call()
    return error ? { ok: false, reason: classify(error) } : { ok: true }
  } catch {
    return { ok: false, reason: 'network' }
  }
}

export function createSessionAuth(config: SessionAuthConfig): SessionAuth {
  const { client } = config
  const onUnauthorized = config.onUnauthorized ?? (() => {})

  async function currentToken(): Promise<string | null> {
    const { data, error } = await client.auth.getSession()
    if (data.session) return data.session.access_token
    if (error) throw new AuthUnavailableError(error.message)
    return null
  }

  const authFetch: typeof fetch = async (input, init) => {
    const fetchImpl = config.fetchImpl ?? fetch
    const headers = new Headers(init?.headers)
    const token = await currentToken().catch(() => null)
    if (token) headers.set('authorization', `Bearer ${token}`)
    const response = await fetchImpl(input, { ...init, headers })
    if (response.status === 401) {
      await client.auth.signOut()
      onUnauthorized()
    }
    return response
  }

  return {
    async login(email, password) {
      return attempt(() => client.auth.signInWithPassword({ email, password }), (error) =>
        isRefusal(error) ? 'invalid-credentials' : 'network',
      )
    },

    async logout() {
      await client.auth.signOut()
    },

    async changePassword(newPassword) {
      let response: Response
      try {
        response = await authFetch('/api/password', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password: newPassword }),
        })
      } catch {
        return { ok: false, reason: 'network' }
      }
      if (response.status === 204) return { ok: true }
      if (response.status === 401) return { ok: false, reason: 'signed-out' }
      const error = await response
        .json()
        .then((body: { error?: unknown }) => body?.error)
        .catch(() => undefined)
      if (response.status === 503 && error === 'unverified') return { ok: false, reason: 'unverified' }
      if (response.status === 422 && PASSWORD_REFUSALS.includes(error as PasswordRefusal)) {
        return { ok: false, reason: error as PasswordRefusal }
      }
      return { ok: false, reason: 'network' }
    },

    async getAccessToken() {
      const token = await currentToken()
      if (!token) throw new AuthRequiredError()
      return token
    },

    authFetch,
  }
}
