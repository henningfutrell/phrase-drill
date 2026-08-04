/**
 * The text-to-speech voice a Clip is rendered in: provider, model, and voice
 * id, together. Those three are two thirds of a Clip's content address
 * (`provider|modelId|voiceId|lang|text`, `docs/glossary.md` "Clip"), which is
 * what makes a given voice-and-statement generated exactly once, ever.
 *
 * It lives in the domain rather than in the storage adapter because it
 * travels in the `Library` envelope (T067): the pinned voice is a preference
 * that should follow her to a new phone. Everything about *how* a voice is
 * pinned, cached or synthesized stays adapter-side; this is only the value.
 */
export interface Voice {
  readonly provider: string
  readonly modelId: string
  readonly voiceId: string
}

/**
 * Is this the shape of a Voice? Asked of data that came from outside this
 * build — a backup file she chose, or an envelope pulled from the server —
 * where the field could be anything. Nothing internal needs it: a `Voice`
 * read from the settings store is already typed.
 *
 * Checks the three parts of the content address and no more. An empty string
 * is a Voice here, and deliberately: it addresses a Clip nothing will ever
 * have generated, so it misses the cache and is replaced the next time she
 * picks from the catalogue, which is a smaller failure than refusing to
 * restore a whole library over one field.
 */
export function isVoice(value: unknown): value is Voice {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.provider === 'string' &&
    typeof candidate.modelId === 'string' &&
    typeof candidate.voiceId === 'string'
  )
}
