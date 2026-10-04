import { useState } from 'react'
import type { LoginResult } from '../adapters/auth/session-auth'
import '../styles/tokens.css'
import './LoginScreen.css'

const ERROR_COPY = "That didn't work — check the email and password and try again."

/**
 * The one screen a device sees before it's signed in: email and password.
 * `autoComplete="username"` on the email field is what iOS Safari keys its
 * saved-password offer on. Purely presentational
 * — `onLogin` is the composition root's (`main.tsx`) call into
 * `session-auth.ts`; this component only describes the form and shows what
 * it resolved to, same split as every other screen (`AGENTS.md`).
 */
export function LoginScreen({ onLogin }: { onLogin: (email: string, password: string) => Promise<LoginResult> }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError(false)
    const result = await onLogin(email, password)
    if (result.ok) return // composition root swaps this screen out for the app
    setError(true)
    setSubmitting(false)
  }

  return (
    <main className="login-screen lace-veil">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="login-crest">
          <h1 className="login-title">Log in</h1>
        </div>
        <label className="login-field">
          <span className="login-label">Email</span>
          <input
            className="login-input"
            data-testid="login-email"
            type="email"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="login-field">
          <span className="login-label">Password</span>
          <input
            className="login-input"
            data-testid="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error ? (
          <p className="login-error" data-testid="login-error">
            {ERROR_COPY}
          </p>
        ) : null}
        <button className="btn-primary login-submit" data-testid="login-submit" type="submit" disabled={submitting}>
          Log in
        </button>
      </form>
    </main>
  )
}
