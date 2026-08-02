import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsScreen } from './SettingsScreen'

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
    ...overrides,
  }
  act(() => {
    root.render(<SettingsScreen {...props} />)
  })
  return props
}

describe('SettingsScreen', () => {
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

  it('displays the pinned voice when one is set', () => {
    renderScreen({
      voice: { provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-1' },
    })
    const display = container.querySelector('[data-testid="voice-display"]')
    expect(display?.textContent).toContain('elevenlabs')
    expect(display?.textContent).toContain('eleven_multilingual_v2')
    expect(display?.textContent).toContain('voice-1')
  })

  it('warns that changing the voice regenerates every clip, when a voice is set', () => {
    renderScreen({
      voice: { provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-1' },
    })
    expect(container.textContent).toMatch(/regenerat/i)
  })

  it('shows a calm explanation, not an error, when no voice is pinned yet', () => {
    renderScreen({ voice: null })
    const display = container.querySelector('[data-testid="voice-display"]')
    expect(display?.textContent).not.toMatch(/error|failed/i)
    expect(display?.textContent).toMatch(/not|no voice/i)
  })

  it('calls onBack when the back control is tapped', () => {
    const props = renderScreen()
    act(() => click(container.querySelector('[data-testid="settings-back"]')!))
    expect(props.onBack).toHaveBeenCalled()
  })
})
