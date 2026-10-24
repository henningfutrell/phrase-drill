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
 * and made their choose, and with a different voice pinned every ask was a new,
 * billed generation of audio the user already had.
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

/** Every Clip of these Phrases the server holds, in any of `voices` — one
 * batched ask, nothing downloaded. Empty when the server cannot be asked. */
export async function heldClips(phrases: readonly Phrase[], voices: readonly Voice[], lookup: HeldClipLookup): Promise<Set<string>> {
  if (phrases.length === 0) return new Set()
  return heldOrNothing(
    lookup,
    (await candidates(phrases, voices)).map((candidate) => candidate.hash),
  )
}

/** Where one side's audio is (#6): the voice its Clip is in, or `null` when
 * neither this phone nor the server holds one, and whether it is on this phone. */
export interface ClipWhereabouts {
  readonly voice: Voice | null
  readonly onPhone: boolean
}

export interface PhraseAudio {
  readonly french: ClipWhereabouts
  readonly english: ClipWhereabouts
}

/**
 * Per Phrase, where each side's audio is (#6) — what Deck detail shows on
 * every row. A Clip on this phone wins over one only the server holds, since
 * it is the one a Drill plays; within each, `voices` order decides. `held` is
 * the server's answer from `heldClips`, asked once: this is re-read every few
 * seconds while audio arrives, and the server's `/api/tts` limiter is shared
 * with the downloads being waited on.
 */
export async function describePhraseAudio(
  phrases: readonly Phrase[],
  voices: readonly Voice[],
  deps: { readonly clipCache: Pick<ClipCache, 'has'>; readonly held: ReadonlySet<string> },
): Promise<Map<string, PhraseAudio>> {
  const bySide = new Map<string, Candidate[]>()
  const onPhone = new Set<string>()
  for (const candidate of await candidates(phrases, voices)) {
    const key = `${candidate.phraseId}|${candidate.side}`
    bySide.set(key, [...(bySide.get(key) ?? []), candidate])
    if (await deps.clipCache.has(candidate.hash)) onPhone.add(candidate.hash)
  }
  const where = (phraseId: string, side: Side): ClipWhereabouts => {
    const mine = bySide.get(`${phraseId}|${side}`) ?? []
    const local = mine.find((candidate) => onPhone.has(candidate.hash))
    if (local) return { voice: local.voice, onPhone: true }
    return { voice: mine.find((candidate) => deps.held.has(candidate.hash))?.voice ?? null, onPhone: false }
  }
  return new Map(phrases.map((phrase) => [phrase.id, { french: where(phrase.id, 'french'), english: where(phrase.id, 'english') }]))
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
 * on the server — the voice to pin when none is, instead of making them
 * choose. `null` when no voice holds any of them: then nothing exists to
 * detect and the choice really is theirs. Ties go to catalogue order.
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
