import type { DeckRecord, Library, MixRecord, PhraseRecord, Tombstone } from './ports'

/**
 * Reconcile two whole-library snapshots — this device's and the server's —
 * into one that loses nothing either of them holds (T060).
 *
 * ## Why this exists
 *
 * Sync pushes the whole `Library`. Before this, the push replaced the server
 * copy outright, so the rule was last-write-wins: a phone that had never
 * pulled held a library missing the Deck made on the web, and its first
 * local save deleted that Deck for good. Ordering cannot fix that — both
 * devices are pushing an honest snapshot of a partial library, and whichever
 * writes last wins by accident. The only safe answer is to merge.
 *
 * ## The rule
 *
 * - **Per record, latest write wins.** Decks and Mixes are whole aggregates
 *   with an `updatedAt`, so the later of two same-id records is the one to
 *   keep; a record only one side has is kept unconditionally. An exact tie
 *   keeps the local copy — deterministic, and a tie means two writes in the
 *   same millisecond on two devices, which in practice means the same bytes.
 * - **A Tombstone deletes**, when it names a record unchanged from the
 *   baseline and is at least as recent as it (`deletedAt >= updatedAt`).
 *   Equal counts as deleted: a delete is written after the record it removes,
 *   so equality is the delete of exactly that record, not a coincidence.
 * - **Writing the id again beats the Tombstone**, and drops it — otherwise a
 *   Deck she recreated would be deleted again on the next merge, forever.
 *   Since T070 that is judged against the baseline rather than against the
 *   other device's clock; see `isDeleted`.
 *
 * ## Inside a Deck, when a baseline is known (T034)
 *
 * T060 stopped at whole records, so two devices editing different Phrases of
 * ONE Deck inside a single round-trip still lost a side: the later whole Deck
 * replaced the earlier whole Deck, silently. `base` closes that. It is the
 * last snapshot both sides are known to have agreed on — what this device
 * pushed and the server accepted — and it turns "these two records differ"
 * into the three answers that actually matter: only local changed, only
 * remote changed, or both did.
 *
 * - **Only one side changed** → that side's name and dates win whole. Its
 *   Phrases still go through the merge below (T070): the unchanged side has
 *   nothing to contribute except a Phrase the changed side has lost, and
 *   losing those is exactly what a whole-record answer here did.
 * - **Both sides changed** → merge per Phrase, by id. Added on either side is
 *   kept. Deleted on one side and *edited* on the other is **kept**: an edit
 *   is somebody typing, and losing it is the failure this whole file exists
 *   to prevent, while keeping a Phrase she deleted costs her one tap.
 * - **The same Phrase edited on both sides** is the one true conflict, and
 *   the only place a keystroke can still be dropped. The later Deck's text
 *   wins (a tie keeps local, matching the whole-record rule). There is
 *   nowhere to put the loser: `Phrase` has one French and one English field,
 *   and inventing a second copy of a phrase would corrupt the drill.
 *
 * A Phrase is **removed** only where this device's own saved Deck records the
 * deletion — never because the other side is missing it (T070). See
 * `mergePhrases`, which is where the whole argument is written down.
 *
 * The pinned voice (T067) is neither: it is one value with no id and no
 * `updatedAt`, and it takes plain last-writer-wins — this device's, unless
 * this device has none. It used to be able to invalidate the whole audio
 * cache, which would have made that rule reckless; it cannot any more, so a
 * conflict on it changes what the next new Phrase is generated in and
 * nothing else.
 *
 * With **no baseline** — the first sync ever, a device whose baseline was
 * evicted, or one written under a schema version this build does not read
 * (T081) — a Deck held by both sides keeps the later record's name and dates
 * and the union of its Phrases. A missing baseline degrades the merge; it
 * never deletes through it.
 *
 * Mixes stay whole-record in their CONTENTS: a Mix is a name and a list of
 * Deck ids, so the loser of a Mix conflict is a selection she can re-make in
 * seconds, not text she wrote. Which side wins is decided against the baseline
 * first, so a wrong clock cannot discard an edit the other side never made.
 *
 * Deliberately NOT done here: pruning a Mix's `deckIds` of Decks this
 * merge deleted. A dead id is already tolerated at read time and kept on
 * purpose (`resolveMixDecks`), and a dead id resurrects nothing — a Mix
 * holds ids, never Phrases.
 *
 * Pure: no I/O, no clock, and neither input is mutated.
 */
