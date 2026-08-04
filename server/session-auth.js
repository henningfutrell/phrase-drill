import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto'

/**
 * Password hashing and session-token identity for T050, replacing Keycloak
 * and the JWT verifier it required (`server/jwt-verifier.js`, deleted, not
 * adapted). Two users, no vendor account, no OIDC redirect dance: a session
 * is a row in `sessions` (`server/db.js`'s `createAuthStore`), looked up by
 * the SHA-256 of the bearer token, which gives revocation for free
 * (`DELETE FROM sessions` on logout) and deletes every JWT footgun this
 * repo would otherwise own forever (JWKS fetching, RS256, key rotation,
 * clock skew, audience/issuer checks).
 *
 * `node:crypto`'s `scrypt` binding is OpenSSL's implementation of RFC 7914
 * — not hand-rolled, not a new dependency. Parameters are embedded in the
 * stored hash string so the cost can be raised later without invalidating
 * hashes minted under today's parameters.
 */

const SCRYPT_KEYLEN = 64
const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SALT_BYTES = 16
const TOKEN_BYTES = 32
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

/**
 * A fixed, valid-format hash nobody's real password will ever match, verified
 * against on every login for a username that doesn't exist. Its only job is
 * to make `scryptSync` run once per login attempt no matter what — see
 * `login` below for why. `hashPassword` is a hoisted function declaration,
 * so calling it here (above its own textual definition) is safe.
 */
const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(32).toString('hex'))

/** `scrypt:<N>:<r>:<p>:<salt-base64>:<hash-base64>` — self-describing, so a future cost bump doesn't break existing rows. */
export function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES)
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('base64')}:${derived.toString('base64')}`
}

/** Never throws — a malformed stored hash (or none) just means "does not verify," never a 500. Always `crypto.timingSafeEqual`, never `===`. */
export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false
  const parts = stored.split(':')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts
  const N = Number(nStr)
  const r = Number(rStr)
  const p = Number(pStr)
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false

  let salt, expected, actual
  try {
    salt = Buffer.from(saltB64, 'base64')
    expected = Buffer.from(hashB64, 'base64')
    actual = scryptSync(password, salt, expected.length, { N, r, p })
  } catch {
    return false
  }
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

/** 32 random bytes, base64url — the token; and its SHA-256 hex digest — the only thing ever stored, so a database leak yields no usable tokens. */
export function generateSessionToken() {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  return { token, tokenHash: hashToken(token) }
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * The one seam `server/app.js` depends on: `login`/`logout`/`verify`. Takes
 * a `userStore` (`getByUsername`) and a `sessionStore` (`create`/`get`/
 * `delete`) rather than a pool directly, so this logic is unit-tested
 * against fakes (`session-auth.test.js`) and `server/db.js`'s
 * `createAuthStore` is what proves the real SQL against a live Postgres.
 */
export function createSessionAuth({ userStore, sessionStore, now = () => Date.now(), verifyPassword: verifyPasswordFn = verifyPassword }) {
  return {
    /**
     * `null` for any invalid credentials — same response shape for "no such
     * user" and "wrong password," and comparable timing too: an unknown
     * username still runs one scrypt verification, against
     * `DUMMY_PASSWORD_HASH`, so a network observer can't use response time
     * to tell "no such user" from "wrong password" either. The rate limiter
     * in front of this endpoint (`server/app.js`, 5 attempts/60s per
     * username) is the primary control against guessing either way — this
     * only closes a side channel, it doesn't replace that limit.
     */
    async login(username, password) {
      const user = await userStore.getByUsername(username)
      const passwordOk = verifyPasswordFn(password, user ? user.passwordHash : DUMMY_PASSWORD_HASH)
      if (!user || !passwordOk) return null

      const { token, tokenHash } = generateSessionToken()
      const createdAt = now()
      const expiresAt = createdAt + SESSION_TTL_MS
      await sessionStore.create(tokenHash, user.id, createdAt, expiresAt)
      return { token, expiresAt }
    },

    async logout(token) {
      await sessionStore.delete(hashToken(token))
    },

    /** Resolves to `{ sub: userId }` for a valid, unexpired session; throws otherwise. An expired row is rejected AND deleted, not just rejected. */
    async verify(token) {
      const tokenHash = hashToken(token)
      const session = await sessionStore.get(tokenHash)
      if (!session) throw new Error('session not found')
      if (session.expiresAt <= now()) {
        await sessionStore.delete(tokenHash)
        throw new Error('session expired')
      }
      return { sub: session.userId }
    },
  }
}
