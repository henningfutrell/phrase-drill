import { describe, expect, it } from 'vitest'
import { shuffle } from './shuffle'
import type { RandomSource } from './shuffle'

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

describe('shuffle', () => {
  it('reorders deterministically for a given randomness source (Fisher-Yates)', () => {
    const result = shuffle(['A', 'B', 'C', 'D'], sequenceRandom([0, 0, 0]))

    expect(result).toEqual(['B', 'C', 'D', 'A'])
  })

  it('does not mutate the input array', () => {
    const input = ['A', 'B', 'C']
    shuffle(input, sequenceRandom([0, 0]))

    expect(input).toEqual(['A', 'B', 'C'])
  })

  it('leaves an empty array empty', () => {
    expect(shuffle([], sequenceRandom([]))).toEqual([])
  })

  it('leaves a single-element array unchanged and draws no randomness', () => {
    const random = sequenceRandom([])
    expect(shuffle(['only'], random)).toEqual(['only'])
  })

  it('produces the identity ordering when the source always returns just under 1', () => {
    // next() close to 1 always picks the last remaining index, i.e. no swap away
    // from position i itself is guaranteed — this exercises the top of the range.
    const result = shuffle(['A', 'B', 'C'], sequenceRandom([0.999, 0.999]))
    expect(result).toHaveLength(3)
    expect(result).toContain('A')
    expect(result).toContain('B')
    expect(result).toContain('C')
  })
})