export function mergeLibraries(local: Library, remote: Library, base?: Library): Library {
  if (local.schemaVersion !== remote.schemaVersion) {
    throw new Error(
      `cannot merge libraries at different schema version: ${local.schemaVersion} and ${remote.schemaVersion}`,
    )
  }
  // A baseline at another schema version is one this build cannot compare
  // against, and that is all it is (T081). Refusing it used to be fatal:
  // nothing migrates the baseline — it is written under whatever schema was
  // current at the time and read back raw — so an app update that bumps the
  // schema leaves one behind, this threw on the first round-trip after it, the
  // engine read the throw as an envelope it cannot understand, and parked at
  // `needs-update`, which by design never retries. Sync then stopped for good
  // on a phone whose app was already current.
  //
  // The baseline is derived, regenerable bookkeeping, and losing it is
  // supposed to cost the next merge its precision and nothing else
  // (docs/glossary.md). So an unusable one is treated as one that is not
  // there, and the next accepted push writes a fresh one at the current
  // version — one round-trip of degraded precision, never a Phrase.
  //
  // Only the VERSION is judged. An EMPTY baseline at the current version is
  // still a baseline, and it says the opposite thing: absent is "nothing can
  // be shown", under which a Tombstone wins on its clock alone, while empty is
  // "we agreed on nothing", under which every record here outranks a Tombstone
  // — which is what makes a restore from file stick (T072).
  const agreed = base?.schemaVersion === local.schemaVersion ? base : undefined

  const tombstones = mergeTombstones(local.tombstones ?? [], remote.tombstones ?? [])
  const decks = mergeDecks(local.decks, remote.decks, agreed?.decks)
  const mixes = mergeMixes(local.mixes ?? [], remote.mixes ?? [], agreed?.mixes)

  const baseDecks = byId(agreed?.decks)
  const baseMixes = byId(agreed?.mixes)

  const survivingDecks = decks.filter(
    (deck) => !isDeleted(deck, tombstones.get(key('deck', deck.id)), rewritten(deck, baseDecks, sameDeckContent)),
  )
  const survivingMixes = mixes.filter(
    (mix) => !isDeleted(mix, tombstones.get(key('mix', mix.id)), rewritten(mix, baseMixes, sameMixContent)),
  )

  const survivingIds = new Set([
    ...survivingDecks.map((deck) => key('deck', deck.id)),
    ...survivingMixes.map((mix) => key('mix', mix.id)),
  ])

  return {
    format: local.format,
    schemaVersion: local.schemaVersion,
    // The merged snapshot describes both inputs, so it is as fresh as the
    // fresher of them — never dated older than data it already carries.
    exportedAt: Math.max(local.exportedAt, remote.exportedAt),
    decks: survivingDecks,
    mixes: survivingMixes,
    // A Tombstone whose record survived was outlived by a rewrite of that
    // id; keeping it would delete the record again on the next merge.
    tombstones: [...tombstones.values()].filter((tombstone) => !survivingIds.has(key(tombstone.kind, tombstone.id))),
    // The pinned voice (T067): last writer wins, and the writer is whichever
    // device is syncing. No `pinnedAt` was invented to arbitrate it, because
    // there is nothing left for a timestamp to protect — since T067 a Clip
    // is playable in the voice it was made in, so losing this conflict costs
    // her what the NEXT new Phrase is generated in and nothing else. A
    // side with no voice never clears the other's: absent means "none
    // recorded", which is how a new phone adopts the voice from the server
    // copy and how an envelope written before T067 leaves a local pin alone.
    voice: local.voice ?? remote.voice,
  }
}

/** One namespace for both aggregates, so a Deck's Tombstone can never reach a Mix. */
function key(kind: Tombstone['kind'], id: string): string {
  return `${kind}:${id}`
}

/**
 * Records by id, or nothing at all when there is nothing to index. Absent and
 * empty are different answers here: absent is "there is no baseline to reason
 * from", empty is "the baseline held none of these".
 */
