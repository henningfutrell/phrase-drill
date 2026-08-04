// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword, generateSessionToken, hashToken, createSessionAuth } from './session-auth.js'

describe('hashPassword / verifyPassword (scrypt, node:crypto)', () => {
  it('verifies the correct password against its own hash', () => {
    const hash = hashPassword('correct horse battery staple')
    expect(verifyPassword('correct horse battery staple', hash)).toBe(true)
  })

  it('rejects a wrong password', () => {
    const hash = hashPassword('correct horse battery staple')
    expect(verifyPassword('wrong password', hash)).toBe(false)
  })

  it('salts every hash independently — the same password hashes differently each time', () => {
    const a = hashPassword('same-password')
    const b = hashPassword('same-password')
    expect(a).not.toBe(b)
    expect(verifyPassword('same-password', a)).toBe(true)
    expect(verifyPassword('same-password', b)).toBe(true)
  })

  it('embeds the scrypt cost parameters in the stored hash so they can be raised later', () => {
    const hash = hashPassword('x')
    expect(hash).toMatch(/^scrypt:\d+:\d+:\d+:/)
  })

  it('never throws on a malformed stored hash — verifyPassword just returns false', () => {
    expect(verifyPassword('anything', 'not-a-real-hash')).toBe(false)
    expect(verifyPassword('anything', '')).toBe(false)
    expect(verifyPassword('anything', null)).toBe(false)
    expect(verifyPassword('anything', undefined)).toBe(false)
  })
})

describe('generateSessionToken', () => {
  it('produces a base64url token and the sha-256 hash stored for lookup, and they differ', () => {
    const { token, tokenHash } = generateSessionToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(token.length).toBeGreaterThanOrEqual(40) // 32 random bytes, base64url
    expect(tokenHash).toBe(hashToken(token))
    expect(tokenHash).not.toBe(token)
  })

  it('never repeats a token across calls', () => {
    const seen = new Set()
    for (let i = 0; i < 50; i++) seen.add(generateSessionToken().token)
    expect(seen.size).toBe(50)
  })
})

/** In-memory stand-in for the users half of the Postgres-backed auth store. */
function fakeUserStore(users = new Map()) {
  return {
    users,
    async getByUsername(username) {
      return users.get(username) ?? null
    },
  }
}

/** In-memory stand-in for the sessions half. */
function fakeSessionStore() {
  const rows = new Map()
  return {
    rows,
    async create(tokenHash, userId, createdAt, expiresAt) {
      rows.set(tokenHash, { userId, createdAt, expiresAt })
    },
    async get(tokenHash) {
      const row = rows.get(tokenHash)
      if (!row) return null
      return { userId: row.userId, expiresAt: row.expiresAt }
    },
    async delete(tokenHash) {
      rows.delete(tokenHash)
    },
  }
}

/** Wraps the real `verifyPassword` and counts how many times it actually ran the KDF. */
function countingVerifyPassword() {
  let calls = 0
  const fn = (password, stored) => {
    calls++
    return verifyPassword(password, stored)
  }
  fn.calls = () => calls
  return fn
}

describe('createSessionAuth', () => {
  function setup({ now = () => 1_000_000, verifyPassword: verifyPasswordImpl } = {}) {
    const users = new Map([
      ['her', { id: 'user-1', username: 'her', passwordHash: hashPassword('correct-password') }],
    ])
    const userStore = fakeUserStore(users)
    const sessionStore = fakeSessionStore()
    const auth = createSessionAuth({
      userStore,
      sessionStore,
      now,
      ...(verifyPasswordImpl ? { verifyPassword: verifyPasswordImpl } : {}),
    })
    return { auth, userStore, sessionStore, now }
  }

  describe('login', () => {
    it('returns a token and a 30-day expiry for correct credentials, and stores only the hash', async () => {
      const { auth, sessionStore, now } = setup()
      const result = await auth.login('her', 'correct-password')
      expect(result).not.toBeNull()
      expect(result.expiresAt).toBe(now() + 30 * 24 * 60 * 60 * 1000)
      expect(sessionStore.rows.size).toBe(1)
      const [storedHash] = sessionStore.rows.keys()
      expect(storedHash).not.toBe(result.token)
      expect(storedHash).toBe(hashToken(result.token))
    })

    it('returns null for a wrong password', async () => {
      const { auth } = setup()
      expect(await auth.login('her', 'wrong-password')).toBeNull()
    })

    it('returns null for a nonexistent username, identically to a wrong password (no user-enumeration signal in the response)', async () => {
      const { auth } = setup()
      const noSuchUser = await auth.login('nobody', 'anything')
      const wrongPassword = await auth.login('her', 'wrong-password')
      expect(noSuchUser).toBeNull()
      expect(wrongPassword).toBeNull()
    })

    it('performs exactly one password verification (one KDF run) per attempt, whether or not the username exists — no timing side channel', async () => {
      const verifyPasswordSpy = countingVerifyPassword()
      const { auth } = setup({ verifyPassword: verifyPasswordSpy })

      await auth.login('nobody', 'anything')
      expect(verifyPasswordSpy.calls()).toBe(1)

      await auth.login('her', 'wrong-password')
      expect(verifyPasswordSpy.calls()).toBe(2)
    })
  })

  describe('verify', () => {
    it('resolves to the session subject for a valid, unexpired token', async () => {
      const { auth } = setup()
      const { token } = await auth.login('her', 'correct-password')
      const claims = await auth.verify(token)
      expect(claims).toEqual({ sub: 'user-1' })
    })

    it('rejects an unknown token', async () => {
      const { auth } = setup()
      await expect(auth.verify('not-a-real-token')).rejects.toThrow()
    })

    it('rejects and deletes an expired session row', async () => {
      let t = 1_000_000
      const { auth, sessionStore } = setup({ now: () => t })
      const { token } = await auth.login('her', 'correct-password')
      expect(sessionStore.rows.size).toBe(1)

      t += 30 * 24 * 60 * 60 * 1000 + 1 // one ms past the 30-day expiry
      await expect(auth.verify(token)).rejects.toThrow()
      expect(sessionStore.rows.size).toBe(0)
    })
  })

  describe('logout', () => {
    it('deletes the session row so the token no longer verifies', async () => {
      const { auth, sessionStore } = setup()
      const { token } = await auth.login('her', 'correct-password')
      expect(sessionStore.rows.size).toBe(1)

      await auth.logout(token)

      expect(sessionStore.rows.size).toBe(0)
      await expect(auth.verify(token)).rejects.toThrow()
    })

    it('is a harmless no-op for a token that never existed', async () => {
      const { auth } = setup()
      await expect(auth.logout('nonsense')).resolves.not.toThrow()
    })
  })
})
