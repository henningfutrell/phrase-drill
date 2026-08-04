import type { ReactElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DrillScreen, type DrillReadinessResult } from './DrillScreen'
import type { Phrase } from '../domain'
import {
  controllableSpeech,
  fakeClock,
  flushMicrotasks,
  instantSpeech,
} from '../domain/drill-player.test-support'

const bonjour: Phrase = { id: 'p1', french: 'Bonjour', english: 'Hello' }
const merci: Phrase = { id: 'p2', french: 'Merci', english: 'Thank you' }

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

async function settle() {
  await act(async () => {
    await flushMicrotasks()
  })
}

async function click(el: Element | null) {
  if (!el) throw new Error('element not found')
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flushMicrotasks()
  })
}

function testid(id: string): Element | null {
  return container.querySelector(`[data-testid="${id}"]`)
}

function textOf(id: string): string | undefined {
  return testid(id)?.textContent ?? undefined
}

function ready(phrases: Phrase[], skippedCount = 0, online = true): DrillReadinessResult {
  return { ready: phrases, skippedCount, canStart: phrases.length > 0, online }
}

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.useRealTimers()
})

describe('DrillScreen — readiness gate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('shows the start card with the ready phrase count once readiness resolves', async () => {
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour, merci]))}
        speech={instantSpeech()}
        clock={fakeClock()}
        unlock={() => Promise.resolve({ ok: true as const })}
        onExit={() => {}}
      />,
    )
    await settle()

    expect(textOf('drill-title')).toBe('Home')
    expect(textOf('drill-phrase-count')).toBe('2 phrases')
    expect(testid('drill-skipped-count')).toBeNull()
  })

  it('states the excluded count plainly when some Phrases have no audio yet', async () => {
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour], 3))}
        speech={instantSpeech()}
        clock={fakeClock()}
        unlock={() => Promise.resolve({ ok: true as const })}
        onExit={() => {}}
      />,
    )
    await settle()

    expect(textOf('drill-skipped-count')).toBe('3 phrases have no audio yet — skipped')
  })

  it('refuses to start and explains why when no voice has been chosen', async () => {
    const onOpenSettings = vi.fn()
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() =>
          Promise.resolve({ ready: [], skippedCount: 2, canStart: false, reason: 'no-voice', online: true })
        }
        speech={instantSpeech()}
        clock={fakeClock()}
        unlock={() => Promise.resolve({ ok: true as const })}
        onExit={() => {}}
        onOpenSettings={onOpenSettings}
      />,
    )
    await settle()

    expect(testid('drill-start-card')).toBeNull()
    expect(textOf('drill-blocked')).toMatch(/voice/i)
    await click(testid('drill-open-settings'))
    expect(onOpenSettings).toHaveBeenCalled()
  })

  it('refuses to start and explains why when audio is still being made', async () => {
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() =>
          Promise.resolve({ ready: [], skippedCount: 2, canStart: false, reason: 'none-ready', online: true })
        }
        speech={instantSpeech()}
        clock={fakeClock()}
        unlock={() => Promise.resolve({ ok: true as const })}
        onExit={() => {}}
      />,
    )
    await settle()

    expect(textOf('drill-blocked')).toMatch(/isn't ready|not ready|still being made/i)
    expect(testid('drill-open-settings')).toBeNull()
  })

  /**
   * T036 — audio can now be cleared to keep the cache under its ceiling, so
   * "no audio" offline is not "it is still being made." Saying so would be a
   * lie she would sit and wait on.
   */
  it('does not claim audio is on its way when there is no network to fetch it over', async () => {
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() =>
          Promise.resolve({ ready: [], skippedCount: 2, canStart: false, reason: 'none-ready', online: false })
        }
        speech={instantSpeech()}
        clock={fakeClock()}
        unlock={() => Promise.resolve({ ok: true as const })}
        onExit={() => {}}
      />,
    )
    await settle()

    const blocked = textOf('drill-blocked') ?? ''
    expect(blocked).toMatch(/online|connect/i)
    expect(blocked).not.toMatch(/still being made|in a moment/i)
    // And it says the thing that actually matters: nothing of hers was lost.
    expect(blocked).toMatch(/phrases are safe|nothing.*lost/i)
  })

  it('says an excluded Phrase is waiting on a connection, not on generation, while offline', async () => {
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour], 3, false))}
        speech={instantSpeech()}
        clock={fakeClock()}
        unlock={() => Promise.resolve({ ok: true as const })}
        onExit={() => {}}
      />,
    )
    await settle()

    const skipped = textOf('drill-skipped-count') ?? ''
    expect(skipped).toMatch(/3 phrases/)
    expect(skipped).toMatch(/online|connect/i)
  })

  it('only hands ready Phrases to the Drill — never the excluded ones', async () => {
    const speech = instantSpeech()
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour], 1))}
        speech={speech}
        clock={fakeClock()}
        unlock={() => Promise.resolve({ ok: true as const })}
        onExit={() => {}}
      />,
    )
    await settle()
    await click(testid('drill-start'))
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(speech.calls.every((c) => c.text === 'Bonjour' || c.text === 'Hello')).toBe(true)
  })
})

