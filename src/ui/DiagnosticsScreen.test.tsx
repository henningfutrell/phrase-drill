import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiagnosticsScreen } from './DiagnosticsScreen'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function click(el: Element): void {
  ;(el as HTMLElement).click()
}

describe('DiagnosticsScreen', () => {
  it('shows a loading state until the report text is ready', () => {
    act(() => {
      root.render(<DiagnosticsScreen onBack={vi.fn()} reportText={undefined} onCopyReport={vi.fn()} />)
    })
    expect(container.querySelector('[data-testid="diagnostics-loading"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="diagnostics-report"]')).toBeNull()
  })

  it('shows the report text once ready', () => {
    act(() => {
      root.render(
        <DiagnosticsScreen onBack={vi.fn()} reportText="Build: abc1234\nPhrases: 2" onCopyReport={vi.fn()} />,
      )
    })
    expect(container.querySelector('[data-testid="diagnostics-report"]')!.textContent).toContain('abc1234')
  })

  it('calls onBack from the back control', () => {
    const onBack = vi.fn()
    act(() => {
      root.render(<DiagnosticsScreen onBack={onBack} reportText="text" onCopyReport={vi.fn()} />)
    })
    click(container.querySelector('[data-testid="diagnostics-back"]')!)
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('one control copies the whole report as text, and confirms success', async () => {
    const onCopyReport = vi.fn().mockResolvedValue(true)
    await act(async () => {
      root.render(
        <DiagnosticsScreen onBack={vi.fn()} reportText="the whole report" onCopyReport={onCopyReport} />,
      )
    })

    await act(async () => click(container.querySelector('[data-testid="copy-diagnostics-report"]')!))

    expect(onCopyReport).toHaveBeenCalledWith('the whole report')
    expect(container.querySelector('[data-testid="copy-status"]')?.textContent).toMatch(/copied/i)
  })

  it('tells her plainly when copying failed, so she can copy the text herself instead', async () => {
    const onCopyReport = vi.fn().mockResolvedValue(false)
    await act(async () => {
      root.render(
        <DiagnosticsScreen onBack={vi.fn()} reportText="the whole report" onCopyReport={onCopyReport} />,
      )
    })

    await act(async () => click(container.querySelector('[data-testid="copy-diagnostics-report"]')!))

    expect(container.querySelector('[data-testid="copy-status"]')?.textContent).toMatch(/couldn.?t|select/i)
  })

  it('disables the copy control until the report is ready', () => {
    act(() => {
      root.render(<DiagnosticsScreen onBack={vi.fn()} reportText={undefined} onCopyReport={vi.fn()} />)
    })
    expect(container.querySelector('[data-testid="copy-diagnostics-report"]')).toBeNull()
  })
})
