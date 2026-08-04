import type { ReactElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoginScreen } from './LoginScreen'

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

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function submit() {
  const form = container.querySelector('form')
  if (!form) throw new Error('form not found')
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('LoginScreen', () => {
  it('offers a username and password field and a submit control', () => {
    render(<LoginScreen onLogin={vi.fn()} />)
    expect(container.querySelector('[data-testid="login-username"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="login-password"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="login-submit"]')).not.toBeNull()
  })

  it('calls onLogin with the entered username and password on submit', async () => {
    const onLogin = vi.fn().mockResolvedValue({ ok: true })
    render(<LoginScreen onLogin={onLogin} />)

    typeInto(container.querySelector('[data-testid="login-username"]') as HTMLInputElement, 'her')
    typeInto(container.querySelector('[data-testid="login-password"]') as HTMLInputElement, 'correct-password')
    submit()
    await flush()

    expect(onLogin).toHaveBeenCalledWith('her', 'correct-password')
  })

  it('shows a calm error message and never the raw reason code when login fails', async () => {
    const onLogin = vi.fn().mockResolvedValue({ ok: false, reason: 'invalid-credentials' })
    render(<LoginScreen onLogin={onLogin} />)

    typeInto(container.querySelector('[data-testid="login-username"]') as HTMLInputElement, 'her')
    typeInto(container.querySelector('[data-testid="login-password"]') as HTMLInputElement, 'wrong-password')
    submit()
    await flush()

    const message = container.querySelector('[data-testid="login-error"]')
    expect(message).not.toBeNull()
    expect(message!.textContent).not.toContain('invalid-credentials')
  })

  it('disables the submit control while a login attempt is in flight', async () => {
    let resolveLogin!: (v: { ok: true }) => void
    const pending = new Promise<{ ok: true }>((resolve) => {
      resolveLogin = resolve
    })
    const onLogin = vi.fn().mockReturnValue(pending)
    render(<LoginScreen onLogin={onLogin} />)

    typeInto(container.querySelector('[data-testid="login-username"]') as HTMLInputElement, 'her')
    typeInto(container.querySelector('[data-testid="login-password"]') as HTMLInputElement, 'correct-password')
    submit()
    await flush()

    const submitButton = container.querySelector('[data-testid="login-submit"]') as HTMLButtonElement
    expect(submitButton.disabled).toBe(true)

    await act(async () => {
      resolveLogin({ ok: true })
      await Promise.resolve()
    })
  })

  it('does not call onLogin again while a submit is already pending', async () => {
    let resolveLogin!: (v: { ok: true }) => void
    const pending = new Promise<{ ok: true }>((resolve) => {
      resolveLogin = resolve
    })
    const onLogin = vi.fn().mockReturnValue(pending)
    render(<LoginScreen onLogin={onLogin} />)

    typeInto(container.querySelector('[data-testid="login-username"]') as HTMLInputElement, 'her')
    typeInto(container.querySelector('[data-testid="login-password"]') as HTMLInputElement, 'correct-password')
    submit()
    submit()
    await flush()

    expect(onLogin).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolveLogin({ ok: true })
      await Promise.resolve()
    })
  })
})
