import type { Step, Utterance } from './cadence'
import type { ClockPort, SpeechPort } from './ports'

export interface StepPorts {
  readonly speech: SpeechPort
  readonly clock: ClockPort
}

/**
 * Executes one Step against the ports — `speak` for an Utterance, `wait` for
 * a Pause — settling once it finishes or `signal` aborts it. Never rejects:
 * an abort is a normal early return, not an error.
 */
export async function runStep(
  step: Step,
  ports: StepPorts,
  signal: AbortSignal,
): Promise<void> {
  if (step.kind === 'pause') {
    try {
      await ports.clock.wait(step.ms, signal)
    } catch {
      // Cancelled by pause, skip, or stop — not an error.
    }
    return
  }
  await runUtterance(step, ports, signal)
}

/**
 * Never blocks past an abort — calling `cancel()` and resolving immediately
 * is what keeps skip/stop from leaving a pending `speak()` behind, even if
 * the adapter's promise never settles.
 */
function runUtterance(
  step: Utterance,
  ports: StepPorts,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      ports.speech.cancel()
      resolve()
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    ports.speech.speak(step.text, step.lang).finally(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    })
  })
}
