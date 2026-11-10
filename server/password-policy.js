import { createHash } from 'node:crypto'

/**
 * The one check every new password passes before it is set: the server's
 * `POST /api/password`, and the operator's `auth-user-create.mjs` and
 * `auth-password-set.mjs`.
 *
 * Two parts, in order:
 *
 * 1. **The rules** the Supabase project also holds (workflow issue #35): at
 *    least 12 characters, at least one letter, at least one digit. "Letter"
 *    and "digit" are ASCII, the same character groups Supabase's
 *    `password_required_characters` is set to, so a password this accepts is
 *    one Supabase accepts too.
 * 2. **HaveIBeenPwned's Pwned Passwords range API.** Supabase's own
 *    leaked-password check is a Pro-plan feature and the project is on Free,
 *    so this is it. k-anonymity: the password is SHA-1'd here and only the
 *    first 5 hex characters leave the process; the suffixes that come back
 *    are compared locally. `Add-Padding: true` makes HIBP pad every answer
 *    with fake suffixes at count 0, so the answer's size says nothing about
 *    the prefix — those lines are ignored.
 *
 * **Fails closed.** HIBP unreachable, a non-2xx, a body that will not read,
 * or no answer within `timeoutMs`: the password is refused as `unverified`,
 * never accepted unchecked. A password change can wait; a breached password
 * set because a third party was down cannot be noticed afterwards.
 *
 * Nothing here logs. The password and its full hash never reach a log line,
 * an error message, or a request.
 *
 * Written here rather than taken from the `hibp` package: it is one hash,
 * one GET and a line split, and owning the timeout and fail-closed behaviour
 * directly costs less than a dependency to wrap.
 */

export const PASSWORD_MIN_LENGTH = 12
export const PWNED_RANGE_URL = 'https://api.pwnedpasswords.com/range/'
/** Long enough for a slow HIBP edge; short enough that the form answers before she gives up on it. */
export const PWNED_TIMEOUT_MS = 5_000

/** The rule `password` breaks, or `null`. */
function brokenRule(password) {
  if (typeof password !== 'string' || [...password].length < PASSWORD_MIN_LENGTH) return 'too-short'
  if (!/[A-Za-z]/.test(password)) return 'no-letter'
  if (!/[0-9]/.test(password)) return 'no-digit'
  return null
}

/** Whether HIBP has seen `password`. Throws when it cannot say. */
async function isPwned(password, { fetchImpl, timeoutMs }) {
  const hash = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase()
  const prefix = hash.slice(0, 5)
  const suffix = hash.slice(5)
  const res = await fetchImpl(PWNED_RANGE_URL + prefix, {
    headers: { 'add-padding': 'true' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`pwned passwords range answered ${res.status}`)
  for (const line of (await res.text()).split('\n')) {
    const [candidate, count] = line.trim().split(':')
    if (candidate?.toUpperCase() === suffix && Number(count) > 0) return true
  }
  return false
}

/**
 * `checkPassword(password)` →
 * `{ ok: true } | { ok: false, reason: 'too-short' | 'no-letter' | 'no-digit' | 'breached' | 'unverified' }`.
 * `fetchImpl` is the seam to HIBP; tests fake it.
 */
export function createPasswordPolicy({ fetchImpl = fetch, timeoutMs = PWNED_TIMEOUT_MS } = {}) {
  return async function checkPassword(password) {
    const rule = brokenRule(password)
    if (rule) return { ok: false, reason: rule }
    try {
      return (await isPwned(password, { fetchImpl, timeoutMs })) ? { ok: false, reason: 'breached' } : { ok: true }
    } catch {
      return { ok: false, reason: 'unverified' }
    }
  }
}

/** The operator's words for a refusal — the two scripts print this. */
export function describeRefusal(reason) {
  switch (reason) {
    case 'too-short':
      return `password refused: shorter than ${PASSWORD_MIN_LENGTH} characters`
    case 'no-letter':
      return 'password refused: it needs at least one letter (a-z or A-Z)'
    case 'no-digit':
      return 'password refused: it needs at least one digit (0-9)'
    case 'breached':
      return 'password refused: it is in a known data breach (HaveIBeenPwned); choose another'
    case 'unverified':
      return "password refused: couldn't verify password safety (HaveIBeenPwned unreachable), try again"
    default:
      return `password refused: ${reason}`
  }
}
