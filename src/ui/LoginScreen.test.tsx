import type { ReactElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginScreen, type SignInPort } from './LoginScreen'

let container: HTMLDivElement
let root: Root

function render(ui: ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(ui)
  })
}

function byId(testId: string): HTMLElement {
  const el = container.querySelector(`[data-testid="${testId}"]`)
  if (!el) throw new Error(`${testId} not found in: ${container.innerHTML}`)
  return el as HTMLElement
}

function typeInto(testId: string, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(byId(testId), value)
  byId(testId).dispatchEvent(new Event('input', { bubbles: true }))
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve()
  })
}

async function submit(): Promise<void> {
  act(() => {
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await flush()
}

async function tap(testId: string): Promise<void> {
  act(() => {
    byId(testId).click()
  })
  await flush()
}

function fakeAuth(): { [K in keyof SignInPort]: ReturnType<typeof vi.fn> } & SignInPort {
  return {
    login: vi.fn().mockResolvedValue({ ok: true }),
    requestSignInCode: vi.fn().mockResolvedValue({ ok: true }),
    verifySignInCode: vi.fn().mockResolvedValue({ ok: true }),
    requestPasswordReset: vi.fn().mockResolvedValue({ ok: true }),
    verifyResetCode: vi.fn().mockResolvedValue({ ok: true }),
    changePassword: vi.fn().mockResolvedValue({ ok: true }),
  }
}

let auth: ReturnType<typeof fakeAuth>
let onSignedIn: ReturnType<typeof vi.fn<() => void>>

beforeEach(() => {
  auth = fakeAuth()
  onSignedIn = vi.fn()
  render(<LoginScreen auth={auth} onSignedIn={onSignedIn} />)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('LoginScreen — sign in with an emailed code', () => {
  it('asks only for their email first, in a field Safari fills from their saved address', () => {
    const email = byId('login-email') as HTMLInputElement
    expect(email.type).toBe('email')
    expect(email.autocomplete).toBe('username')
    expect(container.querySelector('[data-testid="login-password"]')).toBeNull()
    expect(byId('login-submit').textContent).toBe('Email me a code')
  })

  it('emails a code, then asks for it, naming where it went', async () => {
    typeInto('login-email', 'user@example.com')
    await submit()

    expect(auth.requestSignInCode).toHaveBeenCalledWith('user@example.com')
    expect(byId('login-code-sent').textContent).toContain('user@example.com')
    const code = byId('login-code') as HTMLInputElement
    expect(code.autocomplete).toBe('one-time-code')
    expect(code.inputMode).toBe('numeric')
  })

  it('signs them in with the right code', async () => {
    typeInto('login-email', 'user@example.com')
    await submit()
    typeInto('login-code', '123456')
    await submit()

    expect(auth.verifySignInCode).toHaveBeenCalledWith('user@example.com', '123456')
    expect(onSignedIn).toHaveBeenCalledTimes(1)
  })

  it('says a wrong code did not work, and can send a new one', async () => {
    auth.verifySignInCode.mockResolvedValue({ ok: false, reason: 'invalid-code' })
    typeInto('login-email', 'user@example.com')
    await submit()
    typeInto('login-code', '000000')
    await submit()

    expect(onSignedIn).not.toHaveBeenCalled()
    expect(byId('login-error').textContent).toContain('code')
    await tap('login-resend')
    expect(auth.requestSignInCode).toHaveBeenCalledTimes(2)
  })

  it('says plainly when the address has no account, and stays on the email step', async () => {
    auth.requestSignInCode.mockResolvedValue({ ok: false, reason: 'unknown-email' })
    typeInto('login-email', 'nobody@example.com')
    await submit()

    expect(byId('login-error').textContent).toContain("isn't set up")
    expect(container.querySelector('[data-testid="login-code"]')).toBeNull()
  })

  it('asks them to wait when too many emails were sent', async () => {
    auth.requestSignInCode.mockResolvedValue({ ok: false, reason: 'rate-limited' })
    typeInto('login-email', 'user@example.com')
    await submit()
    expect(byId('login-error').textContent).toContain('wait a few minutes')
  })

  it('goes back to change the email', async () => {
    typeInto('login-email', 'user@example.com')
    await submit()
    await tap('login-change-email')
    expect((byId('login-email') as HTMLInputElement).value).toBe('user@example.com')
  })

  it('sends one email per tap, however fast the user taps', async () => {
    let resolve!: (v: { ok: true }) => void
    auth.requestSignInCode.mockReturnValue(new Promise((r) => (resolve = r)))
    typeInto('login-email', 'user@example.com')
    act(() => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await flush()
    expect((byId('login-submit') as HTMLButtonElement).disabled).toBe(true)
    expect(auth.requestSignInCode).toHaveBeenCalledTimes(1)
    await act(async () => resolve({ ok: true }))
  })
})

describe('LoginScreen — password, the backup way in', () => {
  async function toPassword() {
    typeInto('login-email', 'user@example.com')
    await tap('login-use-password')
  }

  it('keeps the email and signs in with the password', async () => {
    await toPassword()
    expect((byId('login-email') as HTMLInputElement).value).toBe('user@example.com')
    expect((byId('login-password') as HTMLInputElement).autocomplete).toBe('current-password')
    typeInto('login-password', 'correct-password')
    await submit()

    expect(auth.login).toHaveBeenCalledWith('user@example.com', 'correct-password')
    expect(onSignedIn).toHaveBeenCalledTimes(1)
  })

  it('names the email and password, never the raw reason, when they are refused', async () => {
    auth.login.mockResolvedValue({ ok: false, reason: 'invalid-credentials' })
    await toPassword()
    typeInto('login-password', 'wrong')
    await submit()

    const error = byId('login-error').textContent
    expect(error).toContain('email and password')
    expect(error).not.toContain('invalid-credentials')
    expect(onSignedIn).not.toHaveBeenCalled()
  })

  it('goes back to the code way in', async () => {
    await toPassword()
    await tap('login-use-code')
    expect(container.querySelector('[data-testid="login-password"]')).toBeNull()
  })
})

describe('LoginScreen — forgot password', () => {
  it('resets it with an emailed code and a new password, then signs them in', async () => {
    typeInto('login-email', 'user@example.com')
    await tap('login-use-password')
    await tap('login-forgot')

    expect(auth.requestPasswordReset).toHaveBeenCalledWith('user@example.com')
    expect(byId('login-code-sent').textContent).toContain('user@example.com')
    typeInto('login-code', '424242')
    await submit()
    expect(auth.verifyResetCode).toHaveBeenCalledWith('user@example.com', '424242')

    typeInto('new-password', 'a-long-new-one')
    typeInto('new-password-again', 'a-long-new-one')
    await submit()
    expect(auth.changePassword).toHaveBeenCalledWith('a-long-new-one')
    expect(onSignedIn).toHaveBeenCalledTimes(1)
  })

  it('needs an email before it can send the reset code', async () => {
    await tap('login-use-password')
    await tap('login-forgot')
    expect(auth.requestPasswordReset).not.toHaveBeenCalled()
    expect(byId('login-error').textContent).toContain('email')
  })

  it('says a wrong reset code did not work, and does not ask for a new password', async () => {
    auth.verifyResetCode.mockResolvedValue({ ok: false, reason: 'invalid-code' })
    typeInto('login-email', 'user@example.com')
    await tap('login-use-password')
    await tap('login-forgot')
    typeInto('login-code', '000000')
    await submit()

    expect(byId('login-error').textContent).toContain('code')
    expect(container.querySelector('[data-testid="new-password"]')).toBeNull()
  })
})
