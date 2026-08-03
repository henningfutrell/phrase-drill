/**
 * The library key is the whole identity model (T041): high-entropy random,
 * generated on the device, no accounts, no passwords, no email. The device
 * generates it as 32 random bytes, hex-encoded — 256 bits of entropy, 64
 * lowercase hex characters. This module only validates the *shape*; it never
 * decides whether a key is "known" (the library store does that, implicitly,
 * by having no row yet vs. having one).
 */
const KEY_PATTERN = /^[0-9a-f]{64}$/

export function isValidLibraryKey(key) {
  return typeof key === 'string' && KEY_PATTERN.test(key)
}

/** Extracts the bearer token from `Authorization: Bearer <token>`, or `null`. */
export function getBearerToken(req) {
  const header = req.headers['authorization']
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token.length === 0 ? null : token
}
