import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDrillPlayer } from './drill-player'
import type { Phrase } from './phrase'
import {
  controllableSpeech,
  fakeClock,
  flushMicrotasks,
  instantSpeech,
} from './drill-player.test-support'

const bonjour: Phrase = { id: 'p1', french: 'Bonjour', english: 'Hello' }
const merci: Phrase = { id: 'p2', french: 'Merci', english: 'Thank you' }

describe('DrillPlayer control: pause, resume, skip, stop', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('pause cancels the in-flight utterance and resume replays that same step', async () => {
    const speech = controllableSpeech()
    const clock = fakeClock()
    const player = createDrillPlayer([bonjour], { speech, clock })

    const done = player.start()
    await flushMicrotasks()
    expect(speech.calls).toEqual([{ text: 'Bonjour', lang: 'fr-FR' }])

    player.pause()
    await flushMicrotasks()

    expect(player.status).toBe('paused')
    expect(speech.cancelledCount).toBe(1)
    expect(speech.calls).toHaveLength(1) // no further steps started while paused

    void player.resume()
    await flushMicrotasks()

    expect(player.status).toBe('playing')
    expect(speech.calls).toHaveLength(2) // the paused step was replayed
    expect(speech.calls[1]).toEqual({ text: 'Bonjour', lang: 'fr-FR' })

    player.stop()
    await done
    expect(player.status).toBe('stopped')
  })

  it('skip cancels a pending speak and moves straight to the next Phrase, with nothing orphaned', async () => {
    const speech = controllableSpeech()
    const clock = fakeClock()
    const player = createDrillPlayer([bonjour, merci], { speech, clock })

    const done = player.start()
    await flushMicrotasks()
    expect(speech.calls).toEqual([{ text: 'Bonjour', lang: 'fr-FR' }])
    expect(player.position).toBe(0)

    await player.skip()
    await flushMicrotasks()

    expect(speech.cancelledCount).toBe(1)
    expect(player.position).toBe(1)
    expect(speech.calls[1]).toEqual({ text: 'Merci', lang: 'fr-FR' })

    player.stop()
    await done
  })

  it('skip during a pause step clears the pending timer — no orphaned timer', async () => {
    const speech = instantSpeech()
    const clock = fakeClock()
    const player = createDrillPlayer([bonjour, merci], { speech, clock })

    const done = player.start()
    // Let the first utterance (instant) settle and the pause step's timer get scheduled.
    await flushMicrotasks()
    expect(clock.waitCalls).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)

    await player.skip()

    expect(vi.getTimerCount()).toBe(0)
    expect(player.position).toBe(1)

    player.stop()
    await done
  })

  it('stop cancels the in-flight step immediately and leaves no pending timer', async () => {
    const speech = instantSpeech()
    const clock = fakeClock()
    const player = createDrillPlayer([bonjour], { speech, clock })

    const done = player.start()
    await flushMicrotasks() // first utterance done, pause timer now pending
    expect(vi.getTimerCount()).toBe(1)

    player.stop()
    await done

    expect(player.status).toBe('stopped')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('pause is a no-op when not playing, and resume is a no-op when not paused', async () => {
    const speech = instantSpeech()
    const clock = fakeClock()
    const player = createDrillPlayer([bonjour], { speech, clock })

    player.pause() // never started
    expect(player.status).toBe('stopped')

    await player.resume() // never paused
    expect(player.status).toBe('stopped')
  })

  it('skip is a no-op once the Drill has already stopped', async () => {
    const speech = instantSpeech()
    const clock = fakeClock()
    const player = createDrillPlayer([bonjour], { speech, clock })

    const done = player.start()
    await vi.runAllTimersAsync()
    await done
    expect(player.status).toBe('stopped')
    const positionBefore = player.position

    await player.skip()

    expect(player.status).toBe('stopped')
    expect(player.position).toBe(positionBefore) // guard, not the out-of-bounds fallback, keeps this unchanged
  })

  it('start() while paused is a no-op — it does not reset position or restart from the top', async () => {
    const speech = instantSpeech()
    const clock = fakeClock()
    const player = createDrillPlayer([bonjour, merci], { speech, clock })

    const done = player.start()
    await flushMicrotasks()
    await player.skip() // move to position 1
    await flushMicrotasks()
    player.pause()
    await flushMicrotasks()
    expect(player.status).toBe('paused')
    expect(player.position).toBe(1)
    const callsBefore = speech.calls.length

    await player.start() // must no-op: the Drill is paused, not stopped

    expect(player.status).toBe('paused')
    expect(player.position).toBe(1)
    expect(speech.calls.length).toBe(callsBefore)

    player.stop()
    await done
  })

  it('skip while paused advances position without resuming playback, and does not throw', async () => {
    const speech = instantSpeech()
    const clock = fakeClock()
    const player = createDrillPlayer([bonjour, merci], { speech, clock })

    const done = player.start()
    await flushMicrotasks()
    player.pause()
    await flushMicrotasks()
    expect(player.status).toBe('paused')
    const callsBefore = speech.calls.length

    await expect(player.skip()).resolves.toBeUndefined()

    expect(player.position).toBe(1)
    expect(player.status).toBe('paused') // skip does not auto-resume
    expect(speech.calls.length).toBe(callsBefore) // no new speech triggered

    player.stop()
    await done
  })

  it('skip past the final Rep while paused stops the Drill directly', async () => {
    const speech = instantSpeech()
    const clock = fakeClock()
    const player = createDrillPlayer([bonjour], { speech, clock })

    const done = player.start()
    await flushMicrotasks()
    player.pause()
    await flushMicrotasks()
    expect(player.status).toBe('paused')

    await player.skip()

    expect(player.status).toBe('stopped')
    await done
  })

  it('stop() before any start(), and after the Drill has already run to completion, does not throw', async () => {
    const speech = instantSpeech()
    const clock = fakeClock()
    const player = createDrillPlayer([bonjour], { speech, clock })

    expect(() => player.stop()).not.toThrow()

    const done = player.start()
    await vi.runAllTimersAsync()
    await done
    expect(() => player.stop()).not.toThrow()
  })
})
