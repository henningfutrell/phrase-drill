import type { Language, Phrase, Voice } from '../../domain'
import { computeClipHash, type ClipCache } from '../storage/clip-cache'
import type { HeldVoices } from './generation-queue'
import type { HeldClipLookup } from './server-synth-client'
import { knownVoices } from './voice-catalogue'

/**
 * Detect existing audio (#4): where the audio for some Phrases already is,
 * in which voice. A Clip is content-addressed by
 * `provider|modelId|voiceId|lang|text`, so with the text known only the voice
 * is open — and the voices it can be are the catalogue's (`knownVoices`).
 * One batched ask to the server names every hash it holds; nothing is
 * downloaded and nothing is generated to find out.
 *
 * It exists because the phone used to learn the server had a Clip only by
 * asking for it in the pinned voice: with no voice pinned it asked nothing
 * and made her choose, and with a different voice pinned every ask was a new,
 * billed generation of audio she already had.
 */

type Side = 'french' | 'english'
const SIDES: ReadonlyArray<{ side: Side; lang: Language }> = [
  { side: 'french', lang: 'fr-FR' },
  { side: 'english', lang: 'en-US' },
]

interface Candidate {
  readonly phraseId: string
  readonly side: Side
  readonly voice: Voice
  readonly hash: string
}

/** Every (Phrase, side, voice) address, in `voices` order within each side. */
async function candidates(phrases: readonly Phrase[], voices: readonly Voice[]): Promise<Candidate[]> {
  const out: Candidate[] = []
  for (const phrase of phrases) {
    for (const { side, lang } of SIDES) {
      for (const voice of voices) {
        out.push({ phraseId: phrase.id, side, voice, hash: await computeClipHash({ ...voice, lang, text: phrase[side] }) })
      }
    }
  }
  return out
}

/** The server's answer, or an empty one when it cannot be asked — offline,
 * rate-limited, signed out. Not knowing is not an error here: the caller
 * falls back to what it did before this existed. */
async function heldOrNothing(lookup: HeldClipLookup, hashes: readonly string[]): Promise<Set<string>> {
  try {
    return await lookup.held(hashes)
  } catch {
    return new Set()
  }
}

/**
 * Per Phrase, the first voice in `voices` order the server holds each side
 * in. A Phrase held nowhere has no entry; a side held nowhere is left out, so
 * the generation queue makes it in the pinned voice as before.
 */
export async function locateHeldVoices(
  phrases: readonly Phrase[],
  voices: readonly Voice[],
  lookup: HeldClipLookup,
): Promise<Map<string, HeldVoices>> {
  const located = new Map<string, HeldVoices>()
  if (phrases.length === 0) return located
  const all = await candidates(phrases, voices)
  const held = await heldOrNothing(
    lookup,
    all.map((candidate) => candidate.hash),
  )
  for (const candidate of all) {
    if (!held.has(candidate.hash)) continue
    const entry = located.get(candidate.phraseId) ?? {}
    if (entry[candidate.side]) continue
    located.set(candidate.phraseId, { ...entry, [candidate.side]: candidate.voice })
  }
  return located
}

export interface DetectVoiceDeps {
  readonly clipCache: Pick<ClipCache, 'has'>
  readonly lookup: HeldClipLookup
}

/**
 * The catalogue voice most of these Phrases' Clips are in, on this phone or
 * on the server — the voice to pin when none is, instead of making her
 * choose. `null` when no voice holds any of them: then nothing exists to
 * detect and the choice really is hers. Ties go to catalogue order.
 */
export async function detectVoice(phrases: readonly Phrase[], deps: DetectVoiceDeps): Promise<Voice | null> {
  const voices = knownVoices(null)
  const all = await candidates(phrases, voices)
  const held = await heldOrNothing(
    deps.lookup,
    all.map((candidate) => candidate.hash),
  )
  const counts = new Map<Voice, number>(voices.map((voice) => [voice, 0]))
  for (const candidate of all) {
    if (held.has(candidate.hash) || (await deps.clipCache.has(candidate.hash))) {
      counts.set(candidate.voice, (counts.get(candidate.voice) ?? 0) + 1)
    }
  }
  let best: Voice | null = null
  let bestCount = 0
  for (const voice of voices) {
    const count = counts.get(voice) ?? 0
    if (count > bestCount) {
      best = voice
      bestCount = count
    }
  }
  return best
}
