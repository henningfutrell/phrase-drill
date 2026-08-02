import { vi } from 'vitest'
import type { ClockPort, Language, SpeechPort } from './ports'

export interface FakeClock extends ClockPort {
  readonly waitCalls: number[]
}

/** A ClockPort backed by real (fake-timer-controlled) setTimeout, honouring abort. */
export function fakeClock(): FakeClock {
  const waitCalls: number[] = []
  return {
    waitCalls,
    wait(ms, signal) {
      waitCalls.push(ms)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms)
        const onAbort = () => {
          clearTimeout(timer)
          reject(new Error('aborted'))
        }
        if (signal) {
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }
      })
    },
  }
}

export interface FakeSpeech extends SpeechPort {
  readonly calls: Array<{ text: string; lang: Language }>
  readonly cancelledCount: number
}

/** A SpeechPort whose speak() resolves on the next microtask — no Web Speech mock. */
export function instantSpeech(): FakeSpeech {
  const calls: Array<{ text: string; lang: Language }> = []
  let cancelledCount = 0
  return {
    calls,
    get cancelledCount() {
      return cancelledCount
    },
    speak(text, lang) {
      calls.push({ text, lang })
      return Promise.resolve()
    },
    cancel() {
      cancelledCount += 1
    },
  }
}

export interface ControllableSpeech extends FakeSpeech {
  resolveCurrent(): void
}

/** A SpeechPort whose speak() stays pending until the test resolves or cancels it. */
export function controllableSpeech(): ControllableSpeech {
  const calls: Array<{ text: string; lang: Language }> = []
  let cancelledCount = 0
  let pending: (() => void) | null = null
  return {
    calls,
    get cancelledCount() {
      return cancelledCount
    },
    speak(text, lang) {
      calls.push({ text, lang })
      return new Promise((resolve) => {
        pending = resolve
      })
    },
    cancel() {
      cancelledCount += 1
      pending?.()
      pending = null
    },
    resolveCurrent() {
      pending?.()
      pending = null
    },
  }
}

/** Flush pending microtasks (promise resolutions) without advancing fake timers. */
export async function flushMicrotasks(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}
