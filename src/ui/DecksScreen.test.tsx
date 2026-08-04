import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DecksScreen } from './DecksScreen'
import type { Deck } from '../domain'

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function click(el: Element): void {
  ;(el as HTMLElement).click()
}

function deck(id: string, name: string, phraseCount: number): Deck {
  return {
    id,
    name,
    phrases: Array.from({ length: phraseCount }, (_, i) => ({
      id: `${id}-p${i}`,
      french: `f${i}`,
      english: `e${i}`,
    })),
  }
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

describe('DecksScreen', () => {
  it('renders every Deck with its name and Phrase count', () => {
    act(() => {
      root.render(
        <DecksScreen
          decks={[deck('d1', 'Home', 3), deck('d2', 'Climbing', 0)]}
          onCreateDeck={vi.fn()}
          onRenameDeck={vi.fn()}
          onDeleteDeck={vi.fn()}
          onOpenDeck={vi.fn()}
        />,
      )
    })
    expect(container.textContent).toContain('Home')
    expect(container.textContent).toContain('3 phrases')
    expect(container.textContent).toContain('Climbing')
  })

  it('shows an empty-state prompt when there are no Decks', () => {
    act(() => {
      root.render(
        <DecksScreen
          decks={[]}
          onCreateDeck={vi.fn()}
          onRenameDeck={vi.fn()}
          onDeleteDeck={vi.fn()}
          onOpenDeck={vi.fn()}
        />,
      )
    })
    expect(container.textContent).toContain('Nothing here yet')
  })

  it('states the backup age on the home screen whenever there is anything to lose', () => {
    act(() => {
      root.render(
        <DecksScreen
          decks={[deck('d1', 'Home', 3)]}
          onCreateDeck={vi.fn()}
          onRenameDeck={vi.fn()}
          onDeleteDeck={vi.fn()}
          onOpenDeck={vi.fn()}
          backupAge={{ level: 'aging', days: 11 }}
          onExportBackup={vi.fn().mockResolvedValue({ kind: 'shared' })}
        />,
      )
    })
    const indicator = container.querySelector('[data-testid="backup-status"]')
    expect(indicator).not.toBeNull()
    expect(indicator!.textContent).toContain('11 days ago')
  })

  it('states the age quietly rather than hiding it when the backup is fresh', () => {
    act(() => {
      root.render(
        <DecksScreen
          decks={[deck('d1', 'Home', 3)]}
          onCreateDeck={vi.fn()}
          onRenameDeck={vi.fn()}
          onDeleteDeck={vi.fn()}
          onOpenDeck={vi.fn()}
          backupAge={{ level: 'fresh', days: 0 }}
          onExportBackup={vi.fn().mockResolvedValue({ kind: 'shared' })}
        />,
      )
    })
    expect(container.querySelector('[data-testid="backup-status"]')!.textContent).toContain(
      'Backed up today',
    )
  })

  it('says nothing about backups while there is nothing to back up', () => {
    act(() => {
      root.render(
        <DecksScreen
          decks={[]}
          onCreateDeck={vi.fn()}
          onRenameDeck={vi.fn()}
          onDeleteDeck={vi.fn()}
          onOpenDeck={vi.fn()}
          backupAge={{ level: 'never', days: 0 }}
          onExportBackup={vi.fn().mockResolvedValue({ kind: 'shared' })}
        />,
      )
    })
    expect(container.querySelector('[data-testid="backup-status"]')).toBeNull()
  })

  it('offers Restore on the empty state — the screen a wiped or replaced phone actually opens on', () => {
    const onRestoreFileChosen = vi.fn().mockResolvedValue({ ok: true })
    act(() => {
      root.render(
        <DecksScreen
          decks={[]}
          onCreateDeck={vi.fn()}
          onRenameDeck={vi.fn()}
          onDeleteDeck={vi.fn()}
          onOpenDeck={vi.fn()}
          onRestoreFileChosen={onRestoreFileChosen}
          onConfirmRestore={vi.fn()}
          onCancelRestore={vi.fn()}
        />,
      )
    })
    expect(container.querySelector('[data-testid="restore-backup"]')).not.toBeNull()
  })

  it('keeps Restore off the empty state when the caller wired no restore path', () => {
    act(() => {
      root.render(
        <DecksScreen
          decks={[]}
          onCreateDeck={vi.fn()}
          onRenameDeck={vi.fn()}
          onDeleteDeck={vi.fn()}
          onOpenDeck={vi.fn()}
        />,
      )
    })
    expect(container.querySelector('[data-testid="restore-backup"]')).toBeNull()
  })

  it('renders a Mix decks link that calls onOpenMix when provided', () => {
    const onOpenMix = vi.fn()
    act(() => {
      root.render(
        <DecksScreen
          decks={[deck('d1', 'Home', 3), deck('d2', 'Climbing', 2)]}
          onCreateDeck={vi.fn()}
          onRenameDeck={vi.fn()}
          onDeleteDeck={vi.fn()}
          onOpenDeck={vi.fn()}
          onOpenMix={onOpenMix}
        />,
      )
    })
    click(container.querySelector('[data-testid="open-mix"]')!)
    expect(onOpenMix).toHaveBeenCalledTimes(1)
  })

  it('omits the Mix decks link when onOpenMix is not provided', () => {
    act(() => {
      root.render(
        <DecksScreen
          decks={[deck('d1', 'Home', 3)]}
          onCreateDeck={vi.fn()}
          onRenameDeck={vi.fn()}
          onDeleteDeck={vi.fn()}
          onOpenDeck={vi.fn()}
        />,
      )
    })
    expect(container.querySelector('[data-testid="open-mix"]')).toBeNull()
  })

  it('renders a Scan a page link that calls onOpenImport when provided', () => {
    const onOpenImport = vi.fn()
    act(() => {
      root.render(
        <DecksScreen
          decks={[deck('d1', 'Home', 3)]}
          onCreateDeck={vi.fn()}
          onRenameDeck={vi.fn()}
          onDeleteDeck={vi.fn()}
          onOpenDeck={vi.fn()}
          onOpenImport={onOpenImport}
        />,
      )
    })
    click(container.querySelector('[data-testid="open-import"]')!)
    expect(onOpenImport).toHaveBeenCalledTimes(1)
  })

  it('omits the Scan a page link when onOpenImport is not provided', () => {
    act(() => {
      root.render(
        <DecksScreen
          decks={[deck('d1', 'Home', 3)]}
          onCreateDeck={vi.fn()}
          onRenameDeck={vi.fn()}
          onDeleteDeck={vi.fn()}
          onOpenDeck={vi.fn()}
        />,
      )
    })
    expect(container.querySelector('[data-testid="open-import"]')).toBeNull()
  })

  it('calls onOpenDeck when a Deck row is tapped', () => {
    const onOpenDeck = vi.fn()
    act(() => {
      root.render(
        <DecksScreen
          decks={[deck('d1', 'Home', 3)]}
          onCreateDeck={vi.fn()}
          onRenameDeck={vi.fn()}
          onDeleteDeck={vi.fn()}
          onOpenDeck={onOpenDeck}
        />,
      )
    })
    click(container.querySelector('[data-testid="deck-row-d1"]')!)
    expect(onOpenDeck).toHaveBeenCalledWith('d1')
  })

  it('creates a Deck from the New Deck sheet', () => {
    const onCreateDeck = vi.fn()
    act(() => {
      root.render(
        <DecksScreen
          decks={[]}
          onCreateDeck={onCreateDeck}
          onRenameDeck={vi.fn()}
          onDeleteDeck={vi.fn()}
          onOpenDeck={vi.fn()}
        />,
      )
    })
    act(() => click(container.querySelector('[data-testid="new-deck"]')!))
    const input = container.querySelector('[data-testid="deck-name-input"]') as HTMLInputElement
    act(() => typeInto(input, 'Work'))
    act(() => click(container.querySelector('[data-testid="deck-name-save"]')!))
    expect(onCreateDeck).toHaveBeenCalledWith('Work')
  })

  it('renames a Deck from its Rename sheet, pre-filled with the current name', () => {
    const onRenameDeck = vi.fn()
    act(() => {
      root.render(
        <DecksScreen
          decks={[deck('d1', 'Home', 1)]}
          onCreateDeck={vi.fn()}
          onRenameDeck={onRenameDeck}
          onDeleteDeck={vi.fn()}
          onOpenDeck={vi.fn()}
        />,
      )
    })
    act(() => click(container.querySelector('[data-testid="rename-deck-d1"]')!))
    const input = container.querySelector('[data-testid="deck-name-input"]') as HTMLInputElement
    expect(input.value).toBe('Home')
    act(() => typeInto(input, 'Home base'))
    act(() => click(container.querySelector('[data-testid="deck-name-save"]')!))
    expect(onRenameDeck).toHaveBeenCalledWith('d1', 'Home base')
  })

  it('deletes a Deck only after the inline confirmation is tapped', () => {
    const onDeleteDeck = vi.fn()
    act(() => {
      root.render(
        <DecksScreen
          decks={[deck('d1', 'Home', 1)]}
          onCreateDeck={vi.fn()}
          onRenameDeck={vi.fn()}
          onDeleteDeck={onDeleteDeck}
          onOpenDeck={vi.fn()}
        />,
      )
    })
    act(() => click(container.querySelector('[data-testid="delete-deck-d1"]')!))
    expect(onDeleteDeck).not.toHaveBeenCalled()
    act(() => click(container.querySelector('[data-testid="confirm-delete-deck-d1"]')!))
    expect(onDeleteDeck).toHaveBeenCalledWith('d1')
  })
})

describe('DecksScreen — the sync line (T034)', () => {
  it('shows the sync line it is given, so sync state is visible without opening anything', () => {
    act(() => {
      root.render(
        <DecksScreen
          decks={[deck('d1', 'Home', 1)]}
          onCreateDeck={vi.fn()}
          onRenameDeck={vi.fn()}
          onDeleteDeck={vi.fn()}
          onOpenDeck={vi.fn()}
          syncStatus="Synced 3 minutes ago"
        />,
      )
    })

    expect(container.querySelector('[data-testid="sync-status"]')!.textContent).toBe('Synced 3 minutes ago')
  })

  it('shows no sync line at all when there is nothing to say', () => {
    act(() => {
      root.render(
        <DecksScreen
          decks={[deck('d1', 'Home', 1)]}
          onCreateDeck={vi.fn()}
          onRenameDeck={vi.fn()}
          onDeleteDeck={vi.fn()}
          onOpenDeck={vi.fn()}
        />,
      )
    })

    expect(container.querySelector('[data-testid="sync-status"]')).toBeNull()
  })
})