describe('DrillScreen — the one-tap unlock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('unlocks before starting playback', async () => {
    const calls: string[] = []
    const speech = instantSpeech()
    const unlock = vi.fn(async () => {
      calls.push('unlock')
      return { ok: true as const }
    })
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour]))}
        speech={{
          ...speech,
          speak: (text, lang) => {
            calls.push('speak')
            return speech.speak(text, lang)
          },
        }}
        clock={fakeClock()}
        unlock={unlock}
        onExit={() => {}}
      />,
    )
    await settle()
    await click(testid('drill-start'))

    expect(unlock).toHaveBeenCalled()
    expect(calls.indexOf('unlock')).toBeLessThan(calls.indexOf('speak'))
  })

  it('shows a clear message and never starts the Drill when unlock fails', async () => {
    const speech = instantSpeech()
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour]))}
        speech={speech}
        clock={fakeClock()}
        unlock={() => Promise.resolve({ ok: false as const, name: 'NotAllowedError', message: 'blocked' })}
        onExit={() => {}}
      />,
    )
    await settle()
    await click(testid('drill-start'))

    expect(testid('drill-unlock-error')).not.toBeNull()
    expect(testid('drill-running')).toBeNull()
    expect(speech.calls).toEqual([])
  })

  it('disables Start Drill while its own tap is unlocking, and re-enables it after a failure so she can retry (T001)', async () => {
    let resolveUnlock: ((outcome: { ok: false; name: string; message: string }) => void) | undefined
    const unlock = vi.fn(
      () =>
        new Promise<{ ok: false; name: string; message: string }>((resolve) => {
          resolveUnlock = resolve
        }),
    )
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour]))}
        speech={instantSpeech()}
        clock={fakeClock()}
        unlock={unlock}
        onExit={() => {}}
      />,
    )
    await settle()

    const button = testid('drill-start') as HTMLButtonElement
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await flushMicrotasks()
    })

    expect(button.disabled).toBe(true)

    await act(async () => {
      resolveUnlock?.({ ok: false, name: 'NotAllowedError', message: 'blocked' })
      await flushMicrotasks()
    })

    expect(button.disabled).toBe(false)
    expect(testid('drill-unlock-error')).not.toBeNull()

    // Re-tappable: a second tap invokes unlock() again rather than being
    // permanently dead.
    await click(testid('drill-start'))
    expect(unlock).toHaveBeenCalledTimes(2)
  })
})

describe('DrillScreen — running a Drill', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('shows the current line and Rep counter, and advances the beat row through the Cadence', async () => {
    const speech = controllableSpeech()
    const clock = fakeClock()
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour, merci]))}
        speech={speech}
        clock={clock}
        unlock={() => Promise.resolve({ ok: true as const })}
        onExit={() => {}}
      />,
    )
    await settle()
    await click(testid('drill-start'))

    expect(textOf('drill-current-line')).toBe('Bonjour')
    expect(textOf('drill-rep-counter')).toBe('Rep 1 of 2')
    expect(testid('drill-beat-0')?.getAttribute('data-state')).toBe('live')
    expect(testid('drill-beat-1')?.getAttribute('data-state')).toBe('upcoming')

    // First utterance ends, pause step starts (2nd beat still index 0's pause half).
    await act(async () => {
      speech.resolveCurrent()
      await flushMicrotasks()
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    // Second utterance (still "Bonjour") now live — beat 1.
    expect(testid('drill-beat-1')?.getAttribute('data-state')).toBe('live')
    expect(testid('drill-beat-0')?.getAttribute('data-state')).toBe('done')

    await act(async () => {
      speech.resolveCurrent()
      await flushMicrotasks()
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    // Third utterance is English.
    expect(textOf('drill-current-line')).toBe('Hello')
    expect(testid('drill-beat-2')?.getAttribute('data-state')).toBe('live')
  })

  it('Pause cancels the in-flight utterance; the control relabels to Resume', async () => {
    const speech = controllableSpeech()
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour]))}
        speech={speech}
        clock={fakeClock()}
        unlock={() => Promise.resolve({ ok: true as const })}
        onExit={() => {}}
      />,
    )
    await settle()
    await click(testid('drill-start'))

    expect(textOf('drill-pause-resume')).toBe('Pause')
    await click(testid('drill-pause-resume'))

    expect(speech.cancelledCount).toBe(1)
    expect(textOf('drill-pause-resume')).toBe('Resume')
  })

  it('Resume replays the paused step', async () => {
    const speech = controllableSpeech()
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour]))}
        speech={speech}
        clock={fakeClock()}
        unlock={() => Promise.resolve({ ok: true as const })}
        onExit={() => {}}
      />,
    )
    await settle()
    await click(testid('drill-start'))
    await click(testid('drill-pause-resume'))
    expect(speech.calls).toHaveLength(1)

    await click(testid('drill-pause-resume'))

    expect(speech.calls).toHaveLength(2)
    expect(textOf('drill-pause-resume')).toBe('Pause')
  })

  it('Skip moves straight to the next Phrase', async () => {
    const speech = controllableSpeech()
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour, merci]))}
        speech={speech}
        clock={fakeClock()}
        unlock={() => Promise.resolve({ ok: true as const })}
        onExit={() => {}}
      />,
    )
    await settle()
    await click(testid('drill-start'))
    expect(textOf('drill-rep-counter')).toBe('Rep 1 of 2')

    await click(testid('drill-skip'))

    expect(textOf('drill-rep-counter')).toBe('Rep 2 of 2')
    expect(textOf('drill-current-line')).toBe('Merci')
  })

  it('Stop ends the Drill immediately and hands control back', async () => {
    const speech = controllableSpeech()
    const onExit = vi.fn()
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour]))}
        speech={speech}
        clock={fakeClock()}
        unlock={() => Promise.resolve({ ok: true as const })}
        onExit={onExit}
      />,
    )
    await settle()
    await click(testid('drill-start'))

    await click(testid('drill-stop'))

    expect(onExit).toHaveBeenCalled()
  })

  it('hands control back on its own once every Rep has played', async () => {
    const speech = instantSpeech()
    const clock = fakeClock()
    const onExit = vi.fn()
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour]))}
        speech={speech}
        clock={clock}
        unlock={() => Promise.resolve({ ok: true as const })}
        onExit={onExit}
      />,
    )
    await settle()
    await click(testid('drill-start'))
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(onExit).toHaveBeenCalled()
  })
})

