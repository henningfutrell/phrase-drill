import { createPublicKey, verify as cryptoVerify } from 'node:crypto'

/** Thrown for every rejection path in `verify()` — malformed, unsigned, expired, wrong issuer/audience, bad signature. */
export class TokenVerificationError extends Error {
  constructor(reason) {
    super(`token rejected: ${reason}`)
    this.name = 'TokenVerificationError'
    this.reason = reason
  }
}

/**
 * Verifies a Keycloak access token server-side (T043): signature against
 * the realm's JWKS, issuer, audience, and expiry. No library holds this —
 * `jose` is not a dependency of this repo and installing one is outside
 * this task's mandate ("never run npm install") — so this is ~60 lines of
 * `node:crypto`, which already does the one hard part (RSA signature
 * verification, including turning a JWK straight into a usable key via
 * `format: 'jwk'`, no PEM conversion needed).
 *
 * The JWKS is fetched once and cached for `cacheTtlMs` (never per request —
 * that would mean a network round trip to Keycloak on every `/api/*` call).
 * A token naming an unrecognized `kid` triggers exactly one forced refetch
 * (Keycloak key rotation), not a hot loop: a `kid` still unknown after that
 * is rejected.
 */
export function createTokenVerifier({ issuer, audience, jwksUri, fetchImpl = fetch, cacheTtlMs = 10 * 60_000, now = () => Date.now() }) {
  let cache = null // { keys: Map<kid, KeyObject>, fetchedAt }

  async function loadKeys({ forceRefresh = false } = {}) {
    if (!forceRefresh && cache && now() - cache.fetchedAt < cacheTtlMs) return cache.keys

    const res = await fetchImpl(jwksUri)
    if (!res.ok) throw new TokenVerificationError('jwks-unavailable')
    const body = await res.json()

    const keys = new Map()
    for (const jwk of body.keys ?? []) {
      if (jwk.use && jwk.use !== 'sig') continue
      if (jwk.kty !== 'RSA') continue
      try {
        keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }))
      } catch {
        // An unusable key entry is skipped, not fatal to the whole fetch.
      }
    }
    cache = { keys, fetchedAt: now() }
    return keys
  }

  return {
    async verify(token) {
      const parts = typeof token === 'string' ? token.split('.') : []
      if (parts.length !== 3) throw new TokenVerificationError('malformed')
      const [headerB64, payloadB64, sigB64] = parts

      let header, payload
      try {
        header = JSON.parse(base64urlDecode(headerB64).toString('utf8'))
        payload = JSON.parse(base64urlDecode(payloadB64).toString('utf8'))
      } catch {
        throw new TokenVerificationError('malformed')
      }

      // Rejects `alg: "none"` and anything but RS256 outright — no key
      // lookup, no network call, for a token that was never going to verify.
      if (header.alg !== 'RS256') throw new TokenVerificationError('unsigned-or-unsupported-alg')

      let keys = await loadKeys()
      let key = keys.get(header.kid)
      if (!key) {
        keys = await loadKeys({ forceRefresh: true })
        key = keys.get(header.kid)
      }
      if (!key) throw new TokenVerificationError('unknown-key')

      const signingInput = Buffer.from(`${headerB64}.${payloadB64}`)
      const signature = base64urlDecode(sigB64)
      if (!cryptoVerify('RSA-SHA256', signingInput, key, signature)) {
        throw new TokenVerificationError('bad-signature')
      }

      const nowSec = Math.floor(now() / 1000)
      if (typeof payload.exp !== 'number' || payload.exp <= nowSec) throw new TokenVerificationError('expired')
      if (payload.iss !== issuer) throw new TokenVerificationError('wrong-issuer')

      const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
      if (!aud.includes(audience)) throw new TokenVerificationError('wrong-audience')

      return payload
    },
  }
}

function base64urlDecode(segment) {
  return Buffer.from(segment, 'base64url')
}
