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
