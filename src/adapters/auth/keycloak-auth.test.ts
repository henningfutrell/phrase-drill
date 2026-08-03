import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createKeycloakAuth, AuthRequiredError } from './keycloak-auth'

/** In-memory stand-in for `localStorage` — the real thing isn't available under `@vitest-environment node`, and this is small enough not to need jsdom for these tests. */
function fakeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size
    },
  } as Storage
}

const CONFIG = {
  issuerUrl: 'http://localhost:8081',
  realm: 'phrase-drill',
  clientId: 'phrase-drill-app',
  redirectUri: 'http://localhost:8080/',
}

function makeTokenResponse(overrides: Partial<{ access_token: string; refresh_token: string; expires_in: number }> = {}) {
  return {
    access_token: overrides.access_token ?? 'fresh-access-token',
    refresh_token: overrides.refresh_token ?? 'fresh-refresh-token',
    token_type: 'Bearer',
    expires_in: overrides.expires_in ?? 300,
  }
}

describe('createKeycloakAuth', () => {
  let storage: Storage
  let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>
  let assign: ReturnType<typeof vi.fn<(url: string) => void>>
  let now: number

  beforeEach(() => {
    storage = fakeStorage()
    fetchImpl = vi.fn<typeof fetch>()
    assign = vi.fn<(url: string) => void>()
    now = 1_000_000
  })

  function auth() {
    return createKeycloakAuth({ ...CONFIG, storage, fetchImpl, assign, now: () => now })
  }

  describe('login()', () => {
    it('redirects to the realm authorize endpoint with a PKCE S256 challenge, a public client, and no secret', async () => {
      await auth().login()

      expect(assign).toHaveBeenCalledTimes(1)
      const url = new URL(assign.mock.calls[0]![0] as string)
      expect(url.origin + url.pathname).toBe('http://localhost:8081/realms/phrase-drill/protocol/openid-connect/auth')
      expect(url.searchParams.get('client_id')).toBe('phrase-drill-app')
      expect(url.searchParams.get('response_type')).toBe('code')
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      expect(url.searchParams.get('code_challenge')).toBeTruthy()
      expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8080/')
      expect(url.searchParams.get('state')).toBeTruthy()
      // no client_secret anywhere in the request this app makes
      expect(url.searchParams.get('client_secret')).toBeNull()
    })

    it('stores the code verifier and state so the callback can complete the exchange', async () => {
      await auth().login()
      expect(storage.getItem('phrase-drill-auth-pending')).not.toBeNull()
    })
  })

  describe('handleRedirectCallback()', () => {
    it('exchanges the code for tokens using the stored verifier, with no client secret', async () => {
      const a = auth()
      await a.login()
      const url = new URL(assign.mock.calls[0]![0] as string)
      const state = url.searchParams.get('state')!

      fetchImpl.mockResolvedValue({ ok: true, json: async () => makeTokenResponse() } as unknown as Response)

      await a.handleRedirectCallback(`http://localhost:8080/?code=abc123&state=${state}`)

      expect(fetchImpl).toHaveBeenCalledTimes(1)
      const [tokenUrl, init] = fetchImpl.mock.calls[0]!
      expect(tokenUrl).toBe('http://localhost:8081/realms/phrase-drill/protocol/openid-connect/token')
      const body = new URLSearchParams(init!.body as string)
      expect(body.get('grant_type')).toBe('authorization_code')
      expect(body.get('code')).toBe('abc123')
      expect(body.get('client_id')).toBe('phrase-drill-app')
      expect(body.get('code_verifier')).toBeTruthy()
      expect(body.get('client_secret')).toBeNull()
      expect(body.get('redirect_uri')).toBe('http://localhost:8080/')
    })

    it('rejects a callback whose state does not match what login() stored (CSRF/mismatched flow)', async () => {
      const a = auth()
      await a.login()

      await expect(a.handleRedirectCallback('http://localhost:8080/?code=abc123&state=wrong')).rejects.toThrow()
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('is a no-op when the URL carries no auth callback params', async () => {
      const a = auth()
      await a.handleRedirectCallback('http://localhost:8080/')
      expect(fetchImpl).not.toHaveBeenCalled()
    })
  })

  describe('getAccessToken()', () => {
    it('throws AuthRequiredError when nothing is logged in yet', async () => {
      await expect(auth().getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError)
    })

    it('returns the current access token without a network call while it is still fresh', async () => {
      const a = auth()
      await a.login()
      const state = new URL(assign.mock.calls[0]![0] as string).searchParams.get('state')!
      fetchImpl.mockResolvedValue({ ok: true, json: async () => makeTokenResponse({ access_token: 'tok-1', expires_in: 300 }) } as unknown as Response)
      await a.handleRedirectCallback(`http://localhost:8080/?code=c&state=${state}`)
      fetchImpl.mockClear()

      const token = await a.getAccessToken()

      expect(token).toBe('tok-1')
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('silently refreshes via the refresh_token grant once the access token is close to expiry, and proves the new token is returned', async () => {
      const a = auth()
      await a.login()
      const state = new URL(assign.mock.calls[0]![0] as string).searchParams.get('state')!
      fetchImpl.mockResolvedValue({ ok: true, json: async () => makeTokenResponse({ access_token: 'tok-1', refresh_token: 'refresh-1', expires_in: 300 }) } as unknown as Response)
      await a.handleRedirectCallback(`http://localhost:8080/?code=c&state=${state}`)

      // 4m45s later — inside the 30s refresh-ahead window this adapter uses.
      now += 285_000
      fetchImpl.mockResolvedValue({ ok: true, json: async () => makeTokenResponse({ access_token: 'tok-2', refresh_token: 'refresh-2', expires_in: 300 }) } as unknown as Response)

      const token = await a.getAccessToken()

      expect(token).toBe('tok-2')
      const [, init] = fetchImpl.mock.calls.at(-1)!
      const body = new URLSearchParams(init!.body as string)
      expect(body.get('grant_type')).toBe('refresh_token')
      expect(body.get('refresh_token')).toBe('refresh-1')
    })

    it('persists tokens across a reload — a fresh adapter instance over the same storage reuses them without re-login', async () => {
      const a = auth()
      await a.login()
      const state = new URL(assign.mock.calls[0]![0] as string).searchParams.get('state')!
      fetchImpl.mockResolvedValue({ ok: true, json: async () => makeTokenResponse({ access_token: 'tok-1', expires_in: 300 }) } as unknown as Response)
      await a.handleRedirectCallback(`http://localhost:8080/?code=c&state=${state}`)

      const b = createKeycloakAuth({ ...CONFIG, storage, fetchImpl, assign, now: () => now })
      const token = await b.getAccessToken()

      expect(token).toBe('tok-1')
    })

    it('throws AuthRequiredError if the refresh grant itself is rejected (refresh token also expired)', async () => {
      const a = auth()
      await a.login()
      const state = new URL(assign.mock.calls[0]![0] as string).searchParams.get('state')!
      fetchImpl.mockResolvedValue({ ok: true, json: async () => makeTokenResponse({ expires_in: 300 }) } as unknown as Response)
      await a.handleRedirectCallback(`http://localhost:8080/?code=c&state=${state}`)

      now += 285_000
      fetchImpl.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) } as unknown as Response)

      await expect(a.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError)
    })
  })

  describe('logout()', () => {
    it('clears stored tokens so the next getAccessToken() requires login again', async () => {
      const a = auth()
      await a.login()
      const state = new URL(assign.mock.calls[0]![0] as string).searchParams.get('state')!
      fetchImpl.mockResolvedValue({ ok: true, json: async () => makeTokenResponse() } as unknown as Response)
      await a.handleRedirectCallback(`http://localhost:8080/?code=c&state=${state}`)

      a.logout()

      await expect(a.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError)
    })
  })
})
