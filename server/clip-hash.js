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
  return `${provider}|${modelId}|${voiceId}|${lang}|${text}`
}

/** SHA-256 of `clipHashMaterial`, as lowercase hex. */
export function computeClipHash(key) {
  return createHash('sha256').update(clipHashMaterial(key), 'utf8').digest('hex')
}
