import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackupStatus } from './BackupStatus'
import type { BackupAge } from '../domain'

/** Resolves after a macrotask so a promise-returning handler's `.then` runs before assertions. */
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

function render(age: BackupAge, onExportBackup = vi.fn().mockResolvedValue({ kind: 'shared' })) {
  act(() => {
    root.render(<BackupStatus age={age} onExportBackup={onExportBackup} onCopyText={vi.fn().mockResolvedValue(true)} />)
  })
  return { onExportBackup }
}

function status(): HTMLElement {
  return container.querySelector('[data-testid="backup-status"]') as HTMLElement
}

function ageText(): string {
  return container.querySelector('[data-testid="backup-status-age"]')!.textContent!
}

describe('BackupStatus — the age is always stated, never only implied', () => {
  it('names today as today rather than as zero days', () => {
    render({ level: 'fresh', days: 0 })
    expect(ageText()).toBe('Last copy saved today.')
  })

  it('names one day as yesterday rather than as "1 days ago"', () => {
    render({ level: 'fresh', days: 1 })
    expect(ageText()).toBe('Last copy saved yesterday.')
  })

  it('counts plain days beyond that', () => {
    render({ level: 'fresh', days: 4 })
    expect(ageText()).toBe('Last copy saved 4 days ago.')
  })

  it('states plainly that nothing has ever been backed up', () => {
    render({ level: 'never', days: 0 })
    expect(ageText()).toBe('No copy saved to this phone yet.')
  })

  it('carries the level on the element, so the escalation is visible to a render and to a test', () => {
    render({ level: 'overdue', days: 44 })
    expect(status().dataset.level).toBe('overdue')
    expect(status().className).toContain('backup-status--overdue')
  })
})

describe('BackupStatus — escalation is tone and consequence, never repetition', () => {
  it('says nothing beyond the age while fresh — no warning, no consequence, no imperative', () => {
    render({ level: 'fresh', days: 2 })
    expect(container.querySelector('[data-testid="backup-status-detail"]')).toBeNull()
  })

  it('explains what a file is FOR when none has been saved, rather than naming a loss (T097)', () => {
    render({ level: 'never', days: 0 })
    const detail = container.querySelector('[data-testid="backup-status-detail"]')!
    expect(detail.textContent).toContain('go to the server on their own')
    expect(detail.textContent).toContain('extra copy')
  })

  it('says nothing beyond the age at every level that HAS a copy — the age is the whole message (T097)', () => {
    // Escalating consequence copy ("only on this phone", "lost or replaced")
    // belonged to an app with no server. The server takes her library after
    // every save and the sync line reports that by cause; repeating it here in
    // stronger words was both redundant and, on a synced phone, false.
    for (const age of [
      { level: 'fresh', days: 2 },
      { level: 'aging', days: 12 },
      { level: 'overdue', days: 44 },
    ] as const) {
      render(age)
      expect(
        container.querySelector('[data-testid="backup-status-detail"]'),
        `${age.level} must add no consequence line`,
      ).toBeNull()
    }
  })

  it('offers no way to dismiss it at any level — there is no reflex to train', () => {
    for (const age of [
      { level: 'fresh', days: 0 },
      { level: 'aging', days: 10 },
      { level: 'overdue', days: 90 },
      { level: 'never', days: 0 },
    ] as const) {
      render(age)
      expect(container.querySelector('[data-testid="dismiss-backup-nudge"]')).toBeNull()
      expect(status().textContent).not.toContain('Got it')
    }
  })

  it('never takes the screen’s rose button, at any level (T097)', () => {
    // The rose is for something she must act on. Saving a second copy of a
    // library the server already holds is not that, and dressing it that way
    // is what made the one person who uses this app read it as an emergency.
    render({ level: 'fresh', days: 1 })
    expect(container.querySelector('[data-testid="backup-status-export"]')!.className).toBe('link-action')

    for (const age of [
      { level: 'aging', days: 12 },
      { level: 'never', days: 0 },
      { level: 'overdue', days: 90 },
    ] as const) {
      render(age)
      expect(container.querySelector('[data-testid="backup-status-export"]')!.className).toBe('btn-icon')
    }
  })
})

