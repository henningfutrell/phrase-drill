import type { DeckRecord, Library, MixRecord, Tombstone } from './ports'

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
 * Deliberately NOT done here: merging *inside* a Deck. Two devices editing
 * different Phrases of one Deck within one sync round-trip is the residual
 * loss, and per-Phrase merge is a much bigger design (Phrases have no
 * `updatedAt`, and no tombstones of their own) for a single-user app where
 * both devices are in the same pair of hands.
 *
 * Deliberately NOT done here either: pruning a Mix's `deckIds` of Decks this
 * merge deleted. A dead id is already tolerated at read time and kept on
 * purpose (`resolveMixDecks`), and a dead id resurrects nothing — a Mix
 * holds ids, never Phrases.
 *
 * Pure: no I/O, no clock, and neither input is mutated.
 */
export function mergeLibraries(local: Library, remote: Library): Library {
  if (local.schemaVersion !== remote.schemaVersion) {
    throw new Error(
      `cannot merge libraries at different schema version: ${local.schemaVersion} and ${remote.schemaVersion}`,
    )
  }

  const tombstones = mergeTombstones(local.tombstones ?? [], remote.tombstones ?? [])
  const decks = latestById(local.decks, remote.decks)
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
