import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSessionAuth,
  purgeLegacySession,
  AuthRequiredError,
  AuthUnavailableError,
  type AuthClient,
} from './session-auth'
import { createIndexedDbDeckStore } from '../storage'
import { idbDestructiveOperations, resetFakeIdb } from '../storage/idb.test-support'

/** A fake of the Supabase auth client at the seam — an external unmanaged dependency. */
function fakeClient() {
  const auth = {
    signInWithPassword: vi.fn<AuthClient['auth']['signInWithPassword']>(),
    getSession: vi.fn<AuthClient['auth']['getSession']>(),
    signOut: vi.fn<AuthClient['auth']['signOut']>(),
    signInWithOtp: vi.fn<AuthClient['auth']['signInWithOtp']>(),
    resetPasswordForEmail: vi.fn<AuthClient['auth']['resetPasswordForEmail']>(),
    verifyOtp: vi.fn<AuthClient['auth']['verifyOtp']>(),
    updateUser: vi.fn<AuthClient['auth']['updateUser']>(),
  }
  auth.signOut.mockResolvedValue({ error: null })
  return { client: { auth } satisfies AuthClient, auth }
}

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial))
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

describe('createSessionAuth', () => {
  let fake: ReturnType<typeof fakeClient>
  let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>
  let onUnauthorized: ReturnType<typeof vi.fn<() => void>>

  beforeEach(() => {
    fake = fakeClient()
    fetchImpl = vi.fn<typeof fetch>()
    onUnauthorized = vi.fn()
  })

  function auth() {
    return createSessionAuth({ client: fake.client, fetchImpl, onUnauthorized })
  }

  function withSession(token: string) {
    fake.auth.getSession.mockResolvedValue({ data: { session: { access_token: token } }, error: null })
  }

  describe('login()', () => {
    it('signs in with the email and password', async () => {
      fake.auth.signInWithPassword.mockResolvedValue({ error: null })
      const result = await auth().login('her@example.com', 'correct-password')
      expect(result).toEqual({ ok: true })
      expect(fake.auth.signInWithPassword).toHaveBeenCalledWith({
        email: 'her@example.com',
        password: 'correct-password',
      })
    })

    it('returns invalid-credentials (never throws) when the server refuses the credentials', async () => {
      fake.auth.signInWithPassword.mockResolvedValue({ error: { message: 'Invalid login credentials', status: 400 } })
      expect(await auth().login('her@example.com', 'wrong')).toEqual({ ok: false, reason: 'invalid-credentials' })
    })

    it('returns network when the server cannot be reached', async () => {
      fake.auth.signInWithPassword.mockResolvedValue({ error: { message: 'fetch failed', status: 0 } })
      expect(await auth().login('her@example.com', 'x')).toEqual({ ok: false, reason: 'network' })
    })

    it('returns network when the client throws', async () => {
      fake.auth.signInWithPassword.mockRejectedValue(new TypeError('fetch failed'))
      expect(await auth().login('her@example.com', 'x')).toEqual({ ok: false, reason: 'network' })
    })

    it('returns network on a server error', async () => {
      fake.auth.signInWithPassword.mockResolvedValue({ error: { message: 'boom', status: 500 } })
      expect(await auth().login('her@example.com', 'x')).toEqual({ ok: false, reason: 'network' })
    })
  })

  describe('getAccessToken()', () => {
    it('resolves to the session access token', async () => {
      withSession('jwt-1')
      expect(await auth().getAccessToken()).toBe('jwt-1')
    })

    it('throws AuthRequiredError when there is no session', async () => {
      fake.auth.getSession.mockResolvedValue({ data: { session: null }, error: null })
      await expect(auth().getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError)
    })

    it('throws AuthUnavailableError, not AuthRequiredError, when the session could not be read or refreshed', async () => {
      fake.auth.getSession.mockResolvedValue({ data: { session: null }, error: { message: 'offline', status: 0 } })
      await expect(auth().getAccessToken()).rejects.toBeInstanceOf(AuthUnavailableError)
    })
  })

  describe('authFetch', () => {
    it('adds the access token as a bearer header and hands the response back untouched', async () => {
      withSession('jwt-1')
      const response = { status: 200 } as Response
      fetchImpl.mockResolvedValue(response)

      const result = await auth().authFetch('/api/library', { method: 'GET', headers: { accept: 'application/json' } })

      expect(result).toBe(response)
      const [url, init] = fetchImpl.mock.calls[0]
      expect(url).toBe('/api/library')
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer jwt-1')
      expect(headers.get('accept')).toBe('application/json')
      expect(onUnauthorized).not.toHaveBeenCalled()
    })

    it('sends no authorization header when there is no session, leaving the 401 to the server', async () => {
      fake.auth.getSession.mockResolvedValue({ data: { session: null }, error: null })
      fetchImpl.mockResolvedValue({ status: 200 } as Response)
      await auth().authFetch('/api/library')
      expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).has('authorization')).toBe(false)
    })

    it('on a 401, signs out, fires onUnauthorized once, and still returns the 401', async () => {
      withSession('jwt-1')
      const response = { status: 401 } as Response
      fetchImpl.mockResolvedValue(response)

      const result = await auth().authFetch('/api/tts')

      expect(result).toBe(response)
      expect(fake.auth.signOut).toHaveBeenCalledTimes(1)
      expect(onUnauthorized).toHaveBeenCalledTimes(1)
    })
  })

  describe('requestSignInCode()', () => {
    it('emails a sign-in code, and never creates an account for an address it does not know', async () => {
      fake.auth.signInWithOtp.mockResolvedValue({ error: null })
      expect(await auth().requestSignInCode(' her@example.com ')).toEqual({ ok: true })
      expect(fake.auth.signInWithOtp).toHaveBeenCalledWith({
        email: 'her@example.com',
        options: { shouldCreateUser: false },
      })
    })

    it('returns unknown-email when no account has that address', async () => {
      fake.auth.signInWithOtp.mockResolvedValue({
        error: { message: 'Signups not allowed for otp', status: 422, code: 'otp_disabled' },
      })
      expect(await auth().requestSignInCode('nobody@example.com')).toEqual({ ok: false, reason: 'unknown-email' })
    })

    it('returns rate-limited on a 429 and network on a failure or throw', async () => {
      fake.auth.signInWithOtp.mockResolvedValue({ error: { message: 'slow down', status: 429 } })
      expect(await auth().requestSignInCode('her@example.com')).toEqual({ ok: false, reason: 'rate-limited' })
      fake.auth.signInWithOtp.mockResolvedValue({ error: { message: 'boom', status: 500 } })
      expect(await auth().requestSignInCode('her@example.com')).toEqual({ ok: false, reason: 'network' })
      fake.auth.signInWithOtp.mockRejectedValue(new TypeError('fetch failed'))
      expect(await auth().requestSignInCode('her@example.com')).toEqual({ ok: false, reason: 'network' })
    })
  })

  describe('verifySignInCode()', () => {
    it('verifies the emailed code as a sign-in code', async () => {
      fake.auth.verifyOtp.mockResolvedValue({ error: null })
      expect(await auth().verifySignInCode('her@example.com', ' 654321 ')).toEqual({ ok: true })
      expect(fake.auth.verifyOtp).toHaveBeenCalledWith({ email: 'her@example.com', token: '654321', type: 'email' })
    })

    it('returns invalid-code when the code is wrong or expired', async () => {
      fake.auth.verifyOtp.mockResolvedValue({ error: { message: 'Token has expired or is invalid', status: 403, code: 'otp_expired' } })
      expect(await auth().verifySignInCode('her@example.com', '000000')).toEqual({ ok: false, reason: 'invalid-code' })
    })
  })

  describe('requestPasswordReset()', () => {
    it('asks for a reset email to that address', async () => {
      fake.auth.resetPasswordForEmail.mockResolvedValue({ error: null })
      expect(await auth().requestPasswordReset(' her@example.com ')).toEqual({ ok: true })
      expect(fake.auth.resetPasswordForEmail).toHaveBeenCalledWith('her@example.com')
    })

    it('returns rate-limited when too many emails were asked for', async () => {
      fake.auth.resetPasswordForEmail.mockResolvedValue({
        error: { message: 'email rate limit exceeded', status: 429, code: 'over_email_send_rate_limit' },
      })
      expect(await auth().requestPasswordReset('her@example.com')).toEqual({ ok: false, reason: 'rate-limited' })
    })

    it('returns network when the server cannot be reached or fails', async () => {
      fake.auth.resetPasswordForEmail.mockResolvedValue({ error: { message: 'boom', status: 500 } })
      expect(await auth().requestPasswordReset('her@example.com')).toEqual({ ok: false, reason: 'network' })
      fake.auth.resetPasswordForEmail.mockRejectedValue(new TypeError('fetch failed'))
      expect(await auth().requestPasswordReset('her@example.com')).toEqual({ ok: false, reason: 'network' })
    })
  })

  describe('verifyResetCode()', () => {
    it('verifies the emailed code as a recovery code, which signs her in', async () => {
      fake.auth.verifyOtp.mockResolvedValue({ error: null })
      expect(await auth().verifyResetCode('her@example.com', ' 123456 ')).toEqual({ ok: true })
      expect(fake.auth.verifyOtp).toHaveBeenCalledWith({ email: 'her@example.com', token: '123456', type: 'recovery' })
    })

    it('returns invalid-code when the code is wrong or expired', async () => {
      fake.auth.verifyOtp.mockResolvedValue({
        error: { message: 'Token has expired or is invalid', status: 403, code: 'otp_expired' },
      })
      expect(await auth().verifyResetCode('her@example.com', '000000')).toEqual({ ok: false, reason: 'invalid-code' })
    })

    it('returns rate-limited when too many codes were tried', async () => {
      fake.auth.verifyOtp.mockResolvedValue({ error: { message: 'slow down', status: 429 } })
      expect(await auth().verifyResetCode('her@example.com', '000000')).toEqual({ ok: false, reason: 'rate-limited' })
    })

    it('returns network when the client throws', async () => {
      fake.auth.verifyOtp.mockRejectedValue(new TypeError('fetch failed'))
      expect(await auth().verifyResetCode('her@example.com', '1')).toEqual({ ok: false, reason: 'network' })
    })
  })

  describe('changePassword()', () => {
    it('sets the new password on the signed-in account', async () => {
      fake.auth.updateUser.mockResolvedValue({ error: null })
      expect(await auth().changePassword('a-new-password')).toEqual({ ok: true })
      expect(fake.auth.updateUser).toHaveBeenCalledWith({ password: 'a-new-password' })
    })

    it('returns weak-password when the server refuses it as too weak', async () => {
      fake.auth.updateUser.mockResolvedValue({
        error: { message: 'Password should be at least 6 characters.', status: 422, code: 'weak_password' },
      })
      expect(await auth().changePassword('abc')).toEqual({ ok: false, reason: 'weak-password' })
    })

    it('returns same-password when it is the password she already has', async () => {
      fake.auth.updateUser.mockResolvedValue({
        error: { message: 'New password should be different from the old password.', status: 422, code: 'same_password' },
      })
      expect(await auth().changePassword('old-one')).toEqual({ ok: false, reason: 'same-password' })
    })

    it('returns signed-out when there is no session to change it on', async () => {
      fake.auth.updateUser.mockResolvedValue({ error: { message: 'Auth session missing!', status: 400, name: 'AuthSessionMissingError' } })
      expect(await auth().changePassword('x-y-z-w-v')).toEqual({ ok: false, reason: 'signed-out' })
    })

    it('returns network on a server error or a throw', async () => {
      fake.auth.updateUser.mockResolvedValue({ error: { message: 'boom', status: 500 } })
      expect(await auth().changePassword('a-new-password')).toEqual({ ok: false, reason: 'network' })
      fake.auth.updateUser.mockRejectedValue(new TypeError('fetch failed'))
      expect(await auth().changePassword('a-new-password')).toEqual({ ok: false, reason: 'network' })
    })
  })

  describe('logout()', () => {
    it('signs out', async () => {
      await auth().logout()
      expect(fake.auth.signOut).toHaveBeenCalledTimes(1)
    })
  })

  describe('IndexedDB', () => {
    it('a forced logout (401) never touches her library or any other IndexedDB record', async () => {
      resetFakeIdb()
      vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(true) } })
      const deckStore = createIndexedDbDeckStore()
      const deck = { id: 'deck-1', name: 'Home', phrases: [{ id: 'p1', french: 'Bonjour', english: 'Hello' }] }
      await deckStore.save(deck)
      idbDestructiveOperations.length = 0

      withSession('jwt-1')
      fetchImpl.mockResolvedValue({ status: 401 } as Response)
      const a = auth()
      await a.authFetch('/api/library')
      await a.logout()

      expect(onUnauthorized).toHaveBeenCalled()
      expect(idbDestructiveOperations).toEqual([])
      expect(await deckStore.loadAll()).toEqual([deck])
    })
  })
})

describe('purgeLegacySession', () => {
  it('deletes the retired session-token key and nothing else', () => {
    const storage = fakeStorage({ 'phrase-drill-session': '{"token":"t","expiresAt":1}', other: 'keep' })
    purgeLegacySession(storage)
    expect(storage.getItem('phrase-drill-session')).toBeNull()
    expect(storage.getItem('other')).toBe('keep')
  })

  it('is a no-op when the key is absent', () => {
    const storage = fakeStorage()
    expect(() => purgeLegacySession(storage)).not.toThrow()
  })
})
