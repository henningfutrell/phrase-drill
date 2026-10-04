import { describe, expect, it, vi } from 'vitest'
import { detectVoice, locateHeldVoices } from './audio-locator'
import { computeClipHash } from '../storage/clip-cache'
import type { HeldClipLookup } from './server-synth-client'
import type { Language, Phrase, Voice } from '../../domain'
import { knownVoices, VOICE_CATALOGUE } from './voice-catalogue'

const [RACHEL, CHARLOTTE, GEORGE] = VOICE_CATALOGUE.map(({ provider, modelId, voiceId }): Voice => ({ provider, modelId, voiceId }))

const PHRASES: Phrase[] = [
  { id: 'p1', french: 'Bonjour', english: 'Hello' },
  { id: 'p2', french: 'Salut', english: 'Hi' },
  { id: 'p3', french: 'Merci', english: 'Thanks' },
]

const hashOf = (voice: Voice, lang: Language, text: string): Promise<string> => computeClipHash({ ...voice, lang, text })

/** Every Clip of these Phrases, both sides, in one voice. */
async function allClipsIn(voice: Voice, phrases: readonly Phrase[]): Promise<string[]> {
  const hashes: string[] = []
  for (const phrase of phrases) hashes.push(await hashOf(voice, 'fr-FR', phrase.french), await hashOf(voice, 'en-US', phrase.english))
  return hashes
}

function lookupHolding(hashes: readonly string[]): HeldClipLookup & { held: ReturnType<typeof vi.fn> } {
  const store = new Set(hashes)
  return { held: vi.fn(async (asked: readonly string[]) => new Set(asked.filter((hash) => store.has(hash)))) }
}

const nothingOnThePhone = { has: async () => false }

describe('detectVoice', () => {
  it('picks the catalogue voice the server holds most of these Phrases in', async () => {
    const lookup = lookupHolding([...(await allClipsIn(GEORGE, PHRASES)), ...(await allClipsIn(RACHEL, PHRASES.slice(0, 1)))])

    expect(await detectVoice(PHRASES, { clipCache: nothingOnThePhone, lookup })).toEqual(GEORGE)
  })

  it('counts Clips already on the phone too, and answers offline from them alone', async () => {
    const onPhone = new Set(await allClipsIn(CHARLOTTE, PHRASES))
    const clipCache = { has: async (hash: string) => onPhone.has(hash) }
    const lookup: HeldClipLookup = { held: () => Promise.reject({ kind: 'network', detail: 'offline' }) }

    expect(await detectVoice(PHRASES, { clipCache, lookup })).toEqual(CHARLOTTE)
  })

  it('answers null when no voice holds any of them — the choice is then really theirs', async () => {
    expect(await detectVoice(PHRASES, { clipCache: nothingOnThePhone, lookup: lookupHolding([]) })).toBeNull()
  })
})

describe('locateHeldVoices', () => {
  it('names, per side, the first voice in preference order the server holds it in', async () => {
    const lookup = lookupHolding([
      await hashOf(GEORGE, 'fr-FR', 'Bonjour'),
      await hashOf(RACHEL, 'fr-FR', 'Bonjour'),
      await hashOf(CHARLOTTE, 'en-US', 'Hello'),
      await hashOf(GEORGE, 'en-US', 'Thanks'),
    ])

    const held = await locateHeldVoices(PHRASES, knownVoices(GEORGE), lookup)

    expect(held.get('p1')).toEqual({ french: GEORGE, english: CHARLOTTE })
    expect(held.has('p2'), 'a Phrase held nowhere has no entry').toBe(false)
    expect(held.get('p3')).toEqual({ english: GEORGE })
    expect(lookup.held).toHaveBeenCalledTimes(1)
  })

  it('asks nothing for no Phrases', async () => {
    const lookup = lookupHolding([])

    expect((await locateHeldVoices([], knownVoices(RACHEL), lookup)).size).toBe(0)
    expect(lookup.held).not.toHaveBeenCalled()
  })
})
