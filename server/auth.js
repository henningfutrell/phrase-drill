/**
 * Bearer-token extraction only. Identity itself — deciding whether a token
 * is genuine, current, and hers — is `server/session-auth.js`'s job,
 * against the `sessions` table (T050; previously Keycloak's JWKS, before
 * that a hand-validated 64-hex device-generated library key). Each earlier
 * identity model is gone entirely (deleted, not deprecated — repo
 * doctrine) along with every caller of it; this module has needed no
 * change across any of them.
 */

/** Extracts the bearer token from `Authorization: Bearer <token>`, or `null`. */
export function getBearerToken(req) {
  const header = req.headers['authorization']
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token.length === 0 ? null : token
}
