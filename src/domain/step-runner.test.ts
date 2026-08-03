import { describe, expect, it } from 'vitest'
import { runStep } from './step-runner'
import type { Utterance } from './cadence'
import { instantSpeech, controllableSpeech } from './drill-player.test-support'
import type { ClockPort, Language, SpeechPort } from './ports'

const bonjourFr: Utterance = { kind: 'utterance', text: 'Bonjour', lang: 'fr-FR' }

const unusedClock: ClockPort = {
  wait() {
    throw new Error('clock.wait should not be called for an utterance step')
  },
}

/**
 * A minimal AbortSignal stand-in that tracks its own 'abort' listeners,
 * mirroring the real EventTarget contract runStep relies on — including
 * `{ once: true }` auto-removing a listener once it has fired. No Node-only
 * introspection API involved (src/domain/** has no Node types, by design —
 * see AGENTS.md's ports-and-adapters boundary), just the same public shape
 * runUtterance actually calls.
 */
class FakeAbortSignal {
  aborted = false
  private listeners: Array<{ type: string; fn: () => void; once?: boolean }> = []

  listenerCount(): number {
    return this.listeners.length
  }

  addEventListener(type: string, fn: () => void, options?: { once?: boolean }): void {
    this.listeners.push({ type, fn, once: options?.once })
  }

  /** Removes a listener only when both the type string and the function match — same as a real EventTarget. */
  removeEventListener(type: string, fn: () => void): void {
    this.listeners = this.listeners.filter(
      (listener) => !(listener.type === type && listener.fn === fn),
    )
  }

  abort(): void {
    this.aborted = true
    for (const { type, fn, once } of [...this.listeners]) {
      if (type !== 'abort') continue
      fn()
      if (once) this.removeEventListener(type, fn)
    }
  }
}

function asSignal(signal: FakeAbortSignal): AbortSignal {
  return signal as unknown as AbortSignal
}

/**
 * An adapter whose speak() promise never settles, even once cancelled — the
 * worst case runUtterance's own docstring names ("even if the adapter's
 * promise never settles"). Exercises the abort listener's *only* remaining
 * cleanup path: the listener's own `{ once: true }` auto-removal, since the
 * `.finally()` explicit removeEventListener is never reached when the
 * promise never settles.
 */
function neverSettlingSpeech(): SpeechPort & { cancelledCount: number } {
  let cancelledCount = 0
  return {
    get cancelledCount() {
      return cancelledCount
    },
    speak(...args: [text: string, lang: Language]) {
      void args
      return new Promise<void>(() => {
        // Deliberately never resolves or rejects.
      })
    },
    cancel() {
      cancelledCount += 1
    },
  }
}

describe('runStep — utterance steps and their abort contract', () => {
  it('settles immediately without speaking, when the signal is already aborted on entry', async () => {
    const speech = instantSpeech()
    const controller = new AbortController()
    controller.abort()

    await runStep(bonjourFr, { speech, clock: unusedClock }, controller.signal)

    expect(speech.calls).toEqual([]) // speak() never called
    expect(speech.cancelledCount).toBe(1) // cancel() is the abort-on-entry signal
  })

  it('removes its own abort listener once the utterance completes normally — no leak on the happy path', async () => {
    const speech = instantSpeech()
    const signal = new FakeAbortSignal()

    await runStep(bonjourFr, { speech, clock: unusedClock }, asSignal(signal))

    expect(signal.listenerCount()).toBe(0)
  })

  it('the abort listener auto-removes itself once fired — repeated Drill steps do not accumulate listeners', async () => {
    const speech = controllableSpeech()
    const signal = new FakeAbortSignal()

    const done = runStep(bonjourFr, { speech, clock: unusedClock }, asSignal(signal))
    expect(signal.listenerCount()).toBe(1)

    signal.abort()
    await done

    expect(speech.cancelledCount).toBe(1)
    expect(signal.listenerCount()).toBe(0)
  })

  it("does not leak its abort listener even when the adapter's speak() promise never settles after cancel()", async () => {
    const speech = neverSettlingSpeech()
    const signal = new FakeAbortSignal()

    void runStep(bonjourFr, { speech, clock: unusedClock }, asSignal(signal))
    expect(signal.listenerCount()).toBe(1)

    signal.abort()
    await Promise.resolve() // let the abort event's listener run to completion

    expect(speech.cancelledCount).toBe(1)
    // The `.finally()` cleanup is unreachable here (the promise never settles) —
    // only the listener's own `{ once: true }` can have removed it.
    expect(signal.listenerCount()).toBe(0)
  })
})
