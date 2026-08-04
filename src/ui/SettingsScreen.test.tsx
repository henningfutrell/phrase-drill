import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsScreen, type VoiceOption } from './SettingsScreen'

const RACHEL: VoiceOption = {
  provider: 'elevenlabs',
  modelId: 'eleven_multilingual_v2',
  voiceId: 'voice-rachel',
  name: 'Rachel',
  description: 'Female voice, American-accented English speaking French.',
}
const CHARLOTTE: VoiceOption = {
  provider: 'elevenlabs',
  modelId: 'eleven_multilingual_v2',
  voiceId: 'voice-charlotte',
  name: 'Charlotte',
  description: 'Female voice, European-accented English speaking French.',
}
const VOICES: VoiceOption[] = [RACHEL, CHARLOTTE]

/** Resolves after a microtask so a promise-returning handler's `.then` runs before assertions. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function click(el: Element): void {
  ;(el as HTMLElement).click()
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function renderScreen(overrides: Partial<Parameters<typeof SettingsScreen>[0]> = {}) {
  const props = {
    onBack: vi.fn(),
    voice: null,
    voices: VOICES,
    previewText: 'Bonjour, comment ça va ?',
    onPreviewVoice: vi.fn().mockResolvedValue({ ok: true }),
    onChooseVoice: vi.fn(),
    onExportBackup: vi.fn().mockResolvedValue({ kind: 'shared' }),
    backupAge: { level: 'fresh' as const, days: 0 },
    onRestoreFileChosen: vi.fn().mockResolvedValue({ ok: true }),
    onConfirmRestore: vi.fn().mockResolvedValue(undefined),
    onCancelRestore: vi.fn(),
    onOpenDiagnostics: vi.fn(),
    savedAudio: undefined as { bytes: number; clipCount: number; maxBytes: number } | undefined,
    ...overrides,
  }
  act(() => {
    root.render(<SettingsScreen {...props} />)
  })
  return props
}

function fakeFileList(file: File): FileList {
  return { 0: file, length: 1, item: (i: number) => (i === 0 ? file : null) } as unknown as FileList
}

function chooseRestoreFile(file: File): void {
  const input = container.querySelector('[data-testid="restore-file-input"]') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: fakeFileList(file), configurable: true })
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('SettingsScreen', () => {
  it('offers Diagnostics reachably — not buried behind a gesture — and routes to it on tap', () => {
    const props = renderScreen()
    const link = container.querySelector('[data-testid="open-diagnostics"]')
    expect(link).not.toBeNull()

    click(link!)

    expect(props.onOpenDiagnostics).toHaveBeenCalledTimes(1)
  })

  it('no longer offers a Sync section — identity is a session login now, not a pasted key (T050)', () => {
    renderScreen()
    expect(container.querySelector('[data-testid="sync-section"]')).toBeNull()
    expect(container.querySelector('[data-testid="library-key-display"]')).toBeNull()
  })

  describe('voice picker', () => {
    it('shows a calm explanation, not an error, when no voice is pinned yet', () => {
      renderScreen({ voice: null })
      const display = container.querySelector('[data-testid="voice-display"]')
      expect(display?.textContent).not.toMatch(/error|failed/i)
      expect(display?.textContent).toMatch(/no voice/i)
    })

    it('lists every voice in the catalogue with its plain-language description', () => {
      renderScreen()
      expect(container.querySelector('[data-testid="voice-option-voice-rachel"]')).not.toBeNull()
      expect(container.querySelector('[data-testid="voice-option-voice-charlotte"]')).not.toBeNull()
      expect(container.querySelector('[data-testid="voice-option-voice-rachel"]')?.textContent).toContain(
        'American-accented',
      )
    })

    it('marks the currently pinned voice distinctly from the others', () => {
      renderScreen({
        voice: { provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-rachel' },
      })
      expect(container.querySelector('[data-testid="voice-current-voice-rachel"]')).not.toBeNull()
      expect(container.querySelector('[data-testid="voice-current-voice-charlotte"]')).toBeNull()
    })

    it('previews a voice using the real phrase text handed to it, not a hardcoded one', async () => {
      const props = renderScreen({ previewText: 'Où est la gare ?' })
      await act(async () => click(container.querySelector('[data-testid="voice-preview-voice-rachel"]')!))

      expect(props.onPreviewVoice).toHaveBeenCalledTimes(1)
      const [voiceArg, textArg] = vi.mocked(props.onPreviewVoice).mock.calls[0]!
      expect(voiceArg).toEqual({ provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-rachel' })
      expect(textArg).toBe('Où est la gare ?')
    })

    it('passes a fresh AbortSignal to each preview', async () => {
      const props = renderScreen()
      await act(async () => click(container.querySelector('[data-testid="voice-preview-voice-rachel"]')!))
      const [, , signal] = vi.mocked(props.onPreviewVoice).mock.calls[0]!
      expect(signal).toBeInstanceOf(AbortSignal)
      expect(signal.aborted).toBe(false)
    })

    it('aborts an in-flight preview when a different voice is tapped', async () => {
      let resolveFirst: (v: { ok: true }) => void
      const firstPreview = new Promise<{ ok: true }>((resolve) => {
        resolveFirst = resolve
      })
      const onPreviewVoice = vi.fn().mockReturnValueOnce(firstPreview).mockResolvedValue({ ok: true })
      renderScreen({ onPreviewVoice })

      act(() => click(container.querySelector('[data-testid="voice-preview-voice-rachel"]')!))
      const [, , firstSignal] = onPreviewVoice.mock.calls[0]!
      await act(async () => click(container.querySelector('[data-testid="voice-preview-voice-charlotte"]')!))

      expect(firstSignal.aborted).toBe(true)
      resolveFirst!({ ok: true })
    })

    it('aborts an in-flight preview on unmount', () => {
      let capturedSignal: AbortSignal | undefined
      const onPreviewVoice = vi.fn(
        (_voice: { modelId: string; voiceId: string }, _text: string, signal: AbortSignal) => {
          capturedSignal = signal
          return new Promise<{ ok: true }>(() => {
            // never resolves — simulates an in-flight request
          })
        },
      )
      renderScreen({ onPreviewVoice })
      act(() => click(container.querySelector('[data-testid="voice-preview-voice-rachel"]')!))

      act(() => root.unmount())

      expect(capturedSignal?.aborted).toBe(true)
    })

    it('shows a plain-language error inline when a preview fails, without blocking the screen', async () => {
      renderScreen({ onPreviewVoice: vi.fn().mockResolvedValue({ ok: false, reason: 'network' }) })
      await act(async () => click(container.querySelector('[data-testid="voice-preview-voice-rachel"]')!))
      await flush()

      const error = container.querySelector('[data-testid="voice-preview-error"]')
      expect(error).not.toBeNull()
      expect(error!.textContent).not.toMatch(/error|failed/i)
    })

    it('shows a calm explanation, naming the server, when a preview fails because it is not set up', async () => {
      renderScreen({ onPreviewVoice: vi.fn().mockResolvedValue({ ok: false, reason: 'unauthorized' }) })
      await act(async () => click(container.querySelector('[data-testid="voice-preview-voice-rachel"]')!))
      await flush()

      expect(container.querySelector('[data-testid="voice-preview-error"]')?.textContent).toMatch(/server/i)
    })

    // T035: our own server's limiter is a wait, not a bill. Telling her the
    // speech credit is used up when it is not sends her to ask for money she
    // does not need, and the remedy — try again in a moment — is different.
    it('says to wait, not that the credit is gone, when the server itself is rate-limiting', async () => {
      renderScreen({ onPreviewVoice: vi.fn().mockResolvedValue({ ok: false, reason: 'rate-limited' }) })
      await act(async () => click(container.querySelector('[data-testid="voice-preview-voice-rachel"]')!))
      await flush()

      const text = container.querySelector('[data-testid="voice-preview-error"]')?.textContent ?? ''
      expect(text).toMatch(/moment|again/i)
      expect(text).not.toMatch(/credit/i)
    })

    it('warns, before committing, that switching voices regenerates every phrase and takes a while — not "cache invalidation"', async () => {
      renderScreen()
      await act(async () => click(container.querySelector('[data-testid="voice-choose-voice-rachel"]')!))

      const sheet = container.querySelector('[data-testid="voice-confirm-sheet"]')
      expect(sheet).not.toBeNull()
      expect(sheet!.textContent).toMatch(/again|remade|made again/i)
      expect(sheet!.textContent).toMatch(/while|time/i)
      expect(sheet!.textContent).not.toMatch(/cache|invalidat/i)
    })

    it('does not choose the voice until the warning is confirmed', async () => {
      const props = renderScreen()
      await act(async () => click(container.querySelector('[data-testid="voice-choose-voice-rachel"]')!))
      expect(props.onChooseVoice).not.toHaveBeenCalled()
    })

    it('chooses the voice through onChooseVoice once confirmed', async () => {
      const props = renderScreen()
      await act(async () => click(container.querySelector('[data-testid="voice-choose-voice-rachel"]')!))
      await act(async () => click(container.querySelector('[data-testid="voice-confirm"]')!))

      expect(props.onChooseVoice).toHaveBeenCalledWith({
        provider: 'elevenlabs',
        modelId: 'eleven_multilingual_v2',
        voiceId: 'voice-rachel',
      })
      expect(container.querySelector('[data-testid="voice-confirm-sheet"]')).toBeNull()
    })

    it('dismisses the warning without choosing anything when cancelled', async () => {
      const props = renderScreen()
      await act(async () => click(container.querySelector('[data-testid="voice-choose-voice-rachel"]')!))
      await act(async () => click(container.querySelector('[data-testid="voice-cancel"]')!))

      expect(props.onChooseVoice).not.toHaveBeenCalled()
      expect(container.querySelector('[data-testid="voice-confirm-sheet"]')).toBeNull()
    })
  })

  it('calls onBack when the back control is tapped', () => {
    const props = renderScreen()
    act(() => click(container.querySelector('[data-testid="settings-back"]')!))
    expect(props.onBack).toHaveBeenCalled()
  })

  describe('backup', () => {
    it('explains, for someone who has never heard of a backup, why one matters', () => {
      renderScreen()
      const section = container.querySelector('[data-testid="backup-section"]')
      expect(section?.textContent).toMatch(/sync|backup/i)
    })

    it('states that saved audio is not part of the backup and regenerates on its own', () => {
      renderScreen()
      const section = container.querySelector('[data-testid="backup-section"]')
      expect(section?.textContent).toMatch(/audio/i)
      expect(section?.textContent).toMatch(/regenerat|again|automatically/i)
    })

    it('exports through onExportBackup when the export button is tapped', async () => {
      const props = renderScreen()
      await act(async () => click(container.querySelector('[data-testid="backup-status-export"]')!))
      expect(props.onExportBackup).toHaveBeenCalled()
    })

    it('confirms once the export has gone through the share sheet', async () => {
      renderScreen({ onExportBackup: vi.fn().mockResolvedValue({ kind: 'shared' }) })
      await act(async () => click(container.querySelector('[data-testid="backup-status-export"]')!))
      expect(container.querySelector('[data-testid="backup-status-result"]')?.textContent).toMatch(/saved/i)
    })

    it('tells her where to look when the share sheet is not available and it fell back to a download', async () => {
      renderScreen({ onExportBackup: vi.fn().mockResolvedValue({ kind: 'downloaded' }) })
      await act(async () => click(container.querySelector('[data-testid="backup-status-export"]')!))
      expect(container.querySelector('[data-testid="backup-status-result"]')?.textContent).toMatch(
        /download|files/i,
      )
    })

    it('says nothing alarming when she cancels out of the share sheet', async () => {
      renderScreen({ onExportBackup: vi.fn().mockResolvedValue({ kind: 'cancelled' }) })
      await act(async () => click(container.querySelector('[data-testid="backup-status-export"]')!))
      expect(container.textContent).not.toMatch(/error|failed/i)
    })

    it('puts Backup first on the screen — before Voice, before Diagnostics', () => {
      renderScreen()
      const sections = [...container.querySelectorAll('[data-testid$="-section"]')]
      expect((sections[0] as HTMLElement).dataset.testid).toBe('backup-section')
    })

    it('states the backup age here as well, not only on the home screen', async () => {
      renderScreen({ backupAge: { level: 'overdue', days: 52 } })
      const section = container.querySelector('[data-testid="backup-section"]')!
      expect(section.textContent).toContain('52 days ago')
    })

    it('opens the file picker when "Restore from backup" is tapped', () => {
      renderScreen()
      const input = container.querySelector('[data-testid="restore-file-input"]') as HTMLInputElement
      const clickSpy = vi.spyOn(input, 'click')
      act(() => click(container.querySelector('[data-testid="restore-backup"]')!))
      expect(clickSpy).toHaveBeenCalled()
    })

    it('shows a plain "this replaces everything" warning, never "merge", before restoring a valid file', async () => {
      const props = renderScreen({ onRestoreFileChosen: vi.fn().mockResolvedValue({ ok: true }) })
      const file = new File(['{}'], 'phrase-drill-backup-2026-08-02.json', { type: 'application/json' })
      await act(async () => chooseRestoreFile(file))

      expect(props.onRestoreFileChosen).toHaveBeenCalledWith(file)
      const sheet = container.querySelector('[data-testid="restore-confirm-sheet"]')
      expect(sheet).not.toBeNull()
      expect(sheet!.textContent).toMatch(/replaces/i)
      expect(sheet!.textContent).not.toMatch(/merge/i)
    })

    it('does not restore anything until the warning is confirmed', async () => {
      const props = renderScreen({ onRestoreFileChosen: vi.fn().mockResolvedValue({ ok: true }) })
      const file = new File(['{}'], 'backup.json', { type: 'application/json' })
      await act(async () => chooseRestoreFile(file))
      expect(props.onConfirmRestore).not.toHaveBeenCalled()
    })

    it('restores through onConfirmRestore when the warning is confirmed', async () => {
      const props = renderScreen({ onRestoreFileChosen: vi.fn().mockResolvedValue({ ok: true }) })
      const file = new File(['{}'], 'backup.json', { type: 'application/json' })
      await act(async () => chooseRestoreFile(file))
      await act(async () => click(container.querySelector('[data-testid="restore-confirm"]')!))
      expect(props.onConfirmRestore).toHaveBeenCalled()
    })

    it('dismisses the warning without restoring when cancelled', async () => {
      const props = renderScreen({ onRestoreFileChosen: vi.fn().mockResolvedValue({ ok: true }) })
      const file = new File(['{}'], 'backup.json', { type: 'application/json' })
      await act(async () => chooseRestoreFile(file))
      await act(async () => click(container.querySelector('[data-testid="restore-cancel"]')!))

      expect(props.onConfirmRestore).not.toHaveBeenCalled()
      expect(props.onCancelRestore).toHaveBeenCalled()
      expect(container.querySelector('[data-testid="restore-confirm-sheet"]')).toBeNull()
    })

    it('refuses a malformed or wrong-format file with a plain explanation, and never shows the replace warning for it', async () => {
      const props = renderScreen({
        onRestoreFileChosen: vi.fn().mockResolvedValue({ ok: false, reason: 'wrong-format' }),
      })
      const file = new File(['not a backup'], 'notes.txt', { type: 'text/plain' })
      await act(async () => chooseRestoreFile(file))

      expect(container.querySelector('[data-testid="restore-confirm-sheet"]')).toBeNull()
      expect(props.onConfirmRestore).not.toHaveBeenCalled()
      const error = container.querySelector('[data-testid="restore-error"]')
      expect(error).not.toBeNull()
      expect(error!.textContent).toMatch(/couldn't|doesn't look|not a backup|wasn't able/i)
    })

    it('refuses unreadable JSON with a plain explanation too', async () => {
      renderScreen({
        onRestoreFileChosen: vi.fn().mockResolvedValue({ ok: false, reason: 'not-json' }),
      })
      const file = new File(['{{{'], 'broken.json', { type: 'application/json' })
      await act(async () => chooseRestoreFile(file))

      const error = container.querySelector('[data-testid="restore-error"]')
      expect(error).not.toBeNull()
    })
  })

  /**
   * T036 — the clip cache is bounded and evicts, so the app has to say what
   * it is holding, what it will throw away, and what she will notice when it
   * does. Every one of those is a thing she would otherwise discover as a
   * phrase that mysteriously went quiet.
   */
  describe('saved audio', () => {
    const USAGE = { bytes: 149_100_000, clipCount: 3190, maxBytes: 209_715_200 }

    it('states how much audio it is holding, against the ceiling', () => {
      renderScreen({ savedAudio: USAGE })
      const usage = container.querySelector('[data-testid="saved-audio-usage"]')
      expect(usage?.textContent).toMatch(/142 MB/)
      expect(usage?.textContent).toMatch(/200 MB/)
      expect(usage?.textContent).toMatch(/3,190/)
    })

    /**
     * The meter is driven by `transform: scaleX()` rather than `width`, so that
     * it composites instead of laying out every frame. That makes the fill a
     * ratio between 0 and 1, not a percentage string, and nothing else in the
     * screen would notice if the two were confused — a `scaleX(71)` reads as a
     * full bar exactly like `scaleX(0.71)` does, because the track clips it.
     */
    it('fills the meter to the fraction of the ceiling actually in use', () => {
      renderScreen({ savedAudio: USAGE })
      const fill = container.querySelector<HTMLElement>('.audio-meter-fill')
      const scale = Number(/scaleX\(([\d.]+)\)/.exec(fill?.style.transform ?? '')?.[1])
      expect(scale).toBeCloseTo(USAGE.bytes / USAGE.maxBytes, 3)
      expect(scale).toBeLessThanOrEqual(1)
    })

    it('never overfills the meter when the cache is over its ceiling', () => {
      renderScreen({ savedAudio: { ...USAGE, bytes: USAGE.maxBytes * 2 } })
      const fill = container.querySelector<HTMLElement>('.audio-meter-fill')
      const scale = Number(/scaleX\(([\d.]+)\)/.exec(fill?.style.transform ?? '')?.[1])
      expect(scale).toBe(1)
    })

    it('says the least-drilled audio goes first, and that her library never does', () => {
      renderScreen({ savedAudio: USAGE })
      const section = container.querySelector('[data-testid="saved-audio-section"]')
      expect(section?.textContent).toMatch(/longest|least/i)
      expect(section?.textContent).toMatch(/never/i)
      expect(section?.textContent).toMatch(/phrases/i)
    })

    it('answers what happens offline when the audio she needs was cleared', () => {
      renderScreen({ savedAudio: USAGE })
      const note = container.querySelector('[data-testid="saved-audio-offline-note"]')
      expect(note?.textContent).toMatch(/offline/i)
      expect(note?.textContent).toMatch(/back|again|online/i)
    })

    it('says it does not know yet rather than showing a fabricated zero', () => {
      renderScreen({ savedAudio: undefined })
      expect(container.querySelector('[data-testid="saved-audio-usage"]')?.textContent).toMatch(
        /checking|working|yet/i,
      )
    })
  })
})
