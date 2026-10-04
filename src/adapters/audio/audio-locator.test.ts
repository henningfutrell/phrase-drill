import { describe, expect, it, vi } from 'vitest'
import { describePhraseAudio, detectVoice, heldClips, locateHeldVoices } from './audio-locator'
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

// #6: each Phrase's row says whether its audio is done, in which voice, and
// whether it is on this phone — so the user can see what a Drill will play.
describe('describePhraseAudio', () => {
  it('names the voice each side is in and whether it is on this phone', async () => {
    const onPhone = new Set(await allClipsIn(GEORGE, PHRASES.slice(0, 1)))
    const held = new Set([...(await allClipsIn(GEORGE, PHRASES)), await hashOf(CHARLOTTE, 'fr-FR', 'Merci')])
    const clipCache = { has: async (hash: string) => onPhone.has(hash) }

    const audio = await describePhraseAudio(PHRASES.slice(0, 1).concat(PHRASES[2]), knownVoices(RACHEL), { clipCache, held })

    expect(audio.get('p1')).toEqual({ french: { voice: GEORGE, onPhone: true }, english: { voice: GEORGE, onPhone: true } })
    expect(audio.get('p3'), 'the pinned-first preference order decides between two held voices').toEqual({
      french: { voice: CHARLOTTE, onPhone: false },
      english: { voice: GEORGE, onPhone: false },
    })
  })

  it('prefers the voice on this phone over one only the server holds', async () => {
    const onPhone = new Set([await hashOf(CHARLOTTE, 'fr-FR', 'Bonjour')])
    const held = new Set(await allClipsIn(RACHEL, PHRASES))
    const clipCache = { has: async (hash: string) => onPhone.has(hash) }

    const audio = await describePhraseAudio(PHRASES.slice(0, 1), knownVoices(RACHEL), { clipCache, held })

    expect(audio.get('p1')).toEqual({ french: { voice: CHARLOTTE, onPhone: true }, english: { voice: RACHEL, onPhone: false } })
  })

  it('answers no voice for a side held nowhere', async () => {
    const audio = await describePhraseAudio(PHRASES.slice(1, 2), knownVoices(null), { clipCache: nothingOnThePhone, held: new Set() })

    expect(audio.get('p2')).toEqual({ french: { voice: null, onPhone: false }, english: { voice: null, onPhone: false } })
  })
})

describe('heldClips', () => {
  it('asks the server once for every side of every Phrase in every voice', async () => {
    const george = await allClipsIn(GEORGE, PHRASES)
    const lookup = lookupHolding(george)

    expect(await heldClips(PHRASES, knownVoices(null), lookup)).toEqual(new Set(george))
    expect(lookup.held).toHaveBeenCalledTimes(1)
    expect(lookup.held.mock.calls[0][0]).toHaveLength(PHRASES.length * 2 * 3)
  })

  it('answers nothing held when the server cannot be asked', async () => {
    const lookup: HeldClipLookup = { held: () => Promise.reject({ kind: 'network', detail: 'offline' }) }

    expect((await heldClips(PHRASES, knownVoices(null), lookup)).size).toBe(0)
  })
})