function byId<T extends { readonly id: string }>(records: readonly T[] | undefined): Map<string, T> | undefined {
  if (records === undefined) return undefined
  return new Map(records.map((record) => [record.id, record]))
}

/**
 * Every Mix from both sides. Local order first, then whatever only the remote
 * had — the same ordering rule the Decks follow.
 *
 * A Mix's CONTENTS stay whole-record: it is a name and a list of Deck ids, and
 * the loser of a conflict is a selection she can re-make in seconds. But which
 * side wins is decided against the baseline first (T070), so a device with a
 * wrong clock cannot discard an edit the other side never made.
 */
function mergeMixes(
  local: readonly MixRecord[],
  remote: readonly MixRecord[],
  base: readonly MixRecord[] | undefined,
): MixRecord[] {
  const baseById = base && new Map(base.map((mix) => [mix.id, mix]))
  const remoteById = new Map(remote.map((mix) => [mix.id, mix]))
  const localIds = new Set(local.map((mix) => mix.id))

  const merged = local.map((mix) => {
    const other = remoteById.get(mix.id)
    return other ? reconcileMix(mix, other, baseById?.get(mix.id)) : mix
  })
  return [...merged, ...remote.filter((mix) => !localIds.has(mix.id))]
}

/**
 * One Mix id, held by both devices. The side that did not move away from the
 * baseline has nothing to contribute; when both moved, or there is no baseline
 * to compare against, the later write wins (a tie keeps local).
 */
function reconcileMix(local: MixRecord, remote: MixRecord, base: MixRecord | undefined): MixRecord {
  if (base) {
    const localChanged = !sameMixContent(local, base)
    const remoteChanged = !sameMixContent(remote, base)
    if (!localChanged) return remoteChanged ? remote : local
    if (!remoteChanged) return local
  }
  return local.updatedAt >= remote.updatedAt ? local : remote
}

/** Is this Mix the same Mix the baseline holds? Only what she can change. */
function sameMixContent(mix: MixRecord, base: MixRecord): boolean {
  return (
    mix.name === base.name &&
    mix.deckIds.length === base.deckIds.length &&
    mix.deckIds.every((id, index) => id === base.deckIds[index])
  )
}

/**
 * Every Deck from both sides. An id only one side holds is kept as it is; an
 * id both hold is reconciled against the baseline (T034). Local order first,
 * then whatever only the remote had — a Deck she is looking at does not move
 * under her because another device wrote one.
 */
function mergeDecks(
  local: readonly DeckRecord[],
  remote: readonly DeckRecord[],
  base: readonly DeckRecord[] | undefined,
): DeckRecord[] {
  const baseById = base && new Map(base.map((deck) => [deck.id, deck]))
  const remoteById = new Map(remote.map((deck) => [deck.id, deck]))
  const localIds = new Set(local.map((deck) => deck.id))

  const merged = local.map((deck) => {
    const other = remoteById.get(deck.id)
    return other ? reconcileDeck(deck, other, baseById?.get(deck.id)) : deck
  })
  return [...merged, ...remote.filter((deck) => !localIds.has(deck.id))]
}

/**
 * One Deck id, held by both devices. Its name and dates come from the three
 * cases the baseline separates — see this module's doc comment. Its Phrases
 * always come from `mergePhrases`, whether or not there is a baseline (T070):
 * no whole record may replace another whole record, because the loser's
 * Phrases would go with it and nothing would record that they were deleted.
 * With no baseline `mergePhrases` is handed an empty one, which is the honest
 * reading — nothing is known to have been deleted — and makes it a union.
 */
function reconcileDeck(local: DeckRecord, remote: DeckRecord, base: DeckRecord | undefined): DeckRecord {
  const localIsLater = local.updatedAt >= remote.updatedAt
  const phrases = mergePhrases(base?.phrases, local.phrases, remote.phrases, localIsLater)
  if (!base) return { ...(localIsLater ? local : remote), phrases }

  const localChanged = !sameDeckContent(local, base)
  const remoteChanged = !sameDeckContent(remote, base)
  // The unchanged side has nothing to contribute but the Phrases the other
  // side may have lost: `phrases` already holds those, and only those.
  if (!localChanged) return remoteChanged ? { ...remote, phrases } : local
  if (!remoteChanged) return local

  return {
    id: local.id,
    name: localIsLater ? local.name : remote.name,
    phrases,
    // It holds data written on both devices, so it was created no later than
    // the earlier of them and written no earlier than the later of them.
    createdAt: Math.min(local.createdAt, remote.createdAt),
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
  }
}

