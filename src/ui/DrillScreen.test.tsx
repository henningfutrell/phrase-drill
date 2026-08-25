import type { ReactElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DrillScreen, type DrillReadinessResult } from './DrillScreen'
import type { Phrase, SpeechPort } from '../domain'
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
   * lie the user would sit and wait on.
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
    // And it says the thing that actually matters: nothing of theirs was lost.
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

  it('disables Start Drill while its own tap is unlocking, and re-enables it after a failure so the user can retry (T001)', async () => {
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

  /**
   * Defect 3: `starting` is React state, read from the render closure. Two
   * taps dispatched in the same synchronous tick both run against the same
   * closure — `starting` is still `false` for both — and `disabled` on the
   * button only takes effect after the next render, which hasn't happened
   * yet either. A real phone can't deliver two taps inside one task (React
   * flushes a discrete event synchronously), so this isn't what produced any
   * reported symptom — it's hardened anyway, with a ref checked
   * synchronously, because it costs nothing.
   */
  it('does not call unlock twice for two taps landing in the same tick', async () => {
    const unlock = vi.fn(() => Promise.resolve({ ok: true as const }))
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
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await flushMicrotasks()
    })

    expect(unlock).toHaveBeenCalledTimes(1)
  })

  it('proceeds into the Drill when unlock resolves ok — late, but bounded — after standing in for a stalled play() (T006)', async () => {
    // `unlock` here models what `clip-player.ts`'s own bounded timeout does
    // for real (see clip-player.test.ts): a `play()` that never settles is
    // judged unlocked, not failed, so a Drill the user cannot get any help with
    // still starts rather than dead-ending on an error. This screen needs no
    // special-case code for that — any `unlock()` that eventually resolves
    // `{ ok: true }`, however late, already clears `starting` and moves on
    // to `running` through the existing `finally`. This proves it stays
    // true once the outcome flows from a delayed resolution, not only an
    // immediate one.
    let resolveUnlock: (() => void) | undefined
    const unlock = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveUnlock = () => resolve({ ok: true })
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
      resolveUnlock?.()
      await flushMicrotasks()
    })

    expect(testid('drill-running')).not.toBeNull()
    expect(testid('drill-unlock-error')).toBeNull()
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

describe('DrillScreen — the beat row survives a pause/resume replay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  /**
   * Defect 1: `drill-player.ts` re-plays the in-flight cadence Step on
   * resume (pause aborts and breaks the loop without calling
   * `advanceStep()`); `resume()` re-enters at the unchanged position. The
   * old `instrumentPorts` counted that replay as a brand-new Step, so its
   * home-grown `stepCounter` ran one ahead of the real cadence position for
   * the rest of the Rep — here, the pause after "Bonjour" (real cadence
   * index 1, which floors to beat 0) rendered as beat 1.
   */
  it('does not double-count a Step replayed by resume after a Pause', async () => {
    const speech = controllableSpeech()
    const clock = fakeClock()
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour]))}
        speech={speech}
        clock={clock}
        unlock={() => Promise.resolve({ ok: true as const })}
        onExit={() => {}}
      />,
    )
    await settle()
    await click(testid('drill-start'))
    expect(testid('drill-beat-0')?.getAttribute('data-state')).toBe('live')

    // Pause mid-utterance, then Resume — the domain player replays the same
    // "Bonjour" Step (drill-player.ts:85-92,182-189).
    await click(testid('drill-pause-resume'))
    await click(testid('drill-pause-resume'))
    expect(speech.calls).toHaveLength(2) // the replay really happened

    // Still the first utterance's beat — nothing has advanced yet.
    expect(testid('drill-beat-0')?.getAttribute('data-state')).toBe('live')
    expect(testid('drill-beat-1')?.getAttribute('data-state')).toBe('upcoming')

    // Let the replayed utterance finish — the player genuinely advances to
    // its next Step, the pause after "Bonjour" (real cadence index 1, which
    // still floors to beat 0).
    await act(async () => {
      speech.resolveCurrent()
      await flushMicrotasks()
    })

    expect(testid('drill-beat-0')?.getAttribute('data-state')).toBe('live')
    expect(testid('drill-beat-1')?.getAttribute('data-state')).toBe('upcoming')
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

