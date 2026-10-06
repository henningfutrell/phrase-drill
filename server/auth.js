/** Bearer-token extraction only. Verifying the token is the `verifyAccessToken` port (`server/access-token-verifier.js`). */

/** Extracts the bearer token from `Authorization: Bearer <token>`, or `null`. */
export function getBearerToken(req) {
  const header = req.headers['authorization']
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token.length === 0 ? null : token
}
