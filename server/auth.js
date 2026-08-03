/**
 * Bearer-token extraction only (T043). Identity itself — deciding whether a
 * token is genuine, current, and hers — is `server/jwt-verifier.js`'s job,
 * against Keycloak's JWKS. This module used to also validate the shape of
 * the old 64-hex device-generated library key; that identity model is gone
 * (deleted, not deprecated — repo doctrine) along with every caller of it.
 */

/** Extracts the bearer token from `Authorization: Bearer <token>`, or `null`. */
export function getBearerToken(req) {
  const header = req.headers['authorization']
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token.length === 0 ? null : token
}
