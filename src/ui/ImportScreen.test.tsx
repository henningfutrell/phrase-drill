import type { ReactElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImportScreen } from './ImportScreen'
import type { Deck } from '../domain/deck'
import type { DraftPhrase, ScanError, ScanReader } from '../domain/ports'

function deck(id: string, name: string, phraseCount: number): Deck {
  return {
    id,
    name,
    phrases: Array.from({ length: phraseCount }, (_, i) => ({
      id: `${id}-p${i}`,
      french: `fr-${id}-${i}`,
      english: `en-${id}-${i}`,
    })),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * By default this fake hands back a promise that only settles when the test
 * explicitly calls `resolveRead`/`rejectRead` — deliberately decoupled from
 * when `read()` was called, so a test can drive a settlement that happens
 * *after* some other UI event (a cancel) has already occurred. It also
 * records the `AbortSignal` it was given so a test can assert whether
 * `cancelReading` actually aborted it. A fake that only ever resolves before
 * the events a test drives cannot express a stale-callback bug at any
 * coverage level — this is what makes that bug expressible.
 *
 * Individual tests may still override `read` via `mockReturnValue` /
 * `mockResolvedValue` / `mockRejectedValue` when they don't care about
 * settlement timing or the signal.
 */
function fakeScanReader(): {
  reader: ScanReader
  read: ReturnType<typeof vi.fn>
  resolveRead(drafts: DraftPhrase[]): void
  rejectRead(error: ScanError): void
  signalAborted(): boolean
} {
  const { promise, resolve, reject } = deferred<DraftPhrase[]>()
  let signal: AbortSignal | undefined
  const read = vi.fn<ScanReader['read']>((_image, s) => {
    signal = s
    return promise
  })
  return {
    reader: { read },
    read,
    resolveRead: resolve,
    rejectRead: reject,
    signalAborted: () => signal?.aborted ?? false,
  }
}

function file(name = 'photo.jpg'): File {
  return new File(['fake-bytes'], name, { type: 'image/jpeg' })
}

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

function click(el: Element | null) {
  if (!el) throw new Error('element not found')
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function chooseFile(input: HTMLInputElement, chosen: File): void {
  Object.defineProperty(input, 'files', { value: [chosen], configurable: true })
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function flush(): Promise<void> {
  await act(async () => {
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

describe('ImportScreen — capture', () => {
  it('offers Take Photo and Choose from Library controls', () => {
    const { reader } = fakeScanReader()
    render(<ImportScreen decks={[]} scanReader={reader} onSave={vi.fn()} onCancel={vi.fn()} />)
    expect(container.querySelector('[data-testid="take-photo"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="choose-from-library"]')).not.toBeNull()
  })

  it('calls onCancel when the screen is abandoned, without ever calling onSave', () => {
    const onCancel = vi.fn()
    const onSave = vi.fn()
    const { reader } = fakeScanReader()
    render(<ImportScreen decks={[]} scanReader={reader} onSave={onSave} onCancel={onCancel} />)
    click(container.querySelector('[data-testid="cancel-import"]'))
    expect(onCancel).toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })
})

describe('ImportScreen — reading', () => {
  it('moves to a reading state with Cancel once a photo is chosen, and calls scanReader.read', () => {
    const { reader, read } = fakeScanReader()
    read.mockReturnValue(deferred<DraftPhrase[]>().promise)
    render(<ImportScreen decks={[]} scanReader={reader} onSave={vi.fn()} onCancel={vi.fn()} />)

    const input = container.querySelector('[data-testid="take-photo-input"]') as HTMLInputElement
    chooseFile(input, file())

    expect(read).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="scan-cancel"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="take-photo"]')).toBeNull()
  })

  it('returns to capture when Cancel is tapped mid-read', () => {
    const { reader, read } = fakeScanReader()
    const { promise } = deferred<DraftPhrase[]>()
    read.mockReturnValue(promise)
    render(<ImportScreen decks={[]} scanReader={reader} onSave={vi.fn()} onCancel={vi.fn()} />)

    chooseFile(container.querySelector('[data-testid="take-photo-input"]') as HTMLInputElement, file())
    click(container.querySelector('[data-testid="scan-cancel"]'))

    expect(container.querySelector('[data-testid="take-photo"]')).not.toBeNull()
  })

  it('aborts the signal handed to scanReader.read when Cancel is tapped', () => {
    const { reader, signalAborted } = fakeScanReader()
    render(<ImportScreen decks={[]} scanReader={reader} onSave={vi.fn()} onCancel={vi.fn()} />)

    chooseFile(container.querySelector('[data-testid="take-photo-input"]') as HTMLInputElement, file())
    expect(signalAborted()).toBe(false)
    click(container.querySelector('[data-testid="scan-cancel"]'))

    expect(signalAborted()).toBe(true)
  })

  it('ignores a read that resolves after Cancel was tapped — no reappearing drafts she already discarded', async () => {
    const { reader, resolveRead } = fakeScanReader()
    render(<ImportScreen decks={[]} scanReader={reader} onSave={vi.fn()} onCancel={vi.fn()} />)

    chooseFile(container.querySelector('[data-testid="take-photo-input"]') as HTMLInputElement, file())
    click(container.querySelector('[data-testid="scan-cancel"]'))
    resolveRead([{ french: 'Bonjour', english: 'Hello' }])
    await flush()

    expect(container.querySelector('[data-testid="take-photo"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="draft-row-0"]')).toBeNull()
  })

  it('ignores a read that rejects after Cancel was tapped, without surfacing an error banner for abandoned work', async () => {
    const { reader, rejectRead } = fakeScanReader()
    render(<ImportScreen decks={[]} scanReader={reader} onSave={vi.fn()} onCancel={vi.fn()} />)

    chooseFile(container.querySelector('[data-testid="take-photo-input"]') as HTMLInputElement, file())
    click(container.querySelector('[data-testid="scan-cancel"]'))
    rejectRead({ kind: 'network', detail: 'offline' })
    await flush()

    expect(container.querySelector('[data-testid="take-photo"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="scan-failed"]')).toBeNull()
  })
})

describe('ImportScreen — a Scan with no phrases on it', () => {
  it('says so calmly, not as an error, and offers another try', async () => {
    const { reader, read } = fakeScanReader()
    read.mockResolvedValue([])
    render(<ImportScreen decks={[]} scanReader={reader} onSave={vi.fn()} onCancel={vi.fn()} />)

    chooseFile(container.querySelector('[data-testid="take-photo-input"]') as HTMLInputElement, file())
    await flush()

    const empty = container.querySelector('[data-testid="scan-empty"]')
    expect(empty).not.toBeNull()
    expect(empty?.className).not.toContain('error')
    click(container.querySelector('[data-testid="scan-try-again"]'))
    expect(container.querySelector('[data-testid="take-photo"]')).not.toBeNull()
  })
})

describe('ImportScreen — ScanError', () => {
  it('shows plain-language copy for unreadable, with Try again', async () => {
    const { reader, read } = fakeScanReader()
    const error: ScanError = { kind: 'unreadable', detail: 'blurry' }
    read.mockRejectedValue(error)
    render(<ImportScreen decks={[]} scanReader={reader} onSave={vi.fn()} onCancel={vi.fn()} />)

    chooseFile(container.querySelector('[data-testid="take-photo-input"]') as HTMLInputElement, file())
    await flush()

    expect(container.textContent).toContain("Couldn't read phrases from that photo")
    click(container.querySelector('[data-testid="scan-try-again"]'))
    expect(container.querySelector('[data-testid="take-photo"]')).not.toBeNull()
  })

  it('shows plain-language copy for network failures, with Try again', async () => {
    const { reader, read } = fakeScanReader()
    const error: ScanError = { kind: 'network', detail: 'offline' }
    read.mockRejectedValue(error)
    render(<ImportScreen decks={[]} scanReader={reader} onSave={vi.fn()} onCancel={vi.fn()} />)

    chooseFile(container.querySelector('[data-testid="take-photo-input"]') as HTMLInputElement, file())
    await flush()

    expect(container.textContent).toContain("Couldn't reach the scanner")
  })

  it('shows the calm "ask whoever runs it" copy for unauthorized, with no stack trace and no Try again', async () => {
    const { reader, read } = fakeScanReader()
    const error: ScanError = { kind: 'unauthorized' }
    read.mockRejectedValue(error)
    render(<ImportScreen decks={[]} scanReader={reader} onSave={vi.fn()} onCancel={vi.fn()} />)

    chooseFile(container.querySelector('[data-testid="take-photo-input"]') as HTMLInputElement, file())
    await flush()

    expect(container.textContent).toContain("Ask whoever runs it to check")
    expect(container.querySelector('[data-testid="scan-try-again"]')).toBeNull()
    expect(container.querySelector('[data-testid="scan-back-to-capture"]')).not.toBeNull()
  })
})

describe('ImportScreen — review & assign', () => {
  const drafts: DraftPhrase[] = [
    { french: 'Bonjour', english: 'Hello' },
    { french: 'Merci', english: 'Thank you' },
  ]

  async function renderInReview(decks: Deck[] = []) {
    const { reader, read } = fakeScanReader()
    read.mockResolvedValue(drafts)
    const onSave = vi.fn()
    render(<ImportScreen decks={decks} scanReader={reader} onSave={onSave} onCancel={vi.fn()} />)
    chooseFile(container.querySelector('[data-testid="take-photo-input"]') as HTMLInputElement, file())
    await flush()
    return { onSave }
  }

  it('renders every Draft Phrase, English over French', async () => {
    await renderInReview()
    expect(container.querySelector('[data-testid="draft-row-0"]')?.textContent).toContain('Bonjour')
    expect(container.querySelector('[data-testid="draft-row-0"]')?.textContent).toContain('Hello')
    expect(container.querySelector('[data-testid="draft-row-1"]')?.textContent).toContain('Merci')

    // Same reading order as a Deck row (T062): English entry, French under it.
    const lines = container.querySelectorAll('[data-testid="draft-row-0"] .phrase-text > *')
    expect(lines).toHaveLength(2)
    expect(lines[0].className).toBe('phrase-english')
    expect(lines[0].textContent).toBe('Hello')
    expect(lines[1].className).toBe('phrase-french')
    expect(lines[1].textContent).toBe('Bonjour')
  })

  it('edits a Draft Phrase inline via the shared PhraseSheet', async () => {
    await renderInReview()
    click(container.querySelector('[data-testid="edit-draft-0"]'))
    const frenchInput = container.querySelector('[data-testid="phrase-french-input"]') as HTMLInputElement
    expect(frenchInput.value).toBe('Bonjour')
    typeInto(frenchInput, 'Bonjour !')
    click(container.querySelector('[data-testid="phrase-save"]'))
    expect(container.querySelector('[data-testid="draft-row-0"]')?.textContent).toContain('Bonjour !')
  })

  it('removes a Draft Phrase row without touching the others', async () => {
    await renderInReview()
    click(container.querySelector('[data-testid="delete-draft-0"]'))
    expect(container.querySelector('[data-testid="draft-row-0"]')?.textContent).toContain('Merci')
    expect(container.querySelectorAll('[data-testid^="draft-row-"]').length).toBe(1)
  })

  it('disables Save until a Deck is chosen', async () => {
    const home = deck('home', 'Home', 0)
    await renderInReview([home])
    const save = container.querySelector('[data-testid="save-import"]') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    click(container.querySelector('[data-testid="deck-option-home"]'))
    expect(save.disabled).toBe(false)
  })

  it('disables Save once every Draft Phrase has been removed', async () => {
    const home = deck('home', 'Home', 0)
    await renderInReview([home])
    click(container.querySelector('[data-testid="deck-option-home"]'))
    click(container.querySelector('[data-testid="delete-draft-0"]'))
    click(container.querySelector('[data-testid="delete-draft-0"]'))
    const save = container.querySelector('[data-testid="save-import"]') as HTMLButtonElement
    expect(save.disabled).toBe(true)
  })

  it('assigns the whole batch to a New Deck created inline', async () => {
    const { onSave } = await renderInReview([])
    click(container.querySelector('[data-testid="new-deck-option"]'))
    const input = container.querySelector('[data-testid="deck-name-input"]') as HTMLInputElement
    typeInto(input, 'Travel')
    click(container.querySelector('[data-testid="deck-name-save"]'))
    click(container.querySelector('[data-testid="save-import"]'))
    expect(onSave).toHaveBeenCalledWith({ kind: 'new', name: 'Travel' }, drafts)
  })

  it('saves the edited/reduced batch to the chosen existing Deck only when Save is tapped, never earlier', async () => {
    const home = deck('home', 'Home', 0)
    const { onSave } = await renderInReview([home])
    click(container.querySelector('[data-testid="deck-option-home"]'))
    click(container.querySelector('[data-testid="delete-draft-1"]'))
    expect(onSave).not.toHaveBeenCalled()
    click(container.querySelector('[data-testid="save-import"]'))
    expect(onSave).toHaveBeenCalledWith({ kind: 'existing', deckId: 'home' }, [drafts[0]])
    expect(onSave).toHaveBeenCalledTimes(1)
  })
})

