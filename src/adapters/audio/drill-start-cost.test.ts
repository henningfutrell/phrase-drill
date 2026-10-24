import { beforeEach, describe, expect, it, vi } from 'vitest'
import { idbOperations, resetFakeIdb } from '../storage/idb.test-support'

import { computeDrillReadiness } from './drill-readiness'
import { computeClipHash, createIndexedDbClipCache } from '../storage/clip-cache'
import type { GenerationQueue } from './generation-queue'
import type { Phrase, Voice } from '../../domain'

/**
 * T037 — what one drill start costs, against the real clip cache.
 *
 * A drill start is asked about one Deck, and the library around it can be
 * thousands of Phrases. Its cost must follow the Deck, not the library: no
 * whole-store read of the audio, and each side of each Phrase in the Deck
 * hashed once. Before T037 the readiness sweep hashed every ready Phrase,
 * and then the working-set protection hashed every one of them again.
 */

const VOICE: Voice = { provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: 'voice-1' }

function phrases(prefix: string, count: number): Phrase[] {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, french: `${prefix} fr ${i}`, english: `${prefix} en ${i}` }))
}

const DECK_IN_HAND = phrases('hand-', 3)
const REST_OF_LIBRARY = phrases('rest-', 40)

function idleQueue(): GenerationQueue {
  return {
    enqueue: vi.fn(),
    regenerate: vi.fn(),
    statusFor: vi.fn(),
    whenIdle: vi.fn().mockResolvedValue(undefined),
    suspend: vi.fn(),
    resume: vi.fn(),
  }
}

async function hashesOf(phrase: Phrase): Promise<[string, string]> {
  return [
    await computeClipHash({ ...VOICE, lang: 'fr-FR', text: phrase.french }),
    await computeClipHash({ ...VOICE, lang: 'en-US', text: phrase.english }),
  ]
}

describe('drill start (T037)', () => {
  beforeEach(() => {
    resetFakeIdb()
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(true) } })
    vi.restoreAllMocks()
  })

  it("touches only the Deck's Clips: no store read, one hash per side, and the Deck's hashes protected", async () => {
    const cache = createIndexedDbClipCache()
    const deckHashes = new Set<string>()
    for (const phrase of [...DECK_IN_HAND, ...REST_OF_LIBRARY]) {
      for (const hash of await hashesOf(phrase)) {
        await cache.put({ hash, bytes: new ArrayBuffer(8), mime: 'audio/mpeg', durationMs: 1, createdAt: 1 })
        if (phrase.id.startsWith('hand-')) deckHashes.add(hash)
      }
    }
    const protect = vi.spyOn(cache, 'protect')
    const deps = { clipCache: cache, generationQueue: idleQueue(), voice: VOICE, isOnline: () => false }

    idbOperations.splice(0)
    const digest = vi.spyOn(crypto.subtle, 'digest')
    const result = await computeDrillReadiness(DECK_IN_HAND, deps)

    expect(result.ready.map((phrase) => phrase.id)).toEqual(DECK_IN_HAND.map((phrase) => phrase.id))
    // The index is in memory since the puts above: the sweep reads nothing.
    expect(idbOperations).toEqual([])
    // Two sides per Phrase, the pinned voice hits first: two digests per Phrase, not four.
    expect(digest).toHaveBeenCalledTimes(2 * DECK_IN_HAND.length)
    expect(protect).toHaveBeenCalledTimes(1)
    expect(new Set(protect.mock.calls[0][0])).toEqual(deckHashes)
  })
})
