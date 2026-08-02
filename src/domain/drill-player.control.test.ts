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

    await player.skip()

    expect(player.status).toBe('stopped')
  })
})
