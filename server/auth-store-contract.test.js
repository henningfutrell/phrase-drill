// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createSessionAuth, hashPassword } from './session-auth.js'
import { createAuthStore } from './db.js'

/**
 * T052: `server/session-auth.js` calls `userStore.getByUsername`,
 * `sessionStore.create`/`get`/`delete`. `server/db.js`'s `createAuthStore`
 * used to expose `getUserByUsername`/`createUser`/`createSession`/
 * `getSession`/`deleteSession` on one flat object, and `server/index.js`
 * passed that same object as *both* `userStore` and `sessionStore`. Not one
 * name matched — every login 500'd in production
 * ("userStore.getByUsername is not a function") — while
 * `session-auth.test.js` (fakes written to the seam) and `db.test.js` (the
 * store's own SQL) both stayed green, because neither test ever put the
 * real store through the real seam.
 *
 * This file is that missing check. It does not hand-maintain a list of
 * required method names — a list here could drift out of sync with
 * `session-auth.js` the same way `db.js` already had. Instead it *records*,
 * by proxy, exactly which methods `createSessionAuth`'s `login`/`logout`/
 * `verify` actually call on the stores it's given, then asserts the real
 * `createAuthStore` exposes every one of them, as a function, at
 * `.users`/`.sessions` — the same shape `server/index.js` wires in.
 */

/** Wraps `base` so every property read that resolves to a function is recorded in `called`, then proxies the call through unchanged. */
function recordingProxy(base, called) {
  return new Proxy(base, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value === 'function') {
        called.add(prop)
        return value.bind(target)
      }
      return value
    },
  })
}

/**
 * Drives `createSessionAuth` through login (unknown user, known user with
 * correct password), verify, and logout against harmless in-memory fakes,
 * recording every property `login`/`logout`/`verify` actually touch. This
 * is the single source of truth for "what the seam requires" — derived from
 * running the seam's own code, not copied from it by hand.
 */
function discoverRequiredMethods() {
  const userCalled = new Set()
  const sessionCalled = new Set()

  const knownUser = { id: 'user-1', username: 'her', passwordHash: hashPassword('correct-password') }
  const fakeUsers = {
    async getByUsername(username) {
      return username === 'her' ? knownUser : null
    },
  }

  const sessionRows = new Map()
  const fakeSessions = {
    async create(tokenHash, userId, createdAt, expiresAt) {
      sessionRows.set(tokenHash, { userId, expiresAt })
    },
    async get(tokenHash) {
      return sessionRows.get(tokenHash) ?? null
    },
    async delete(tokenHash) {
      sessionRows.delete(tokenHash)
    },
  }

  const userStore = recordingProxy(fakeUsers, userCalled)
  const sessionStore = recordingProxy(fakeSessions, sessionCalled)
  const auth = createSessionAuth({ userStore, sessionStore, now: () => 1_000_000 })

  return (async () => {
    await auth.login('nobody', 'anything') // exercises the unknown-user path
    const { token } = await auth.login('her', 'correct-password') // exercises the success path
    await auth.verify(token)
    await auth.logout(token)
    return { userMethods: [...userCalled], sessionMethods: [...sessionCalled] }
  })()
}

/** A `pg` `Pool` stand-in, just enough to let `createAuthStore`'s methods run without a live Postgres. */
function fakePool() {
  return {
    async query() {
      return { rows: [] }
    },
    async end() {},
  }
}

describe('the real createAuthStore satisfies what createSessionAuth requires (T052)', () => {
  it('exposes every userStore method the seam calls, as a function, at .users', async () => {
    const { userMethods } = await discoverRequiredMethods()
    expect(userMethods).toEqual(expect.arrayContaining(['getByUsername']))

    const store = createAuthStore(fakePool())
    for (const name of userMethods) {
      expect(typeof store.users?.[name], `store.users.${name} must be a function`).toBe('function')
    }
  })

  it('exposes every sessionStore method the seam calls, as a function, at .sessions', async () => {
    const { sessionMethods } = await discoverRequiredMethods()
    expect(sessionMethods).toEqual(expect.arrayContaining(['create', 'get', 'delete']))

    const store = createAuthStore(fakePool())
    for (const name of sessionMethods) {
      expect(typeof store.sessions?.[name], `store.sessions.${name} must be a function`).toBe('function')
    }
  })

  it('wired exactly as server/index.js wires it — { userStore: authStore.users, sessionStore: authStore.sessions } — logs a user in without throwing', async () => {
    const store = createAuthStore(fakePool())
    const auth = createSessionAuth({ userStore: store.users, sessionStore: store.sessions })

    // fakePool's SELECT always returns no rows, so this is an unknown-user
    // login — the point isn't a successful login, it's that `userStore.
    // getByUsername is not a function` never fires.
    await expect(auth.login('her', 'anything')).resolves.toBeNull()
  })
})
