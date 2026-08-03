/**
 * The device's login (T043): browser authorization-code + PKCE (S256)
 * against Keycloak, a public client with no secret — nothing here can hold
 * one, since it ships inside a static PWA build anyone can read. Replaces
 * the device-generated 64-hex library key entirely (deleted, not kept
 * beside this): her identity on the server is now the Keycloak `sub` this
 * flow ultimately proves.
 *
 * `getAccessToken()` is the one thing the three server-calling adapters
 * (`server-synth-client`, `server-scan-reader`, `library-sync-client`) need
 * — it returns a token that's fresh for at least `REFRESH_AHEAD_MS` longer,
 * silently exchanging the refresh token first if not. A caller with nothing
 * logged in yet gets `AuthRequiredError`, which the composition root turns
 * into a call to `login()` (a full-page redirect — there is no popup/iframe
 * flow here, matching "one browser, one Safari" scope, AGENTS.md).
 *
 * Access tokens live in memory only (`state`, reset on reload); the refresh
 * token additionally persists in `storage` (real `localStorage`) so a
 * reload — or the realm's 30-day idle session (T043 verified notes) —
 * doesn't force a fresh login every time the PWA relaunches.
 */

const STORAGE_KEY = 'phrase-drill-auth'
const PENDING_KEY = 'phrase-drill-auth-pending'
const REFRESH_AHEAD_MS = 30_000 // refresh once an access token has under 30s left, never wait for a 401

export class AuthRequiredError extends Error {
  constructor(reason = 'not-authenticated') {
    super(`login required: ${reason}`)
    this.name = 'AuthRequiredError'
  }
}

export interface KeycloakAuthConfig {
  issuerUrl: string
  realm: string
  clientId: string
  redirectUri: string
  storage?: Storage
  fetchImpl?: typeof fetch
  /** Navigates the browser — `(url: string) => void`, defaults to `window.location.assign`. */
  assign?: (url: string) => void
  now?: () => number
}

export interface KeycloakAuth {
  /** Full-page-redirects to Keycloak's authorize endpoint with a fresh PKCE challenge. */
  login(): Promise<void>
  /** Call once on boot with the current URL. No-ops if the URL carries no `code`/`state`. */
  handleRedirectCallback(url: string): Promise<void>
  /** Resolves to a token fresh for at least `REFRESH_AHEAD_MS`, refreshing first if needed. Throws `AuthRequiredError` if login is required. */
  getAccessToken(): Promise<string>
  /** Clears every stored token — the next `getAccessToken()` throws `AuthRequiredError`. */
  logout(): void
}

interface StoredTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number // epoch ms
}

interface PendingLogin {
  codeVerifier: string
  state: string
}

export function createKeycloakAuth(config: KeycloakAuthConfig): KeycloakAuth {
  const storage = config.storage ?? window.localStorage
  const fetchImpl = config.fetchImpl ?? fetch
  const assign = config.assign ?? ((url: string) => window.location.assign(url))
  const now = config.now ?? (() => Date.now())
  const tokenEndpoint = `${config.issuerUrl}/realms/${config.realm}/protocol/openid-connect/token`
  const authEndpoint = `${config.issuerUrl}/realms/${config.realm}/protocol/openid-connect/auth`

  let tokens: StoredTokens | null = loadTokens()

  function loadTokens(): StoredTokens | null {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return null
    try {
      return JSON.parse(raw) as StoredTokens
    } catch {
      return null
    }
  }

  function saveTokens(t: StoredTokens): void {
    tokens = t
    storage.setItem(STORAGE_KEY, JSON.stringify(t))
  }

  function clearTokens(): void {
    tokens = null
    storage.removeItem(STORAGE_KEY)
  }

  async function exchangeForTokens(params: URLSearchParams): Promise<StoredTokens> {
    const res = await fetchImpl(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
    if (!res.ok) throw new AuthRequiredError('token-exchange-rejected')
    const body = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: now() + body.expires_in * 1000,
    }
  }

  return {
    async login() {
      const codeVerifier = generateCodeVerifier()
      const codeChallenge = await sha256Base64Url(codeVerifier)
      const state = generateState()
      storage.setItem(PENDING_KEY, JSON.stringify({ codeVerifier, state } satisfies PendingLogin))

      const url = new URL(authEndpoint)
      url.searchParams.set('client_id', config.clientId)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('redirect_uri', config.redirectUri)
      url.searchParams.set('code_challenge', codeChallenge)
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('state', state)
      url.searchParams.set('scope', 'openid')

      assign(url.toString())
    },

    async handleRedirectCallback(urlString) {
      const url = new URL(urlString)
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      if (!code || !state) return

      const pendingRaw = storage.getItem(PENDING_KEY)
      const pending = pendingRaw ? (JSON.parse(pendingRaw) as PendingLogin) : null
      if (!pending || pending.state !== state) {
        throw new Error('auth callback state mismatch — possible CSRF or a stale/duplicate redirect')
      }
      storage.removeItem(PENDING_KEY)

      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.clientId,
        code,
        code_verifier: pending.codeVerifier,
        redirect_uri: config.redirectUri,
      })
      saveTokens(await exchangeForTokens(body))
    },

    async getAccessToken() {
      if (!tokens) throw new AuthRequiredError()

      if (tokens.expiresAt - now() > REFRESH_AHEAD_MS) return tokens.accessToken

      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: config.clientId,
        refresh_token: tokens.refreshToken,
      })
      try {
        const refreshed = await exchangeForTokens(body)
        saveTokens(refreshed)
        return refreshed.accessToken
      } catch {
        clearTokens()
        throw new AuthRequiredError('refresh-rejected')
      }
    },

    logout() {
      clearTokens()
    },
  }
}

function generateState(): string {
  return randomBase64Url(16)
}

function generateCodeVerifier(): string {
  // RFC 7636 §4.1: 43-128 chars from the unreserved set — 32 random bytes,
  // base64url-encoded, lands at 43 characters.
  return randomBase64Url(32)
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return bytesToBase64Url(bytes)
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return bytesToBase64Url(new Uint8Array(digest))
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
