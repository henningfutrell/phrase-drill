import type { Voice } from '../domain'
import type { ClipWhereabouts, PhraseAudio } from '../adapters/audio/audio-locator'

/** The catalogue fields a name is read from — `VoiceCatalogueEntry` satisfies it. */
export type NamedVoice = Voice & { readonly name: string }

const sameVoice = (a: Voice, b: Voice): boolean =>
  a.provider === b.provider && a.modelId === b.modelId && a.voiceId === b.voiceId

/** A voice's catalogue name, or its id for one no longer offered. */
export function voiceName(voice: Voice, voices: readonly NamedVoice[]): string {
  return voices.find((entry) => sameVoice(entry, voice))?.name ?? voice.voiceId
}

/**
 * One Phrase's audio, said on its row (#6): whether it is done, the voice it
 * is in, and whether it is saved on this phone — what a Drill plays.
 */
export function phraseAudioText(audio: PhraseAudio, voices: readonly NamedVoice[], couldNotBeMade: boolean): string {
  const { french, english } = audio
  if (!french.voice && !english.voice) return couldNotBeMade ? 'No audio — it could not be made' : 'No audio yet'

  const name = (side: ClipWhereabouts): string | null => (side.voice ? voiceName(side.voice, voices) : null)
  const [fr, en] = [name(french), name(english)]
  const done = fr === en ? `Audio done in ${fr}` : `French done in ${fr ?? 'nothing yet'}, English ${en ? `in ${en}` : 'not yet'}`

  const present = [french, english].filter((side) => side.voice)
  const onPhone = present.filter((side) => side.onPhone).length
  const where =
    onPhone === present.length ? 'saved on this phone' : onPhone === 0 ? 'on the server, not on this phone yet' : 'partly on this phone'
  return `${done} · ${where}${couldNotBeMade ? ' · could not get it onto this phone' : ''}`
}

/** Both sides on this phone: the Phrase a Drill can play now. */
export function isOnPhone(audio: PhraseAudio): boolean {
  return audio.french.onPhone && audio.english.onPhone
}
