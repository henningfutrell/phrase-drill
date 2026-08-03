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

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
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
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function renderScreen(overrides: Partial<Parameters<typeof SettingsScreen>[0]> = {}) {
  const props = {
    onBack: vi.fn(),
    anthropicKeyPresent: false,
    elevenLabsKeyPresent: false,
    voice: null,
    onSaveAnthropicKey: vi.fn(),
    onClearAnthropicKey: vi.fn(),
    onSaveElevenLabsKey: vi.fn(),
    onClearElevenLabsKey: vi.fn(),
    voices: VOICES,
    previewText: 'Bonjour, comment ça va ?',
    onPreviewVoice: vi.fn().mockResolvedValue({ ok: true }),
    onChooseVoice: vi.fn(),
    onExportBackup: vi.fn().mockResolvedValue('shared'),
    onRestoreFileChosen: vi.fn().mockResolvedValue({ ok: true }),
    onConfirmRestore: vi.fn().mockResolvedValue(undefined),
    onCancelRestore: vi.fn(),
    onOpenDiagnostics: vi.fn(),
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

  it('shows a calm, non-error explanation when the scan key is absent', () => {
    renderScreen({ anthropicKeyPresent: false })
    expect(container.textContent).not.toMatch(/error|failed/i)
    expect(container.textContent).toContain('No key yet')
  })

  it('shows a calm, non-error explanation when the speech key is absent', () => {
    renderScreen({ elevenLabsKeyPresent: false })
    const status = container.querySelectorAll('.settings-status--calm')
    expect(status.length).toBeGreaterThanOrEqual(2)
  })

  it('states the scan key is workspace-scoped and spend-capped', () => {
    renderScreen()
    expect(container.textContent).toMatch(/workspace/i)
    expect(container.textContent).toMatch(/cap/i)
  })

  it('states the speech key is scoped to text-to-speech with a monthly credit cap', () => {
    renderScreen()
    expect(container.textContent).toMatch(/text-to-speech/i)
    expect(container.textContent).toMatch(/monthly/i)
  })

  it('saves the Anthropic key that was typed, then clears the input', () => {
    const props = renderScreen()
    const input = container.querySelector('[data-testid="anthropic-key-input"]') as HTMLInputElement
    act(() => typeInto(input, 'sk-ant-abc'))
    act(() => click(container.querySelector('[data-testid="anthropic-key-save"]')!))

    expect(props.onSaveAnthropicKey).toHaveBeenCalledWith('sk-ant-abc')
    expect(input.value).toBe('')
  })

  it('disables the Anthropic save button until something is typed', () => {
    renderScreen()
    const save = container.querySelector('[data-testid="anthropic-key-save"]') as HTMLButtonElement
    expect(save.disabled).toBe(true)
  })

  it('disables the Anthropic clear button when no key is present, enables it when one is', () => {
    renderScreen({ anthropicKeyPresent: false })
    expect((container.querySelector('[data-testid="anthropic-key-clear"]') as HTMLButtonElement).disabled).toBe(
      true,
    )

    renderScreen({ anthropicKeyPresent: true })
    expect((container.querySelector('[data-testid="anthropic-key-clear"]') as HTMLButtonElement).disabled).toBe(
      false,
    )
  })

  it('clears the Anthropic key on tap', () => {
    const props = renderScreen({ anthropicKeyPresent: true })
    act(() => click(container.querySelector('[data-testid="anthropic-key-clear"]')!))
    expect(props.onClearAnthropicKey).toHaveBeenCalled()
  })

  it('saves the ElevenLabs key that was typed, then clears the input', () => {
    const props = renderScreen()
    const input = container.querySelector('[data-testid="elevenlabs-key-input"]') as HTMLInputElement
    act(() => typeInto(input, 'el-key-abc'))
    act(() => click(container.querySelector('[data-testid="elevenlabs-key-save"]')!))

    expect(props.onSaveElevenLabsKey).toHaveBeenCalledWith('el-key-abc')
    expect(input.value).toBe('')
  })

  it('clears the ElevenLabs key on tap', () => {
    const props = renderScreen({ elevenLabsKeyPresent: true })
    act(() => click(container.querySelector('[data-testid="elevenlabs-key-clear"]')!))
    expect(props.onClearElevenLabsKey).toHaveBeenCalled()
  })

  it('never renders a saved key value anywhere in the DOM', () => {
    renderScreen({ anthropicKeyPresent: true, elevenLabsKeyPresent: true })
    // The screen only ever receives booleans for "present" — it has no key
    // value to leak. Guard the contract: no input carries a pre-filled value.
    const anthropicInput = container.querySelector('[data-testid="anthropic-key-input"]') as HTMLInputElement
    const elevenLabsInput = container.querySelector('[data-testid="elevenlabs-key-input"]') as HTMLInputElement
    expect(anthropicInput.value).toBe('')
    expect(elevenLabsInput.value).toBe('')
    expect(anthropicInput.type).toBe('password')
    expect(elevenLabsInput.type).toBe('password')
  })

  it('states plainly that a key is never put in a URL, logged, or exported', () => {
    renderScreen()
    expect(container.textContent).toMatch(/never/i)
    expect(container.textContent).toMatch(/backup|export/i)
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
      const props = renderScreen({ previewText: 'Où est la gare ?', elevenLabsKeyPresent: true })
      await act(async () => click(container.querySelector('[data-testid="voice-preview-voice-rachel"]')!))

      expect(props.onPreviewVoice).toHaveBeenCalledTimes(1)
      const [voiceArg, textArg] = vi.mocked(props.onPreviewVoice).mock.calls[0]!
      expect(voiceArg).toEqual({ modelId: 'eleven_multilingual_v2', voiceId: 'voice-rachel' })
      expect(textArg).toBe('Où est la gare ?')
    })

    it('passes a fresh AbortSignal to each preview', async () => {
      const props = renderScreen({ elevenLabsKeyPresent: true })
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
      renderScreen({ onPreviewVoice, elevenLabsKeyPresent: true })

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
      renderScreen({ onPreviewVoice, elevenLabsKeyPresent: true })
      act(() => click(container.querySelector('[data-testid="voice-preview-voice-rachel"]')!))

      act(() => root.unmount())

      expect(capturedSignal?.aborted).toBe(true)
    })

    it('shows a plain-language error inline when a preview fails, without blocking the screen', async () => {
      renderScreen({ onPreviewVoice: vi.fn().mockResolvedValue({ ok: false, reason: 'network' }), elevenLabsKeyPresent: true })
      await act(async () => click(container.querySelector('[data-testid="voice-preview-voice-rachel"]')!))
      await flush()

      const error = container.querySelector('[data-testid="voice-preview-error"]')
      expect(error).not.toBeNull()
      expect(error!.textContent).not.toMatch(/error|failed/i)
    })

    it('disables preview when no speech key is saved yet, and says why', () => {
      renderScreen({ elevenLabsKeyPresent: false })
      const preview = container.querySelector('[data-testid="voice-preview-voice-rachel"]') as HTMLButtonElement
      expect(preview.disabled).toBe(true)
      expect(container.querySelector('[data-testid="voice-preview-needs-key"]')).not.toBeNull()
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
      expect(section?.textContent).toMatch(/phone/i)
      expect(section?.textContent).toMatch(/gone|lost|clear/i)
    })

    it('states that saved audio is not part of the backup and regenerates on its own', () => {
      renderScreen()
      const section = container.querySelector('[data-testid="backup-section"]')
      expect(section?.textContent).toMatch(/audio/i)
      expect(section?.textContent).toMatch(/regenerat|again|automatically/i)
    })

    it('exports through onExportBackup when the export button is tapped', async () => {
      const props = renderScreen()
      await act(async () => click(container.querySelector('[data-testid="export-backup"]')!))
      expect(props.onExportBackup).toHaveBeenCalled()
    })

    it('confirms once the export has gone through the share sheet', async () => {
      renderScreen({ onExportBackup: vi.fn().mockResolvedValue('shared') })
      await act(async () => click(container.querySelector('[data-testid="export-backup"]')!))
      expect(container.querySelector('[data-testid="export-status"]')?.textContent).toMatch(/shar/i)
    })

    it('tells her where to look when the share sheet is not available and it fell back to a download', async () => {
      renderScreen({ onExportBackup: vi.fn().mockResolvedValue('downloaded') })
      await act(async () => click(container.querySelector('[data-testid="export-backup"]')!))
      expect(container.querySelector('[data-testid="export-status"]')?.textContent).toMatch(
        /download|files/i,
      )
    })

    it('says nothing alarming when she cancels out of the share sheet', async () => {
      renderScreen({ onExportBackup: vi.fn().mockResolvedValue('cancelled') })
      await act(async () => click(container.querySelector('[data-testid="export-backup"]')!))
      expect(container.textContent).not.toMatch(/error|failed/i)
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
})
