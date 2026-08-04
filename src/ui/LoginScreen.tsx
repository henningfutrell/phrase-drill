import { useState } from 'react'
import type { LoginResult } from '../adapters/auth/session-auth'

const ERROR_COPY = "That didn't work — check the username and password and try again."

/**
 * The one screen a device sees before it's signed in (T050), replacing the
 * full-page redirect to Keycloak's hosted login page. Purely presentational
 * — `onLogin` is the composition root's (`main.tsx`) call into
 * `session-auth.ts`; this component only describes the form and shows what
 * it resolved to, same split as every other screen (`AGENTS.md`).
 */
export function LoginScreen({ onLogin }: { onLogin: (username: string, password: string) => Promise<LoginResult> }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError(false)
    const result = await onLogin(username, password)
    if (result.ok) return // composition root swaps this screen out for the app
    setError(true)
    setSubmitting(false)
  }

  return (
    <form onSubmit={handleSubmit}>
      <h1>Log in</h1>
      <label>
        Username
        <input
          data-testid="login-username"
          type="text"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </label>
      <label>
        Password
        <input
          data-testid="login-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {error ? <p data-testid="login-error">{ERROR_COPY}</p> : null}
      <button data-testid="login-submit" type="submit" disabled={submitting}>
        Log in
      </button>
    </form>
  )
}
