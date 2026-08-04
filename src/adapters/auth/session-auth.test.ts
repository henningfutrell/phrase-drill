import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSessionAuth, AuthRequiredError } from './session-auth'

/** In-memory stand-in for `localStorage` — the real thing isn't available under `@vitest-environment node`. */
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

describe('createSessionAuth', () => {
  let storage: Storage
  let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>
  let now: number
  let onUnauthorized: ReturnType<typeof vi.fn<() => void>>

  beforeEach(() => {
    storage = fakeStorage()
    fetchImpl = vi.fn<typeof fetch>()
    now = 1_000_000
    onUnauthorized = vi.fn()
  })

  function auth() {
    return createSessionAuth({ storage, fetchImpl, now: () => now, onUnauthorized })
  }

  describe('login()', () => {
    it('POSTs credentials to /api/login and stores the returned token on success', async () => {
      fetchImpl.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ token: 'tok-1', expiresAt: now + 1000 }),
      } as unknown as Response)

      const a = auth()
      const result = await a.login('her', 'correct-password')

      expect(result).toEqual({ ok: true })
      expect(fetchImpl).toHaveBeenCalledWith(
        '/api/login',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ username: 'her', password: 'correct-password' }),
        }),
      )
      expect(await a.getAccessToken()).toBe('tok-1')
    })

    it('returns a failure result (never throws) on 401, and stores nothing', async () => {
      fetchImpl.mockResolvedValue({ ok: false, status: 401 } as unknown as Response)

      const a = auth()
      const result = await a.login('her', 'wrong-password')

      expect(result).toEqual({ ok: false, reason: 'invalid-credentials' })
      await expect(a.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError)
    })

    it('returns a network failure result when the request itself throws', async () => {
      fetchImpl.mockRejectedValue(new Error('offline'))

      const result = await auth().login('her', 'correct-password')

      expect(result).toEqual({ ok: false, reason: 'network' })
    })
  })

  describe('getAccessToken()', () => {
    it('throws AuthRequiredError when nothing is logged in yet', async () => {
      await expect(auth().getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError)
    })

    it('persists the token across a reload — a fresh instance over the same storage reuses it', async () => {
      fetchImpl.mockResolvedValue({ ok: true, status: 200, json: async () => ({ token: 'tok-1', expiresAt: now + 1000 }) } as unknown as Response)
      await auth().login('her', 'correct-password')

      const b = createSessionAuth({ storage, fetchImpl, now: () => now, onUnauthorized })
      expect(await b.getAccessToken()).toBe('tok-1')
    })

    it('throws AuthRequiredError once the stored token is past its own expiresAt, and clears it', async () => {
      fetchImpl.mockResolvedValue({ ok: true, status: 200, json: async () => ({ token: 'tok-1', expiresAt: now + 1000 }) } as unknown as Response)
      const a = auth()
      await a.login('her', 'correct-password')

      now += 1001
      await expect(a.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError)

      const b = createSessionAuth({ storage, fetchImpl, now: () => now, onUnauthorized })
      await expect(b.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError)
    })
  })

  describe('logout()', () => {
    it('POSTs to /api/logout with the bearer token, then clears storage regardless of the response', async () => {
      fetchImpl.mockResolvedValue({ ok: true, status: 200, json: async () => ({ token: 'tok-1', expiresAt: now + 1000 }) } as unknown as Response)
      const a = auth()
      await a.login('her', 'correct-password')
      fetchImpl.mockResolvedValue({ ok: true, status: 204 } as unknown as Response)

      await a.logout()

      expect(fetchImpl).toHaveBeenCalledWith(
        '/api/logout',
        expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ authorization: 'Bearer tok-1' }) }),
      )
      await expect(a.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError)
    })

    it('clears storage even if the /api/logout call fails', async () => {
      fetchImpl.mockResolvedValue({ ok: true, status: 200, json: async () => ({ token: 'tok-1', expiresAt: now + 1000 }) } as unknown as Response)
      const a = auth()
      await a.login('her', 'correct-password')
      fetchImpl.mockRejectedValue(new Error('offline'))

      await expect(a.logout()).resolves.not.toThrow()
      await expect(a.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError)
    })
  })

  describe('authFetch', () => {
    it('passes calls straight through to the injected fetch', async () => {
      const response = { ok: true, status: 200 } as unknown as Response
      fetchImpl.mockResolvedValue(response)

      const result = await auth().authFetch('/api/tts', { method: 'POST' })

      expect(result).toBe(response)
      expect(fetchImpl).toHaveBeenCalledWith('/api/tts', { method: 'POST' })
    })

    it('clears the stored token and calls onUnauthorized when a call comes back 401', async () => {
      fetchImpl.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ token: 'tok-1', expiresAt: now + 1000 }),
      } as unknown as Response)
      const a = auth()
      await a.login('her', 'correct-password')

      fetchImpl.mockResolvedValueOnce({ ok: false, status: 401 } as unknown as Response)
      await a.authFetch('/api/tts', { method: 'POST' })

      expect(onUnauthorized).toHaveBeenCalledTimes(1)
      await expect(a.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError)
    })

    it('does not call onUnauthorized for a non-401 response', async () => {
      fetchImpl.mockResolvedValue({ ok: true, status: 200 } as unknown as Response)
      await auth().authFetch('/api/tts', { method: 'POST' })
      expect(onUnauthorized).not.toHaveBeenCalled()
    })
  })
})
