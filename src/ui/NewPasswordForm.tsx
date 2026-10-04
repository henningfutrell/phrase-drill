import { useState } from 'react'
import type { PasswordChangeResult } from '../adapters/auth/session-auth'
import '../styles/tokens.css'
import './LoginScreen.css'

const ERROR_COPY: Record<Exclude<PasswordChangeResult, { ok: true }>['reason'] | 'mismatch', string> = {
  mismatch: "The two passwords don't match — type them again.",
  'weak-password': 'That password is too short or too simple — try a longer one.',
  'same-password': "That's the password you already have — choose a different one.",
  'signed-out': 'You were signed out — sign in again, then change it.',
  network: "That didn't work — check the connection and try again.",
}

/**
 * Choose a new password: typed twice, because a typo here locks them out.
 * Settings → Password. Both
 * fields are `new-password`, which is what makes iOS Safari offer to save it;
 * `email`, when known, rides along in a hidden `username` field so the saved
 * password is filed under their address. Presentational — `onChangePassword` is
 * the composition root's call into `session-auth.ts`.
 */
export function NewPasswordForm({
  onChangePassword,
  onChanged,
  email,
  submitLabel = 'Save new password',
}: {
  onChangePassword: (password: string) => Promise<PasswordChangeResult>
  onChanged: () => void
  email?: string
  submitLabel?: string
}) {
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting || password.length === 0) return
    if (password !== again) {
      setError(ERROR_COPY.mismatch)
      return
    }
    setSubmitting(true)
    setError(null)
    const result = await onChangePassword(password)
    setSubmitting(false)
    if (result.ok) {
      onChanged()
      return
    }
    setError(ERROR_COPY[result.reason])
  }

  return (
    <form className="login-card" onSubmit={handleSubmit}>
      {email ? (
        <input type="text" autoComplete="username" value={email} readOnly hidden aria-hidden="true" />
      ) : null}
      <label className="login-field">
        <span className="login-label">New password</span>
        <input
          className="login-input"
          data-testid="new-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <label className="login-field">
        <span className="login-label">Type it again</span>
        <input
          className="login-input"
          data-testid="new-password-again"
          type="password"
          autoComplete="new-password"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
        />
      </label>
      {error ? (
        <p className="login-error" data-testid="new-password-error">
          {error}
        </p>
      ) : null}
      <button className="btn-primary login-submit" data-testid="new-password-submit" type="submit" disabled={submitting}>
        {submitLabel}
      </button>
    </form>
  )
}
