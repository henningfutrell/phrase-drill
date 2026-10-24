/**
 * The `setUserPassword` port `POST /api/password` consumes: sets a password
 * on one Supabase Auth account through the admin API (the server's secret
 * key). Only called after `password-policy.js` accepted the password.
 *
 * `(userId, password)` → `{ ok: true } | { ok: false, reason: 'same-password' | 'weak-password' | 'upstream' }`.
 * Supabase's own error text is not passed on: it is not hers to read.
 */
export function createAccountPasswordSetter(supabase) {
  return async function setUserPassword(userId, password) {
    try {
      const { error } = await supabase.auth.admin.updateUserById(userId, { password })
      if (!error) return { ok: true }
      if (error.code === 'same_password') return { ok: false, reason: 'same-password' }
      if (error.code === 'weak_password') return { ok: false, reason: 'weak-password' }
      return { ok: false, reason: 'upstream' }
    } catch {
      return { ok: false, reason: 'upstream' }
    }
  }
}
