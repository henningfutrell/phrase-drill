import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackupStatus } from './BackupStatus'
import { DecksScreen } from './DecksScreen'
import type { BackupAgeLevel, Deck } from '../domain'

/**
 * The server holds her library (T041/T043). A file she saves on the phone is
 * an EXTRA copy she keeps herself — insurance against the one case the server
 * cannot cover (a row the server refuses to read, and no phone left) — and not
 * the thing standing between her and loss. So it is offered where she goes
 * looking for it, and never pushed at her on the screen she drills from.
 *
 * This replaces the escalation built when the app had no server at all: the
 * rose "Save a copy now" under "Everything here is only on this phone. Nothing
 * has reached the server or a file yet." That sentence is now usually FALSE —
 * sync pushes after every save — and it read as an emergency to the one person
 * who uses this app.
 */
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

const deck: Deck = { id: 'd1', name: 'Home', language: 'fr', phrases: [], createdAt: 1, updatedAt: 1 }

describe('the file backup is an affordance, not an alarm (T097)', () => {
  it('says nothing about file backups on the Decks screen — the sync line already says where her phrases are', () => {
    act(() => {
      root.render(
        <DecksScreen
          decks={[deck]}
          onCreateDeck={vi.fn()}
          onRenameDeck={vi.fn()}
          onDeleteDeck={vi.fn()}
          onOpenDeck={vi.fn()}
          onOpenSettings={vi.fn()}
          onOpenMix={vi.fn()}
          onOpenImport={vi.fn()}
          backupAge={{ level: 'never', days: 0 }}
          onExportBackup={vi.fn()}
        />,
      )
    })
    expect(container.querySelector('[data-testid="backup-status"]')).toBeNull()
  })

  it('never escalates to the screen’s rose button — nothing about a file copy is an emergency', () => {
    for (const level of ['never', 'fresh', 'aging', 'overdue'] as BackupAgeLevel[]) {
      act(() => {
        root.render(<BackupStatus age={{ level, days: 40 }} onExportBackup={vi.fn()} />)
      })
      const action = container.querySelector('[data-testid="backup-status-export"]')!
      expect(action.className, `${level} must not be the screen's primary action`).not.toContain('btn-primary')
    }
  })

  it('does not claim nothing has reached the server — that is the sync line’s job, and here it is usually wrong', () => {
    act(() => {
      root.render(<BackupStatus age={{ level: 'never', days: 0 }} onExportBackup={vi.fn()} />)
    })
    expect(container.textContent).not.toContain('only on this phone')
    expect(container.textContent).not.toContain('reached the server')
  })
})
