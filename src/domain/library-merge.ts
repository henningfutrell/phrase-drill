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
 * - **A Tombstone deletes**, when it is at least as recent as the record it
 *   names (`deletedAt >= updatedAt`). Equal counts as deleted: a delete is
 *   written after the record it removes, so equality is the delete of
 *   exactly that record, not a coincidence.
 * - **Writing the id again beats the Tombstone**, and drops it — otherwise a
 *   Deck she recreated would be deleted again on the next merge, forever.
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
 * - **Only one side changed** → that side wins whole, deletions included. No
 *   phrase-level reasoning is needed or wanted: the unchanged side has
 *   nothing to contribute.
 * - **Both sides changed** → merge per Phrase, by id. Added on either side is
 *   kept. Deleted on one side and untouched on the other is deleted. Deleted
 *   on one side and *edited* on the other is **kept**: an edit is somebody
 *   typing, and losing it is the failure this whole file exists to prevent,
 *   while keeping a Phrase she deleted costs her one tap.
 * - **The same Phrase edited on both sides** is the one true conflict, and
 *   the only place a keystroke can still be dropped. The later Deck's text
 *   wins (a tie keeps local, matching the whole-record rule). There is
 *   nowhere to put the loser: `Phrase` has one French and one English field,
 *   and inventing a second copy of a phrase would corrupt the drill.
 *
 * With **no baseline** — the first sync ever, or a device whose baseline was
 * evicted — every deck falls back to whole-record last-write-wins, exactly as
 * T060 behaved. A missing baseline degrades the merge; it never breaks it.
 *
 * The pinned voice (T067) is neither: it is one value with no id and no
 * `updatedAt`, and it takes plain last-writer-wins — this device's, unless
 * this device has none. It used to be able to invalidate the whole audio
 * cache, which would have made that rule reckless; it cannot any more, so a
 * conflict on it changes what the next new Phrase is generated in and
 * nothing else.
 *
 * Mixes stay whole-record even with a baseline: a Mix is a name and a list of
 * Deck ids, so the loser of a Mix conflict is a selection she can re-make in
 * seconds, not text she wrote.
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
  if (base && base.schemaVersion !== local.schemaVersion) {
    throw new Error(
      `cannot merge libraries at different schema version: ${local.schemaVersion} and ${base.schemaVersion}`,
    )
  }

  const tombstones = mergeTombstones(local.tombstones ?? [], remote.tombstones ?? [])
  const decks = mergeDecks(local.decks, remote.decks, base?.decks)
  const mixes = latestById(local.mixes ?? [], remote.mixes ?? [])

  const survivingDecks = decks.filter((deck) => !isDeleted(deck, tombstones.get(key('deck', deck.id))))
  const survivingMixes = mixes.filter((mix) => !isDeleted(mix, tombstones.get(key('mix', mix.id))))

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
 * Every record from both sides, keeping the later write of any id. `local`
 * is read first, so an exact `updatedAt` tie keeps the local copy.
 */
function latestById<T extends { readonly id: string; readonly updatedAt: number }>(
  local: readonly T[],
  remote: readonly T[],
): T[] {
  const latest = new Map<string, T>()
  for (const record of [...local, ...remote]) {
    const held = latest.get(record.id)
    if (!held || record.updatedAt > held.updatedAt) latest.set(record.id, record)
  }
  return [...latest.values()]
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
 * One Deck id, held by both devices. Without a baseline there is nothing to
 * reason from and the later whole record wins (T060). With one, the three
 * cases separate — see this module's doc comment for why each answers as it
 * does.
 */
function reconcileDeck(local: DeckRecord, remote: DeckRecord, base: DeckRecord | undefined): DeckRecord {
  const localIsLater = local.updatedAt >= remote.updatedAt
  if (!base) return localIsLater ? local : remote

  const localChanged = !sameDeckContent(local, base)
  const remoteChanged = !sameDeckContent(remote, base)
  if (!localChanged) return remoteChanged ? remote : local
  if (!remoteChanged) return local

  return {
    id: local.id,
    name: localIsLater ? local.name : remote.name,
    phrases: mergePhrases(base.phrases, local.phrases, remote.phrases, localIsLater),
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
 * The Phrases of one Deck both devices changed, merged by id against the
 * baseline. Local order first, then Phrases only the other device has — so
 * the list she is drilling keeps the order she put it in, and what arrives
 * from elsewhere lands at the end where she will see it.
 */
function mergePhrases(
  base: readonly PhraseRecord[],
  local: readonly PhraseRecord[],
  remote: readonly PhraseRecord[],
  localIsLater: boolean,
): PhraseRecord[] {
  const baseById = new Map(base.map((phrase) => [phrase.id, phrase]))
  const localById = new Map(local.map((phrase) => [phrase.id, phrase]))
  const remoteById = new Map(remote.map((phrase) => [phrase.id, phrase]))
  const ids = [...new Set([...local.map((p) => p.id), ...remote.map((p) => p.id)])]

  const merged: PhraseRecord[] = []
  for (const id of ids) {
    const mine = localById.get(id)
    const theirs = remoteById.get(id)
    const before = baseById.get(id)

    if (mine && theirs) {
      // Held by both: whichever side actually moved it away from the
      // baseline is the edit. Both moved it — the one real conflict — and
      // the later Deck's text wins. Two sides that agree need no case of
      // their own: they take the first branch and push identical content.
      if (samePhrase(before, mine)) merged.push(theirs)
      else if (samePhrase(before, theirs)) merged.push(mine)
      else merged.push(localIsLater ? mine : theirs)
      continue
    }

    // Held by one side only: the other side either never had it (an
    // addition) or deleted it. A deletion only applies to a Phrase this side
    // left exactly as the baseline had it — an edit outranks a delete.
    const kept = mine ?? theirs
    if (kept && !samePhrase(before, kept)) merged.push(kept)
  }
  return merged
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
 * A record is deleted when its Tombstone is at least as recent as the record
 * itself. Strictly newer is not enough: `remove` writes the Tombstone for a
 * record it has just read, so the two can carry the same instant.
 */
function isDeleted(record: DeckRecord | MixRecord, tombstone: Tombstone | undefined): boolean {
  return tombstone !== undefined && tombstone.deletedAt >= record.updatedAt
}
