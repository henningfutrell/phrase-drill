import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RestoreControl } from './RestoreControl'

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function click(el: Element | null): void {
  ;(el as HTMLElement).click()
}

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

function renderControl(overrides: Partial<Parameters<typeof RestoreControl>[0]> = {}) {
  const props = {
    onRestoreFileChosen: vi.fn().mockResolvedValue({ ok: true }),
    onConfirmRestore: vi.fn(),
    onCancelRestore: vi.fn(),
    ...overrides,
  }
  act(() => {
    root.render(<RestoreControl {...props} />)
  })
  return props
}

/** Drives the hidden file input the way a chosen file would. */
async function chooseFile(text = '{}'): Promise<void> {
  const input = container.querySelector('[data-testid="restore-file-input"]') as HTMLInputElement
  const file = new File([text], 'backup.json', { type: 'application/json' })
  Object.defineProperty(input, 'files', {
    value: { 0: file, length: 1, item: () => file } as unknown as FileList,
    configurable: true,
  })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
  })
}

describe('RestoreControl', () => {
  it('reaches the file picker in one tap, with no intermediate screen', () => {
    renderControl()
    const input = container.querySelector('[data-testid="restore-file-input"]') as HTMLInputElement
    const clicked = vi.spyOn(input, 'click')
    click(container.querySelector('[data-testid="restore-backup"]'))
    expect(clicked).toHaveBeenCalledTimes(1)
  })

  it('names itself in words a person looks for when their phrases are gone', () => {
    renderControl()
    expect(container.querySelector('[data-testid="restore-backup"]')!.textContent).toContain('Restore')
  })

  it('takes a label override, so the panic screen can be blunter than Settings', () => {
    renderControl({ label: 'Restore from a backup file' })
    expect(container.querySelector('[data-testid="restore-backup"]')!.textContent).toBe(
      'Restore from a backup file',
    )
  })

  it('hands the chosen file to the caller and opens the confirmation, replacing nothing yet', async () => {
    const props = renderControl()
    await chooseFile()
    expect(props.onRestoreFileChosen).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="restore-confirm-sheet"]')).not.toBeNull()
    expect(props.onConfirmRestore).not.toHaveBeenCalled()
  })

  it('replaces only when the confirmation is confirmed', async () => {
    const props = renderControl()
    await chooseFile()
    await act(async () => click(container.querySelector('[data-testid="restore-confirm"]')))
    expect(props.onConfirmRestore).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="restore-confirm-sheet"]')).toBeNull()
  })

  it('drops the pending restore when the confirmation is cancelled', async () => {
    const props = renderControl()
    await chooseFile()
    await act(async () => click(container.querySelector('[data-testid="restore-cancel"]')))
    expect(props.onCancelRestore).toHaveBeenCalledTimes(1)
    expect(props.onConfirmRestore).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="restore-confirm-sheet"]')).toBeNull()
  })

  it('refuses a file that is not JSON with plain language, and opens no confirmation', async () => {
    renderControl({ onRestoreFileChosen: vi.fn().mockResolvedValue({ ok: false, reason: 'not-json' }) })
    await chooseFile('not json')
    expect(container.querySelector('[data-testid="restore-error"]')!.textContent).toContain('damaged')
    expect(container.querySelector('[data-testid="restore-confirm-sheet"]')).toBeNull()
  })

  it("refuses another app's JSON by naming the file she should be looking for", async () => {
    renderControl({ onRestoreFileChosen: vi.fn().mockResolvedValue({ ok: false, reason: 'wrong-format' }) })
    await chooseFile()
    expect(container.querySelector('[data-testid="restore-error"]')!.textContent).toContain(
      'phrase-drill backup',
    )
  })

  it('refuses a corrupt backup the same way, never with a raw parse error', async () => {
    renderControl({ onRestoreFileChosen: vi.fn().mockResolvedValue({ ok: false, reason: 'invalid' }) })
    await chooseFile()
    const error = container.querySelector('[data-testid="restore-error"]')!.textContent!
    expect(error).toContain('phrase-drill backup')
    expect(error).not.toContain('SyntaxError')
  })
})
