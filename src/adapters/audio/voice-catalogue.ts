import type { Voice } from '../../domain'

/**
 * Curated catalogue of voices offered by the Settings voice picker (T026).
 * The ElevenLabs key this app holds is scoped to synthesis only — `GET
 * /v1/voices` returns 401 `missing_permissions` (verified 2026-08-02) — so
 * the app cannot list voices live. Add, remove, or replace a voice by
 * editing this array; nothing else needs to change.
 *
 * None of these three is a French-native voice — they are ElevenLabs'
 * multilingual voices, speaking French with the accent named in each
 * description. Say so plainly wherever this is shown; do not claim
 * otherwise.
 *
 * Expiry to watch: if these turn out to be ElevenLabs' legacy "Default"
 * voices, they retire 2026-12-31. Recheck this list before then.
 */
export interface VoiceCatalogueEntry {
  readonly provider: 'elevenlabs'
  readonly modelId: string
  readonly voiceId: string
  readonly name: string
  readonly description: string
}

export const VOICE_CATALOGUE: readonly VoiceCatalogueEntry[] = [
  {
    provider: 'elevenlabs',
    modelId: 'eleven_multilingual_v2',
    voiceId: '21m00Tcm4TlvDq8ikWAM',
    name: 'Rachel',
    description: 'Female voice, American-accented English speaking French.',
  },
  {
    provider: 'elevenlabs',
    modelId: 'eleven_multilingual_v2',
    voiceId: 'XB0fDUnXU5powFXDhCwa',
    name: 'Charlotte',
    description: 'Female voice, European-accented English speaking French.',
  },
  {
    provider: 'elevenlabs',
    modelId: 'eleven_multilingual_v2',
    voiceId: 'JBFqnCBsd6RMkjVDRZzb',
    name: 'George',
    description: 'Male voice, British-accented English speaking French.',
  },
]

/** Preview text used when her library has no Phrases yet to draw a real one from. */
export const FALLBACK_PREVIEW_PHRASE = 'Bonjour, comment ça va ?'

/**
 * Every voice a cached Clip could plausibly be in, in the order playback and
 * the readiness sweep must prefer them: the pinned voice first, then the
 * catalogue in its declared order (T067).
 *
 * This list is what makes "does this Phrase have audio in ANY voice?"
 * answerable without a new index. A Clip is content-addressed by
 * `provider|modelId|voiceId|lang|text`, so knowing the text and the language
 * leaves only the voice unknown — and the voices she can pin are exactly the
 * ones in this file. Three candidates cost three hashes per side in the worst
 * case, and none at all in the common one, because callers stop at the first
 * hit and the pinned voice is tried first.
 *
 * Known gap, stated rather than solved: a voice REMOVED from the catalogue
 * takes its Clips out of reach, and they are then regenerated in a voice that
 * is still offered. Retiring a voice is a deliberate edit to this file, so
 * the answer is to keep a retired entry here until its Clips have aged out of
 * the cache, not to build a second registry of voices ever pinned.
 */
export function knownVoices(pinned: Voice | null): Voice[] {
  const catalogue = VOICE_CATALOGUE.map(({ provider, modelId, voiceId }) => ({ provider, modelId, voiceId }))
  if (!pinned) return catalogue
  const address = (voice: Voice): string => `${voice.provider}|${voice.modelId}|${voice.voiceId}`
  return [pinned, ...catalogue.filter((voice) => address(voice) !== address(pinned))]
}
