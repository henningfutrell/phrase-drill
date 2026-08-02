/**
 * The Drill's source of randomness, injected so Shuffle is deterministically
 * testable. `next()` returns a value in [0, 1), matching `Math.random()`'s
 * contract — the domain never calls `Math.random()` itself.
 */
export interface RandomSource {
  next(): number
}

/**
 * Fisher-Yates reordering. A property of the Drill, applied at Drill start —
 * never of the Deck, which keeps its author order. Returns a new array; the
 * input is never mutated.
 */
export function shuffle<T>(items: readonly T[], random: RandomSource): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random.next() * (i + 1))
    const swap = result[i]
    result[i] = result[j]
    result[j] = swap
  }
  return result
}