describe('DrillScreen — Wake Lock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('acquires a Wake Lock once the Drill starts and releases it on Stop', async () => {
    const acquireWakeLock = vi.fn().mockResolvedValue(undefined)
    const releaseWakeLock = vi.fn().mockResolvedValue(undefined)
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour]))}
        speech={controllableSpeech()}
        clock={fakeClock()}
        unlock={() => Promise.resolve({ ok: true as const })}
        onExit={() => {}}
        acquireWakeLock={acquireWakeLock}
        releaseWakeLock={releaseWakeLock}
      />,
    )
    await settle()
    await click(testid('drill-start'))
    expect(acquireWakeLock).toHaveBeenCalledTimes(1)
    expect(releaseWakeLock).not.toHaveBeenCalled()

    await click(testid('drill-stop'))
    expect(releaseWakeLock).toHaveBeenCalledTimes(1)
  })

  it('never crashes when no Wake Lock port is supplied', async () => {
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour]))}
        speech={controllableSpeech()}
        clock={fakeClock()}
        unlock={() => Promise.resolve({ ok: true as const })}
        onExit={() => {}}
      />,
    )
    await settle()
    await click(testid('drill-start'))
    await click(testid('drill-stop'))
    // no throw is the assertion
  })
})

describe('DrillScreen — interrupted by screen lock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  })

  afterEach(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  })

  it('freezes and shows Tap to resume when the screen locks mid-drill, and resumes on tap', async () => {
    const speech = controllableSpeech()
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour]))}
        speech={speech}
        clock={fakeClock()}
        unlock={() => Promise.resolve({ ok: true as const })}
        onExit={() => {}}
      />,
    )
    await settle()
    await click(testid('drill-start'))
    expect(speech.calls).toHaveLength(1)

    await act(async () => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
      document.dispatchEvent(new Event('visibilitychange'))
      await flushMicrotasks()
    })

    expect(textOf('drill-interrupted-banner')).toBe('Drill paused when your screen locked.')
    expect(textOf('drill-pause-resume')).toBe('Tap to resume')
    expect(speech.cancelledCount).toBe(1)

    await click(testid('drill-pause-resume'))

    expect(testid('drill-interrupted-banner')).toBeNull()
    expect(speech.calls).toHaveLength(2)
  })
})

describe('DrillScreen — a failed unlock names the real cause', () => {
  it('renders the DOMException name and message, not a blanket "this phone" verdict', async () => {
    vi.useFakeTimers()
    // The blanket message shipped for a release and blamed every device for a
    // malformed unlock WAV. NotAllowedError (iOS autoplay refusal) and
    // NotSupportedError (undecodable source) need opposite fixes and must be
    // distinguishable from a screenshot.
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour]))}
        speech={instantSpeech()}
        clock={fakeClock()}
        unlock={() =>
          Promise.resolve({
            ok: false as const,
            name: 'NotSupportedError',
            message: 'The operation is not supported.',
          })
        }
        onExit={() => {}}
      />,
    )
    await settle()
    await click(testid('drill-start'))

    const detail = testid('drill-unlock-error-detail')
    expect(detail?.textContent).toContain('NotSupportedError')
    expect(detail?.textContent).toContain('The operation is not supported.')
  })
})
