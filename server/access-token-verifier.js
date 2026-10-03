/**
 * The `verifyAccessToken` port the router consumes: a Supabase access token in,
 * `{ sub }` (the Supabase user id, which is her library key) or `null` out.
 * `getClaims` checks the signature (JWKS in production, the shared secret
 * locally) and the expiry; anything it refuses, and any failure to ask, is
 * `null` — the router answers 401 either way.
 */
export function createAccessTokenVerifier(supabase) {
  return async function verifyAccessToken(token) {
    try {
      const { data, error } = await supabase.auth.getClaims(token)
      const sub = data?.claims?.sub
      if (error || typeof sub !== 'string' || sub.length === 0) return null
      return { sub }
    } catch {
      return null
    }
  }
}