/**
 * Is this Deck the same Deck the baseline holds? Only what she can change is
 * compared: `updatedAt` moves when a Deck is saved with no net change, and
 * treating that as a change would send two devices down the three-way path
 * over nothing.
 */
function sameDeckContent(deck: DeckRecord, base: DeckRecord): boolean {
  return deck.name === base.name && samePhraseList(deck.phrases, base.phrases)
}

function samePhraseList(a: readonly PhraseRecord[], b: readonly PhraseRecord[]): boolean {
  return a.length === b.length && a.every((phrase, index) => samePhrase(phrase, b[index]!))
}

/**
 * Two Phrases are the same Phrase when every field she can see agrees. An
 * `undefined` first argument is "the baseline never held this one", which is
 * never the same as a Phrase that exists — the id, the French and the English
 * are all compared, so retyping a phrase under a new id is a change, and so
 * is correcting only its English.
 */
function samePhrase(a: PhraseRecord | undefined, b: PhraseRecord): boolean {
  return a !== undefined && a.id === b.id && a.french === b.french && a.english === b.english
}

/**
 * The Phrases of one Deck, merged by id against the baseline. Local order
 * first, then Phrases only the other device has — so the list she is drilling
 * keeps the order she put it in, and what arrives from elsewhere lands at the
 * end where she will see it.
 *
 * **A Phrase is only ever removed when something records that it was deleted**
 * (T070). Nothing writes a Phrase Tombstone, so the one record this build has
 * is this device's own saved Deck: it held the Phrase at the last state both
 * sides agreed on, and it does not now. The other side's absence is NOT such a
 * record — the server is not guaranteed to be a descendant of the baseline
 * (restore the pg_dump, let an older device's push win, repair the row by
 * hand) and absence there means "rolled back" exactly as readily as "deleted".
 * Reading it as a deletion is what made the documented recovery procedure
 * destroy her phrases, on the phone and on the server, in one round-trip.
 *
 * The cost is that a Phrase deleted on the OTHER device comes back here until
 * this device deletes it too — one tap. The alternative cost is handwritten
 * phrases that exist nowhere else.
 */
function mergePhrases(
  base: readonly PhraseRecord[] | undefined,
  local: readonly PhraseRecord[],
  remote: readonly PhraseRecord[],
  localIsLater: boolean,
): PhraseRecord[] {
  const baseById = groupById(base)
  const localById = groupById(local)
  const remoteById = groupById(remote)
  const ids = [...new Set([...local, ...remote].map((phrase) => phrase.id))]

  const merged: PhraseRecord[] = []
  for (const id of ids) {
    const mine = localById.get(id) ?? NONE
    const theirs = remoteById.get(id) ?? NONE
    const before = baseById.get(id) ?? NONE

    // Two Phrases sharing an id (a hand-edited restore file, an import bug —
    // no write path enforces uniqueness). There is no sound way to pair them
    // up, so both sides are kept whole and only exact repeats are folded
    // together: a duplicate id is already a defect, and answering it by
    // dropping one of her phrases makes it a loss (T070).
    if (mine.length > 1 || theirs.length > 1 || before.length > 1) {
      merged.push(...unionByContent(mine, theirs))
      continue
    }

    const held = mine[0]
    const other = theirs[0]
    if (held === undefined) {
      // Only the other device holds it — `ids` came from the two lists, so
      // this side having none means that side has exactly one. It is an
      // addition unless this device once had it and dropped it, and even then
      // an edit outranks a delete.
      if (!samePhrase(before[0], theirs[0]!)) merged.push(theirs[0]!)
      continue
    }
    if (other === undefined) {
      // Only this device holds it. Absence over there is not a deletion.
      merged.push(held)
      continue
    }
    // Held by both: whichever side actually moved it away from the baseline
    // is the edit. Both moved it — the one real conflict — and the later
    // Deck's text wins. Two sides that agree need no case of their own: they
    // take the first branch and push identical content.
    if (samePhrase(before[0], held)) merged.push(other)
    else if (samePhrase(before[0], other)) merged.push(held)
    else merged.push(localIsLater ? held : other)
  }
  return merged
}

