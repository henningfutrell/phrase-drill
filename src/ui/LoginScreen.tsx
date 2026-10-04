import { useRef, useState } from 'react'
import type { SessionAuth } from '../adapters/auth/session-auth'
import { NewPasswordForm } from './NewPasswordForm'
import '../styles/tokens.css'
import './LoginScreen.css'

/** The slice of `session-auth.ts` this screen drives. */
export type SignInPort = Pick<
  SessionAuth,
  'login' | 'requestSignInCode' | 'verifySignInCode' | 'requestPasswordReset' | 'verifyResetCode' | 'changePassword'
>

type Step = 'email' | 'code' | 'password' | 'reset-code' | 'new-password'

const ERROR_COPY = {
  'unknown-email': "That email isn't set up for phrase-drill — check the spelling.",
  'invalid-code': "That code didn't work — check it, or send a new one.",
  'invalid-credentials': "That didn't work — check the email and password and try again.",
  'rate-limited': 'Too many tries just now — wait a few minutes and try again.',
  network: "That didn't work — check the connection and try again.",
  'no-email': 'Type your email first, then tap Forgot password.',
} as const

type ErrorKey = keyof typeof ERROR_COPY

/**
 * The screen a device sees before it's signed in. The everyday way in is a
 * 6-digit code emailed to them and typed here — never a link: a link from Mail
 * opens in Safari, not in the home-screen app, whose storage is separate.
 * Password sign-in stays as the backup, with a forgotten password reset by the
 * same kind of emailed code. `autoComplete="username"` on the email is what
 * Safari keys its saved address on, and `one-time-code` on the code is what
 * lets iOS offer the code straight from Mail.
 *
 * Presentational: `auth` is the composition root's (`main.tsx`) session-auth,
 * and `onSignedIn` swaps this screen for the app.
 */
export function LoginScreen({ auth, onSignedIn }: { auth: SignInPort; onSignedIn: () => void }) {
  const [step, setStep] = useState<Step>('email')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<ErrorKey | null>(null)
  // State lags a double tap within one frame; the ref does not.
  const inFlight = useRef(false)

  /** Runs one auth call with the form locked; on `ok`, `next` runs. */
  async function run(call: () => Promise<{ ok: true } | { ok: false; reason: ErrorKey }>, next: () => void) {
    if (inFlight.current) return
    inFlight.current = true
    setSubmitting(true)
    setError(null)
    const result = await call()
    inFlight.current = false
    setSubmitting(false)
    if (result.ok) next()
    else setError(result.reason)
  }

  function goTo(nextStep: Step) {
    setStep(nextStep)
    setError(null)
    setCode('')
  }

  function sendSignInCode() {
    return run(() => auth.requestSignInCode(email), () => goTo('code'))
  }

  function sendResetCode() {
    if (email.trim().length === 0) {
      setError('no-email')
      return
    }
    return run(() => auth.requestPasswordReset(email), () => goTo('reset-code'))
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (step === 'email') void sendSignInCode()
    if (step === 'code') void run(() => auth.verifySignInCode(email, code), onSignedIn)
    if (step === 'password') void run(() => auth.login(email, password), onSignedIn)
    if (step === 'reset-code') void run(() => auth.verifyResetCode(email, code), () => goTo('new-password'))
  }

  const errorLine = error ? (
    <p className="login-error" data-testid="login-error">
      {ERROR_COPY[error]}
    </p>
  ) : null

  if (step === 'new-password') {
    return (
      <main className="login-screen lace-veil">
        <Crest title="New password" />
        <NewPasswordForm email={email} onChangePassword={auth.changePassword} onChanged={onSignedIn} />
      </main>
    )
  }

  const awaitingCode = step === 'code' || step === 'reset-code'

  return (
    <main className="login-screen lace-veil">
      <form className="login-card" onSubmit={handleSubmit}>
        <Crest title={awaitingCode ? 'Check your email' : 'Log in'} />

        {awaitingCode ? (
          <>
            <p className="login-note" data-testid="login-code-sent">
              We sent a 6-digit code to <strong>{email.trim()}</strong>.
            </p>
            <label className="login-field">
              <span className="login-label">Code</span>
              <input
                className="login-input login-input--code"
                data-testid="login-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
          </>
        ) : (
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
        )}

        {step === 'password' ? (
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
        ) : null}

        {errorLine}

        <button className="btn-primary login-submit" data-testid="login-submit" type="submit" disabled={submitting}>
          {step === 'email' ? 'Email me a code' : awaitingCode ? 'Continue' : 'Log in'}
        </button>

        <div className="login-alternatives">
          {step === 'email' ? (
            <AltAction testId="login-use-password" onClick={() => goTo('password')}>
              Use my password instead
            </AltAction>
          ) : null}
          {step === 'password' ? (
            <>
              <AltAction testId="login-forgot" onClick={() => void sendResetCode()} disabled={submitting}>
                Forgot password?
              </AltAction>
              <AltAction testId="login-use-code" onClick={() => goTo('email')}>
                Email me a code instead
              </AltAction>
            </>
          ) : null}
          {awaitingCode ? (
            <>
              <AltAction
                testId="login-resend"
                disabled={submitting}
                onClick={() => void (step === 'code' ? sendSignInCode() : sendResetCode())}
              >
                Send a new code
              </AltAction>
              <AltAction testId="login-change-email" onClick={() => goTo(step === 'code' ? 'email' : 'password')}>
                Use a different email
              </AltAction>
            </>
          ) : null}
        </div>
      </form>
    </main>
  )
}

function Crest({ title }: { title: string }) {
  return (
    <div className="login-crest">
      <h1 className="login-title">{title}</h1>
    </div>
  )
}

function AltAction({
  testId,
  onClick,
  disabled,
  children,
}: {
  testId: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button type="button" className="link-action" data-testid={testId} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  )
}
