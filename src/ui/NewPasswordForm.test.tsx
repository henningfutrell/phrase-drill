import type { ReactElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewPasswordForm } from './NewPasswordForm'

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

function typeInto(testId: string, value: string): void {
  const input = container.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function submit(): Promise<void> {
  await act(async () => {
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('NewPasswordForm', () => {
  it('sets the password when both fields match, then reports it changed', async () => {
    const onChangePassword = vi.fn().mockResolvedValue({ ok: true })
    const onChanged = vi.fn()
    render(<NewPasswordForm onChangePassword={onChangePassword} onChanged={onChanged} />)

    typeInto('new-password', 'a-long-new-one')
    typeInto('new-password-again', 'a-long-new-one')
    await submit()

    expect(onChangePassword).toHaveBeenCalledWith('a-long-new-one')
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('refuses two different passwords without asking the server', async () => {
    const onChangePassword = vi.fn()
    render(<NewPasswordForm onChangePassword={onChangePassword} onChanged={vi.fn()} />)

    typeInto('new-password', 'a-long-new-one')
    typeInto('new-password-again', 'a-long-new-on')
    await submit()

    expect(onChangePassword).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="new-password-error"]')!.textContent).toContain("don't match")
  })

  it('does nothing with an empty password', async () => {
    const onChangePassword = vi.fn()
    render(<NewPasswordForm onChangePassword={onChangePassword} onChanged={vi.fn()} />)
    await submit()
    expect(onChangePassword).not.toHaveBeenCalled()
  })

  it.each([
    ['weak-password', 'longer'],
    ['same-password', 'already have'],
    ['signed-out', 'signed out'],
    ['network', 'connection'],
  ])('names a %s refusal in plain words and stays open', async (reason, words) => {
    const onChanged = vi.fn()
    render(<NewPasswordForm onChangePassword={vi.fn().mockResolvedValue({ ok: false, reason })} onChanged={onChanged} />)

    typeInto('new-password', 'abc')
    typeInto('new-password-again', 'abc')
    await submit()

    const error = container.querySelector('[data-testid="new-password-error"]')!.textContent
    expect(error).toContain(words)
    expect(error).not.toContain(reason)
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('marks both fields as a new password, so Safari offers to save it', () => {
    render(<NewPasswordForm onChangePassword={vi.fn()} onChanged={vi.fn()} email="user@example.com" />)
    for (const id of ['new-password', 'new-password-again']) {
      const input = container.querySelector(`[data-testid="${id}"]`) as HTMLInputElement
      expect(input.type).toBe('password')
      expect(input.autocomplete).toBe('new-password')
    }
    const username = container.querySelector('input[autocomplete="username"]') as HTMLInputElement
    expect(username.value).toBe('user@example.com')
  })
})
