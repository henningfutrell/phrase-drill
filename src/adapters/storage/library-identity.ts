import type { Library, Voice } from '../../domain'

/**
 * Do these two libraries hold the same records? Decks, Mixes and Tombstones —
 * everything the deck store keeps, and nothing else. The pinned voice lives in
 * the `settings` store and is compared by `sameVoice` below, beside the store
 * that owns it.
 *
 * Two questions are answered with this, and both of them are "may I skip a
 * write?":
 *
 * - `updateAll` skips the clear-and-rewrite when an update changed nothing.
 * - The sync engine counts a library revision only when the merge really
 *   brought something down, so a screen is not re-rendered per idle sync.
 *
 * `exportedAt` is deliberately not compared: it is stamped at read time, so
 * including it would make every comparison report a change. A false "they
 * differ" costs one redundant write and a redundant render; it can never cost
 * a record.
 */
export function sameLibraryContent(a: Library, b: Library): boolean {
  return fingerprint(a) === fingerprint(b)
}

function fingerprint(library: Library): string {
  const byId = (x: { id: string }, y: { id: string }) => (x.id < y.id ? -1 : 1)
  return JSON.stringify({
    // Phrase order inside a Deck is hers and is compared as written; the
    // order of the Decks themselves is not, so it is normalized away.
    decks: [...library.decks].sort(byId),
    mixes: [...(library.mixes ?? [])].sort(byId),
    tombstones: [...(library.tombstones ?? [])].sort((x, y) => (`${x.kind}:${x.id}` < `${y.kind}:${y.id}` ? -1 : 1)),
  })
}

/**
 * Is this the same pinned voice (T067)? `null` and `undefined` are both "none
 * recorded" here — the settings store says `null`, an envelope without the
 * field says `undefined`, and they mean the same thing.
 */
export function sameVoice(a: Voice | null | undefined, b: Voice | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return a.provider === b.provider && a.modelId === b.modelId && a.voiceId === b.voiceId
}