/**
 * No Phrases under this id — one shared empty list, so that "she has none"
 * has exactly one representation everywhere the merge reasons about it.
 */
const NONE: readonly PhraseRecord[] = []

/**
 * Every Phrase under its id, in order — a list, because ids are not unique.
 * No baseline at all groups to nothing, which is the honest reading: with
 * nothing to compare against, nothing is known to have been deleted.
 */
function groupById(phrases: readonly PhraseRecord[] | undefined): Map<string, PhraseRecord[]> {
  const grouped = new Map<string, PhraseRecord[]>()
  if (phrases === undefined) return grouped
  for (const phrase of phrases) {
    const held = grouped.get(phrase.id)
    if (held) held.push(phrase)
    else grouped.set(phrase.id, [phrase])
  }
  return grouped
}

/** Both sides' Phrases under one id, keeping every distinct one exactly once. */
function unionByContent(mine: readonly PhraseRecord[], theirs: readonly PhraseRecord[]): PhraseRecord[] {
  const kept = [...mine]
  for (const phrase of theirs) {
    if (!kept.some((held) => samePhrase(held, phrase))) kept.push(phrase)
  }
  return kept
}

/** Every Tombstone from both sides, keeping the later deletion of any id. */
function mergeTombstones(
  local: readonly Tombstone[],
  remote: readonly Tombstone[],
): Map<string, Tombstone> {
  const latest = new Map<string, Tombstone>()
  for (const tombstone of [...local, ...remote]) {
    const held = latest.get(key(tombstone.kind, tombstone.id))
    // Stryker disable next-line EqualityOperator: `>` vs `>=` is equivalent here. A
    // Tombstone is exactly {kind, id, deletedAt}, so two that compare equal on
    // deletedAt under the same key are structurally identical — whichever the tie
    // keeps, the map holds the same value, and no test can observe the difference.
    if (!held || tombstone.deletedAt > held.deletedAt) latest.set(key(tombstone.kind, tombstone.id), tombstone)
  }
  return latest
}

/**
 * Has this record been written since the last state both sides agreed on?
 * `undefined` in the baseline map is "created since"; no baseline at all is
 * "nothing can be shown", which is not the same as "no".
 */
function rewritten<T extends { readonly id: string }>(
  record: T,
  base: Map<string, T> | undefined,
  same: (record: T, base: T) => boolean,
): boolean {
  if (!base) return false
  const before = base.get(record.id)
  return before === undefined || !same(record, before)
}

/**
 * A record is deleted when its Tombstone is at least as recent as the record
 * itself. Strictly newer is not enough: `remove` writes the Tombstone for a
 * record it has just read, so the two can carry the same instant.
 *
 * That comparison is between two unsynchronized wall clocks (T070). A phone
 * that has been off, in airplane mode, or had its date set by hand can stamp a
 * Tombstone minutes ahead of a Deck written after it, and Tombstones are never
 * garbage-collected, so one wrong clock poisons a record permanently. There is
 * no logical clock here and adding one would change what is on her disk, but
 * the baseline is already causal rather than chronological: a record that
 * differs from the state both sides agreed on was written AFTER that
 * agreement, whatever any clock says, so the deleting side cannot have seen
 * it. Such a record outlives the Tombstone — and `mergeLibraries` then drops
 * the Tombstone, so this resolves once instead of flapping.
 *
 * With no baseline (the first sync ever, or one after IndexedDB evicted it)
 * the clock is all there is. That is one round-trip of exposure, and it is
 * pinned by a test rather than papered over.
 */
function isDeleted(
  record: DeckRecord | MixRecord,
  tombstone: Tombstone | undefined,
  rewrittenSinceBaseline: boolean,
): boolean {
  if (tombstone === undefined) return false
  if (rewrittenSinceBaseline) return false
  return tombstone.deletedAt >= record.updatedAt
}