/**
 * The Route hold (T004): a second `<audio>` element looping an inaudible
 * source so the phone's Bluetooth output route never goes idle across a
 * Pause. This screen owns its lifetime — it brackets the Drill from outside
 * and the domain never learns of it.
 */
describe('DrillScreen — the Route hold', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  })

  afterEach(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  })

  it('starts the hold inside the Start tap, after unlock() is called and without awaiting it', async () => {
    // Ordering, not merely presence. Both play() calls have to be *initiated*
    // in the gesture — an `await` between them loses it on iOS — and the
    // shared Clip element must claim the gesture first, because if iOS
    // honours only one play() per tap, silent audio is worse than choppy.
    const order: string[] = []
    let finishUnlock: ((outcome: { ok: true }) => void) | undefined
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour]))}
        speech={controllableSpeech()}
        clock={fakeClock()}
        unlock={() => {
          order.push('unlock')
          return new Promise((resolve) => {
            finishUnlock = resolve
          })
        }}
        holdAudioRoute={() => order.push('hold')}
        releaseAudioRoute={() => order.push('release')}
        onExit={() => {}}
      />,
    )
    await settle()
    await click(testid('drill-start'))

    // unlock() has not resolved yet, and the hold has already started.
    expect(order).toEqual(['unlock', 'hold'])

    await act(async () => {
      finishUnlock?.({ ok: true })
      await flushMicrotasks()
    })

    expect(order).toEqual(['unlock', 'hold'])
  })

  it('releases the hold when the Drill stops', async () => {
    const holdAudioRoute = vi.fn()
    const releaseAudioRoute = vi.fn()
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour]))}
        speech={controllableSpeech()}
        clock={fakeClock()}
        unlock={() => Promise.resolve({ ok: true as const })}
        holdAudioRoute={holdAudioRoute}
        releaseAudioRoute={releaseAudioRoute}
        onExit={() => {}}
      />,
    )
    await settle()
    await click(testid('drill-start'))
    expect(holdAudioRoute).toHaveBeenCalledTimes(1)
    expect(releaseAudioRoute).not.toHaveBeenCalled()

    await click(testid('drill-stop'))
    expect(releaseAudioRoute).toHaveBeenCalledTimes(1)
  })

  it('releases the hold when unlock refuses, so a failed Start leaves nothing playing', async () => {
    const releaseAudioRoute = vi.fn()
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour]))}
        speech={instantSpeech()}
        clock={fakeClock()}
        unlock={() =>
          Promise.resolve({ ok: false as const, name: 'NotAllowedError', message: 'refused' })
        }
        holdAudioRoute={() => {}}
        releaseAudioRoute={releaseAudioRoute}
        onExit={() => {}}
      />,
    )
    await settle()
    await click(testid('drill-start'))

    expect(testid('drill-unlock-error')).not.toBeNull()
    expect(releaseAudioRoute).toHaveBeenCalledTimes(1)
  })

  it('releases the hold if the screen is discarded mid-Drill', async () => {
    // Not reachable from any control here — the running phase renders
    // Skip/Pause/Stop only. It is reachable from a 401 on any /api call,
    // which re-renders the root to the login screen underneath this tree.
    const releaseAudioRoute = vi.fn()
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour]))}
        speech={controllableSpeech()}
        clock={fakeClock()}
        unlock={() => Promise.resolve({ ok: true as const })}
        holdAudioRoute={() => {}}
        releaseAudioRoute={releaseAudioRoute}
        onExit={() => {}}
      />,
    )
    await settle()
    await click(testid('drill-start'))
    expect(releaseAudioRoute).not.toHaveBeenCalled()

    const discarded = container
    await act(async () => {
      root.unmount()
    })
    discarded.remove()

    expect(releaseAudioRoute).toHaveBeenCalledTimes(1)

    // Leave a live root behind for the shared afterEach to unmount.
    render(<div />)
  })

  it('does not release the hold on an unrelated re-render — the prop is a fresh arrow every time', async () => {
    // App.tsx wires this the way it wires acquireWakeLock: a new closure on
    // every render. An unmount effect keyed on that identity would tear the
    // hold down mid-Drill on any App state change.
    const releaseAudioRoute = vi.fn()
    const screen = (): ReactElement => (
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour]))}
        speech={controllableSpeech()}
        clock={fakeClock()}
        unlock={() => Promise.resolve({ ok: true as const })}
        holdAudioRoute={() => {}}
        releaseAudioRoute={() => releaseAudioRoute()}
        onExit={() => {}}
      />
    )
    render(screen())
    await settle()
    await click(testid('drill-start'))

    await act(async () => {
      root.render(screen())
      await flushMicrotasks()
    })

    expect(releaseAudioRoute).not.toHaveBeenCalled()
  })

  it('releases the hold when the app is backgrounded, and takes it again on Resume', async () => {
    // Deliberately unlike the Wake Lock, which this screen does NOT release
    // on this path: iOS has suspended the element anyway, so a hold that
    // claims to be held here would be a lie in the Diagnostic report — and
    // releasing bounds an orphaned tree to "until the user next backgrounds".
    const holdAudioRoute = vi.fn()
    const releaseAudioRoute = vi.fn()
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour]))}
        speech={controllableSpeech()}
        clock={fakeClock()}
        unlock={() => Promise.resolve({ ok: true as const })}
        holdAudioRoute={holdAudioRoute}
        releaseAudioRoute={releaseAudioRoute}
        onExit={() => {}}
      />,
    )
    await settle()
    await click(testid('drill-start'))
    expect(holdAudioRoute).toHaveBeenCalledTimes(1)

    await act(async () => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
      document.dispatchEvent(new Event('visibilitychange'))
      await flushMicrotasks()
    })

    expect(releaseAudioRoute).toHaveBeenCalledTimes(1)

    await click(testid('drill-pause-resume'))

    expect(holdAudioRoute).toHaveBeenCalledTimes(2)
  })

  it('releases the hold the moment the app is backgrounded', async () => {
    // Split from the combined hidden/Resume test: deleting the release on
    // hidden and deleting the re-hold on Resume both failed that one test,
    // so neither red named which half had gone.
    const releaseAudioRoute = vi.fn()
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour]))}
        speech={controllableSpeech()}
        clock={fakeClock()}
        unlock={() => Promise.resolve({ ok: true as const })}
        holdAudioRoute={() => {}}
        releaseAudioRoute={releaseAudioRoute}
        onExit={() => {}}
      />,
    )
    await settle()
    await click(testid('drill-start'))
    expect(releaseAudioRoute).not.toHaveBeenCalled()

    await act(async () => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
      document.dispatchEvent(new Event('visibilitychange'))
      await flushMicrotasks()
    })

    expect(releaseAudioRoute).toHaveBeenCalledTimes(1)
  })

  it('takes the hold again on Resume — after an iOS suspend the old hold is dead', async () => {
    const holdAudioRoute = vi.fn()
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour]))}
        speech={controllableSpeech()}
        clock={fakeClock()}
        unlock={() => Promise.resolve({ ok: true as const })}
        holdAudioRoute={holdAudioRoute}
        releaseAudioRoute={() => {}}
        onExit={() => {}}
      />,
    )
    await settle()
    await click(testid('drill-start'))
    expect(holdAudioRoute).toHaveBeenCalledTimes(1)

    await click(testid('drill-pause-resume'))
    await click(testid('drill-pause-resume'))

    expect(holdAudioRoute).toHaveBeenCalledTimes(2)
  })

  it('never crashes when no Route hold is supplied', async () => {
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

/**
 * Generation suspension (T004): while a Drill is playing, the Clip-generation
 * queue issues nothing. The traffic it would otherwise be making — four
 * concurrent HTTPS fetches, the MP3 bodies behind them, the digests and the
 * IndexedDB writes that follow — competes with the audio the user is listening to
 * on cellular, and it is not even work for the Drill that is playing: only
 * `ready` Phrases enter a Drill.
 *
 * Suspension is taken twice — synchronously in the Start tap, and again by
 * the effect that watches the running phase — and released once, by that
 * effect's cleanup. `GenerationQueue.suspend()` is an idempotent boolean, so
 * the second take costs nothing; the asymmetry is why every release path
 * needs its own test below.
 */
describe('DrillScreen — Generation suspension', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  })

  afterEach(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  })

  it('suspends generation inside the Start tap, before unlock() has resolved', async () => {
    // The tap's own take, not the running-phase effect's. `setPhase({kind:
    // 'running'})` is scheduled rather than flushed, so an effect-only take
    // lands a scheduler task after the Drill has begun making sound.
    const order: string[] = []
    // The executor form, not `Promise.withResolvers`: this project's
    // `lib` target predates it, so the latter does not compile here.
    let finishUnlock: ((outcome: { ok: true }) => void) | undefined
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour]))}
        speech={controllableSpeech()}
        clock={fakeClock()}
        unlock={() => {
          order.push('unlock')
          return new Promise((resolve) => {
            finishUnlock = resolve
          })
        }}
        suspendGeneration={() => order.push('suspend')}
        resumeGeneration={() => order.push('resume')}
        onExit={() => {}}
      />,
    )
    await settle()
    await click(testid('drill-start'))

    // unlock() has not resolved yet, and generation is already quiet.
    expect(order).toEqual(['unlock', 'suspend'])

    await act(async () => {
      finishUnlock?.({ ok: true })
      await flushMicrotasks()
    })
  })

  it('suspends generation before the first Utterance is spoken', async () => {
    // Split from the tap-ordering test on purpose: this one is about React's
    // flush order rather than the tap's. `player.start()` runs straight
    // through to `speech.speak()` with no yield point, so a take that lived
    // only in the running-phase effect would arrive after the first line.
    const order: string[] = []
    const speech = controllableSpeech()
    const recordingSpeech: SpeechPort = {
      speak(text, lang) {
        order.push('speak')
        return speech.speak(text, lang)
      },
      cancel() {
        speech.cancel()
      },
    }
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour]))}
        speech={recordingSpeech}
        clock={fakeClock()}
        unlock={() => Promise.resolve({ ok: true as const })}
        suspendGeneration={() => order.push('suspend')}
        resumeGeneration={() => order.push('resume')}
        onExit={() => {}}
      />,
    )
    await settle()
    await click(testid('drill-start'))

    expect(order).toContain('speak')
    expect(order.slice(0, order.indexOf('speak'))).toContain('suspend')
  })

  it('resumes generation when unlock refuses, so a failed Start does not quiet the queue for the life of the app', async () => {
    // The tap's take is the only one taken on this path: `phase` goes
    // 'start' → 'start', the running-phase effect never mounts, and no
    // cleanup is ever registered — unmounting the screen releases nothing
    // because there is nothing to release. The queue is App-lifetime, so
    // without an explicit release here one refused unlock stops their library
    // filling until the app is reloaded.
    const resumeGeneration = vi.fn()
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour]))}
        speech={instantSpeech()}
        clock={fakeClock()}
        unlock={() =>
          Promise.resolve({ ok: false as const, name: 'NotAllowedError', message: 'refused' })
        }
        suspendGeneration={() => {}}
        resumeGeneration={resumeGeneration}
        onExit={() => {}}
      />,
    )
    await settle()
    await click(testid('drill-start'))

    expect(testid('drill-start-card')).not.toBeNull()
    expect(resumeGeneration).toHaveBeenCalledTimes(1)
  })

  it('resumes generation exactly once if the screen is discarded mid-Drill', async () => {
    // Not reachable from any control here — the running phase renders
    // Skip/Pause/Stop only. It is reachable from a 401 on any /api call,
    // which renders the login screen into the one root (root-renderer.ts)
    // and unmounts this tree, and from the natural end of a Drill.
    const resumeGeneration = vi.fn()
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour]))}
        speech={controllableSpeech()}
        clock={fakeClock()}
        unlock={() => Promise.resolve({ ok: true as const })}
        suspendGeneration={() => {}}
        resumeGeneration={resumeGeneration}
        onExit={() => {}}
      />,
    )
    await settle()
    await click(testid('drill-start'))
    expect(resumeGeneration).not.toHaveBeenCalled()

    const discarded = container
    await act(async () => {
      root.unmount()
    })
    discarded.remove()

    expect(resumeGeneration).toHaveBeenCalledTimes(1)

    // Leave a live root behind for the shared afterEach to unmount.
    render(<div />)
  })

  it('does not resume and re-take on an unrelated re-render — the props are fresh arrows every time', async () => {
    // App.tsx wires these the way it wires releaseAudioRoute: a new closure
    // on every App render, and App does re-render during a Drill (the sync
    // engine's snapshot subscription, a write failure, settings). An effect
    // keyed on those identities would fire cleanup → resume() → body →
    // suspend() on every one of them, letting four parked Clips into the
    // network mid-Drill.
    const suspendGeneration = vi.fn()
    const resumeGeneration = vi.fn()
    const screen = (): ReactElement => (
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour]))}
        speech={controllableSpeech()}
        clock={fakeClock()}
        unlock={() => Promise.resolve({ ok: true as const })}
        suspendGeneration={() => suspendGeneration()}
        resumeGeneration={() => resumeGeneration()}
        onExit={() => {}}
      />
    )
    render(screen())
    await settle()
    await click(testid('drill-start'))
    suspendGeneration.mockClear()
    resumeGeneration.mockClear()

    await act(async () => {
      root.render(screen())
      await flushMicrotasks()
    })

    expect(resumeGeneration).not.toHaveBeenCalled()
    expect(suspendGeneration).not.toHaveBeenCalled()
  })

  it('does not resume generation when the user pauses mid-Drill', async () => {
    // Deliberately broader than "no request while a Drill is playing": a
    // Pause is a moment inside a Drill the user is about to carry on with, and
    // generating through it wakes the very radio the Route hold exists to
    // keep warm.
    const resumeGeneration = vi.fn()
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour]))}
        speech={controllableSpeech()}
        clock={fakeClock()}
        unlock={() => Promise.resolve({ ok: true as const })}
        suspendGeneration={() => {}}
        resumeGeneration={resumeGeneration}
        onExit={() => {}}
      />,
    )
    await settle()
    await click(testid('drill-start'))
    await click(testid('drill-pause-resume'))
    expect(textOf('drill-pause-resume')).toBe('Resume')

    expect(resumeGeneration).not.toHaveBeenCalled()
  })

  it('does not resume generation when the app is backgrounded mid-Drill', async () => {
    // Deliberately unlike the Route hold, which IS released here: iOS has
    // suspended everything anyway, and generation must not be the one thing
    // left free to wake the radio while the Drill is frozen. The stated
    // consequence: a Drill left backgrounded keeps generation off until the user
    // comes back and stops it.
    const resumeGeneration = vi.fn()
    render(
      <DrillScreen
        title="Home"
        checkReadiness={() => Promise.resolve(ready([bonjour]))}
        speech={controllableSpeech()}
        clock={fakeClock()}
        unlock={() => Promise.resolve({ ok: true as const })}
        suspendGeneration={() => {}}
        resumeGeneration={resumeGeneration}
        onExit={() => {}}
      />,
    )
    await settle()
    await click(testid('drill-start'))

    await act(async () => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
      document.dispatchEvent(new Event('visibilitychange'))
      await flushMicrotasks()
    })
    expect(testid('drill-interrupted-banner')).not.toBeNull()

    expect(resumeGeneration).not.toHaveBeenCalled()
  })
})
