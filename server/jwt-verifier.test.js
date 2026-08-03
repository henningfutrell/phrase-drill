// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { createTokenVerifier } from './jwt-verifier.js'

const ISSUER = 'http://localhost:8081/realms/phrase-drill'
const AUDIENCE = 'phrase-drill-app'
const JWKS_URI = 'http://keycloak:8080/realms/phrase-drill/protocol/openid-connect/certs'

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const KID = 'test-key-1'
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256', kty: 'RSA' }

function base64url(input) {
  return Buffer.from(input).toString('base64url')
}

/** Signs a real RS256 JWT against the test keypair, so verification exercises the real algorithm. */
function makeToken(payloadOverrides = {}, { kid = KID, alg = 'RS256' } = {}) {
  const header = { alg, typ: 'JWT', kid }
  const payload = {
    sub: 'a1b2c3d4-user-sub',
    iss: ISSUER,
    aud: AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + 300,
    iat: Math.floor(Date.now() / 1000),
    ...payloadOverrides,
  }
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
  const signature = cryptoSign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url')
  return `${signingInput}.${signature}`
}

function fetchServing(jwks) {
  const calls = []
  const fetchImpl = vi.fn(async (url) => {
    calls.push(url)
    return { ok: true, json: async () => jwks }
  })
  fetchImpl.calls = calls
  return fetchImpl
}

function verifier(overrides = {}) {
  return createTokenVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUri: JWKS_URI,
    fetchImpl: fetchServing({ keys: [JWK] }),
    ...overrides,
  })
}

describe('createTokenVerifier', () => {
  it('accepts a validly signed, current, correctly-issued and -audienced token', async () => {
    const v = verifier()
    const claims = await v.verify(makeToken())
    expect(claims.sub).toBe('a1b2c3d4-user-sub')
  })

  it('rejects an unsigned token (alg: none)', async () => {
    const v = verifier()
    const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))
    const payload = base64url(JSON.stringify({ sub: 'x', iss: ISSUER, aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 300 }))
    const unsignedToken = `${header}.${payload}.`
    await expect(v.verify(unsignedToken)).rejects.toThrow()
  })

  it('rejects a token whose signature does not verify against the JWKS (forged/tampered)', async () => {
    const v = verifier()
    const token = makeToken()
    const tampered = token.slice(0, -4) + 'AAAA'
    await expect(v.verify(tampered)).rejects.toThrow()
  })

  it('rejects an expired token', async () => {
    const v = verifier()
    const expired = makeToken({ exp: Math.floor(Date.now() / 1000) - 60 })
    await expect(v.verify(expired)).rejects.toThrow()
  })

  it('rejects a token from the wrong issuer', async () => {
    const v = verifier()
    const wrongIssuer = makeToken({ iss: 'http://evil.example/realms/other' })
    await expect(v.verify(wrongIssuer)).rejects.toThrow()
  })

  it('rejects a token with the wrong audience', async () => {
    const v = verifier()
    const wrongAudience = makeToken({ aud: 'some-other-client' })
    await expect(v.verify(wrongAudience)).rejects.toThrow()
  })

  it('accepts an audience presented as an array, as Keycloak sends when a token has several', async () => {
    const v = verifier()
    const token = makeToken({ aud: ['phrase-drill-app', 'account'] })
    await expect(v.verify(token)).resolves.toMatchObject({ sub: expect.any(String) })
  })

  it('caches the JWKS instead of fetching it on every verification', async () => {
    const fetchImpl = fetchServing({ keys: [JWK] })
    const v = createTokenVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUri: JWKS_URI, fetchImpl })

    await v.verify(makeToken())
    await v.verify(makeToken())
    await v.verify(makeToken())

    expect(fetchImpl.calls.length).toBe(1)
  })

  it('refetches the JWKS once when a token names an unknown kid (key rotation), and rejects if still unknown', async () => {
    const fetchImpl = fetchServing({ keys: [JWK] })
    const v = createTokenVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUri: JWKS_URI, fetchImpl })

    const rotatedToken = makeToken({}, { kid: 'a-kid-not-in-the-jwks' })
    await expect(v.verify(rotatedToken)).rejects.toThrow()
    expect(fetchImpl.calls.length).toBe(2) // one normal load, one forced refresh on the unknown kid
  })

  it('rejects a malformed (non-JWT) token outright, with no network call', async () => {
    const fetchImpl = fetchServing({ keys: [JWK] })
    const v = createTokenVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUri: JWKS_URI, fetchImpl })

    await expect(v.verify('not-a-jwt')).rejects.toThrow()
    expect(fetchImpl.calls.length).toBe(0)
  })
})
