import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDrillPlayer } from './drill-player'
import { estimatePauseDuration } from './cadence'
import type { Phrase } from './phrase'
import type { RandomSource } from './shuffle'
import { fakeClock, instantSpeech } from './drill-player.test-support'

function sequenceRandom(values: number[]): RandomSource {
  let i = 0
  return {
    next() {
      const value = values[i]
      i += 1
      return value
    },
  }
}

const bonjour: Phrase = { id: 'p1', french: 'Bonjour', english: 'Hello' }
const merci: Phrase = { id: 'p2', french: 'Merci', english: 'Thank you' }

describe('DrillPlayer playback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('plays the full Cadence for a single Phrase using only the injected ports — no Web Speech mock', async () => {
    const speech = instantSpeech()
    const clock = fakeClock()
    const player = createDrillPlayer([bonjour], { speech, clock })

    const done = player.start()
    await vi.runAllTimersAsync()
    await done

    expect(speech.calls).toEqual([
      { text: 'Bonjour', lang: 'fr-FR' },
      { text: 'Bonjour', lang: 'fr-FR' },
      { text: 'Hello', lang: 'en-US' },
      { text: 'Bonjour', lang: 'fr-FR' },
    ])
    expect(clock.waitCalls).toEqual(Array(4).fill(estimatePauseDuration('Bonjour')))
    expect(player.status).toBe('stopped')
  })

  it('walks every Rep of a multi-Phrase Drill in order', async () => {
    const speech = instantSpeech()
    const clock = fakeClock()
    const player = createDrillPlayer([bonjour, merci], { speech, clock })

    const done = player.start()
    await vi.runAllTimersAsync()
    await done

    const frenchUtterances = speech.calls.filter((c) => c.lang === 'fr-FR')
    expect(frenchUtterances.slice(0, 3)).toEqual(
      Array(3).fill({ text: 'Bonjour', lang: 'fr-FR' }),
    )
    expect(frenchUtterances.slice(3)).toEqual(
      Array(3).fill({ text: 'Merci', lang: 'fr-FR' }),
    )
    expect(player.repCount).toBe(2)
    expect(player.status).toBe('stopped')
  })

  it('shuffles Phrases at start when a randomness source is injected', async () => {
    const speech = instantSpeech()
    const clock = fakeClock()
    // n=2 Fisher-Yates: i=1, j=floor(r*2); r=0 forces the single swap.
    const player = createDrillPlayer([bonjour, merci], { speech, clock }, { random: sequenceRandom([0]) })

    const done = player.start()
    await vi.runAllTimersAsync()
    await done

    expect(speech.calls[0]).toEqual({ text: 'Merci', lang: 'fr-FR' })
  })

  it('snapshots Phrases at creation — a mutation to the source array afterward does not affect the Drill', () => {
    const speech = instantSpeech()
    const clock = fakeClock()
    const source = [bonjour]
    const player = createDrillPlayer(source, { speech, clock })

    source.push(merci)

    expect(player.repCount).toBe(1)
  })

  it('is immediately stopped for an empty Phrase pool, calling no port', async () => {
    const speech = instantSpeech()
    const clock = fakeClock()
    const player = createDrillPlayer([], { speech, clock })

    await player.start()

    expect(player.status).toBe('stopped')
    expect(player.repCount).toBe(0)
    expect(speech.calls).toEqual([])
    expect(clock.waitCalls).toEqual([])
  })
})
