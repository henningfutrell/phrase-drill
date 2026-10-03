import { createHash } from 'node:crypto'

/**
 * The content address of one Clip — the server's half of a derivation the
 * device already had (`src/adapters/storage/clip-cache.ts#computeClipHash`).
 * Both halves must produce the same 64 lowercase hex characters for the same
 * five fields; `src/adapters/storage/clip-hash-parity.integration.test.ts`
 * imports both and compares them, so a change to either one fails.
 *
 * **Why the server derives this instead of trusting a hash the client sends
 * (T063).** The Clip store is shared: whatever is written under an address is
 * what every device gets back from then on, and a cache is never re-checked
 * against the thing it caches. A client-supplied key is an unverifiable
 * assertion — "these bytes are what this address means" — and one wrong build,
 * one truncated string, one reordered field, writes the wrong audio under a
 * good address and every device plays it, permanently and silently. Deriving
 * it here from the same fields that are about to be handed to the provider
 * makes the address a function of the request the server actually made, so
 * key and bytes cannot disagree whatever the device believes.
 *
 * The cost of that choice is drift: two implementations of one derivation. It
 * is paid for by the parity test above, which is the only reason this is safe
 * to do twice.
 *
 * `provider` and `lang` are part of the address even though the ElevenLabs
 * call needs neither. They are in the device's derivation, and the two must
 * match exactly — an address that "over-keys" costs at worst one extra
 * generation; one that disagrees with the device's costs the entire point of
 * the store.
 */
export function clipHashMaterial({ provider, modelId, voiceId, lang, text }) {
  const field = delimitedField({ provider, modelId, voiceId, lang })
  if (field) throw new Error(`clip address field ${field} contains the delimiter "|"`)
  return `${provider}|${modelId}|${voiceId}|${lang}|${text}`
}

/** The four fields that precede `text` in the material, in order. */
const FIELDS_BEFORE_TEXT = ['provider', 'modelId', 'voiceId', 'lang']

/**
 * The first of `provider`/`modelId`/`voiceId`/`lang` that contains `|`, or
 * `undefined` when none does — the one rule `clipHashMaterial` enforces and
 * `/api/tts` checks first, so a bad field is a 400 rather than a thrown 500.
 *
 * **Why forbid it rather than escape it (S8a).** The material is unescaped,
 * so without this `{voiceId: 'a|b', lang: 'c'}` and `{voiceId: 'a', lang:
 * 'b|c'}` are one string, one address, and one stored Clip served for both.
 * `text` is the last field, so once the delimiter cannot appear in the other
 * four, every `|` up to the fourth is a boundary and the encoding is
 * injective — with ZERO change to any address that exists today. Escaping or
 * length-prefixing would also be injective, and would re-address every
 * stored Clip: the server keeps only the hash and cannot rehash, so their whole
 * library would miss and be billed again. Real values never hold a `|`: the
 * ids in `src/adapters/audio/voice-catalogue.ts` are alphanumeric, the
 * provider is `elevenlabs`, and `lang` is `fr-FR` or `en-US`.
 */
export function delimitedField(key) {
  return FIELDS_BEFORE_TEXT.find((field) => String(key[field]).includes('|'))
}

/** SHA-256 of `clipHashMaterial`, as lowercase hex. */
export function computeClipHash(key) {
  return createHash('sha256').update(clipHashMaterial(key), 'utf8').digest('hex')
}