describe('BackupStatus — the export action', () => {
  it('calls the export handler once per tap', async () => {
    const { onExportBackup } = render({ level: 'aging', days: 9 })
    await act(async () => {
      click(container.querySelector('[data-testid="backup-status-export"]'))
      await flush()
    })
    expect(onExportBackup).toHaveBeenCalledTimes(1)
  })

  it('confirms a shared file in her words, not the API’s', async () => {
    render({ level: 'aging', days: 9 }, vi.fn().mockResolvedValue({ kind: 'shared' }))
    await act(async () => {
      click(container.querySelector('[data-testid="backup-status-export"]'))
      await flush()
    })
    expect(container.querySelector('[data-testid="backup-status-result"]')!.textContent).toContain('Backup saved')
  })

  it('says where a downloaded file went when it ran in a browser tab', async () => {
    render({ level: 'aging', days: 9 }, vi.fn().mockResolvedValue({ kind: 'downloaded' }))
    await act(async () => {
      click(container.querySelector('[data-testid="backup-status-export"]'))
      await flush()
    })
    expect(container.querySelector('[data-testid="backup-status-result"]')!.textContent).toContain('Files')
  })

  it('says nothing at all when she backs out of the share sheet', async () => {
    render({ level: 'aging', days: 9 }, vi.fn().mockResolvedValue({ kind: 'cancelled' }))
    await act(async () => {
      click(container.querySelector('[data-testid="backup-status-export"]'))
      await flush()
    })
    expect(container.querySelector('[data-testid="backup-status-result"]')).toBeNull()
  })
})

describe('BackupStatus — the fallback when the share sheet is unavailable', () => {
  const unavailable = { kind: 'unavailable', text: '{"decks":[]}', filename: 'phrase-drill-backup.json' }

  async function exportOnce(onCopyText = vi.fn().mockResolvedValue(true)) {
    act(() => {
      root.render(
        <BackupStatus
          age={{ level: 'overdue', days: 60 }}
          onExportBackup={vi.fn().mockResolvedValue(unavailable)}
          onCopyText={onCopyText}
        />,
      )
    })
    await act(async () => {
      click(container.querySelector('[data-testid="backup-status-export"]'))
      await flush()
    })
    return onCopyText
  }

  it('shows the backup text in the app rather than claiming a file was written', async () => {
    await exportOnce()
    const sheet = container.querySelector('[data-testid="backup-copy-sheet"]')
    expect(sheet).not.toBeNull()
    expect((container.querySelector('[data-testid="backup-copy-text"]') as HTMLTextAreaElement).value).toBe(
      '{"decks":[]}',
    )
  })

  it('never renders a download link in the fallback — a download strands an installed iOS web app', async () => {
    await exportOnce()
    expect(container.querySelector('a[download]')).toBeNull()
  })

  it('copies the whole backup to the clipboard and confirms it', async () => {
    const onCopyText = await exportOnce()
    await act(async () => {
      click(container.querySelector('[data-testid="backup-copy"]'))
      await flush()
    })
    expect(onCopyText).toHaveBeenCalledWith('{"decks":[]}')
    expect(container.querySelector('[data-testid="backup-copy-sheet"]')!.textContent).toContain('Copied')
  })

  it('says so plainly when the clipboard refused, rather than pretending', async () => {
    await exportOnce(vi.fn().mockResolvedValue(false))
    await act(async () => {
      click(container.querySelector('[data-testid="backup-copy"]'))
      await flush()
    })
    expect(container.querySelector('[data-testid="backup-copy-sheet"]')!.textContent).toContain(
      'select it and copy it by hand',
    )
  })

  it('closes on Done, leaving nothing modal behind', async () => {
    await exportOnce()
    await act(async () => click(container.querySelector('[data-testid="backup-copy-done"]')))
    expect(container.querySelector('[data-testid="backup-copy-sheet"]')).toBeNull()
  })
})
