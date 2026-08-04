import type { DeckRecord, Library, MixRecord } from '../../domain'

/**
 * Give every Deck and every Mix in a library an id of its own, splitting a
 * duplicated one instead of letting the store collapse it (T090).
 *
 * ## Why this exists
 *
 * T086 taught `mergeLibraries` to keep both records under a duplicated id
 * rather than folding them into one. That was half a fix. The `decks` and
 * `mixes` object stores are keyed `{ keyPath: 'id' }`, and `replaceAll`
 * writes one `put` per record, so two records under one id meant the second
 * `put` overwrote the first — a whole Deck, with every Phrase in it, gone from
 * disk with nothing said. It reached her two ways:
 *
 * - **A restore from a hand-edited backup file** (`importAll`). The merge never
 *   saw the Deck, because it was destroyed before the merge was asked anything.
 * - **The write-back of the merged library** (`updateAll`), which is worse: the
 *   merge's now-correct output was collapsed the instant it was persisted, so
 *   T086 was unobservable end to end.
 *
 * ## Split, not refuse
 *
 * The later record keeps its content and takes a fresh id. She ends up with two
 * visible Decks under two names and merges or deletes them herself, in one tap.
 *
 * **Refusing at parse time was considered and rejected.** T086 rejected
 * refusing at MERGE time — `parseLibraryFile` had already accepted the file,
 * and throwing there parks sync at `needs-update`, which reaches her as an app
 * that has stopped. Refusing in `parseLibraryFile` is a different moment and
 * would not park anything, so it is defensible on that count; it fails on two
 * others. It covers only one of the two sites — the merge write-back is not a
 * file and has no parse step, and that is the site that makes T086 pointless —
 * so it would leave the worse half open while looking like a fix. And a
 * restore file is often the only copy of her phrases left: refusing it costs
 * her everything in it, to avoid an outcome whose whole cost is one tap. That
 * asymmetry is the opposite of `parseLibraryFile`'s `empty` refusal, where the
 * file carries nothing and refusing costs nothing.
 *
 * **Changing `keyPath` was considered and rejected.** It is the existing store
 * shape, so it is a schema change against data that is hers, and it would need
 * a migration. It is also wrong on its own terms: `get(id)`, `update(id)` and
 * `remove(id)` all assume an id names exactly one Deck, and every screen holds
 * a `DeckId` as the way to say which Deck she means. A store that could hold
 * two Decks under one id would make `DeckId` stop identifying a Deck
 * everywhere, to accommodate a shape that only ever arrives from a defective
 * file. The store shape is right; the write path was wrong.
 *
 * ## The new id
 *
 * `${id}-2`, `${id}-3`, … skipping any candidate the library already holds.
 * Two properties matter and both are load-bearing:
 *
 * - **Deterministic.** The same library splits the same way every time, so the
 *   split converges. A fresh uuid per pass would mint another Deck on every
 *   sync, forever.
 * - **Never a collision.** A candidate already in use is skipped, so splitting
 *   can never itself overwrite a record — which would be the defect again,
 *   caused by its own fix.
 *
 * Derived from the id it duplicated, so the two are recognisably one id that
 * was split rather than two unrelated Decks.
 *
 * ## What is deliberately NOT done
 *
 * - **A Mix naming the split Deck is left alone.** It keeps the original id, so
 *   it resolves to the first of the two. The reference was ambiguous before the
 *   split and adding the new id to it would be a guess about which Deck she
 *   meant; the Deck is on the Decks screen either way, and adding it to a Mix
 *   is one tap.
 * - **Her Deck name is left alone.** Two Decks under one name is a visible
 *   signal she can act on. Rewriting a name to explain a defect would edit
 *   something she wrote.
 * - **Tombstones are not split.** A Tombstone's id names the record it deletes,
 *   so a rewritten one deletes nothing. Two Tombstones of different `kind`
 *   under one id still collapse in the `tombstones` store — see this module's
 *   note in `docs/sync.md`. Nothing of hers is lost by that: the cost is a
 *   deleted Deck or Mix coming back, which is one tap, and closing it means
 *   changing that store's `keyPath` — a schema change against her data, for a
 *   shape only a hand-edited file produces.
 *
 * Pure: no I/O, no clock, and the input is not mutated.
 */
export function splitDuplicateIds(library: Library): Library {
  return {
    ...library,
    decks: splitIds<DeckRecord>(library.decks),
    mixes: splitIds<MixRecord>(library.mixes ?? []),
  }
}

/**
 * Every record, in order, with the second and later holder of any id moved to
 * one of its own. The first holder keeps the id: something has to, and keeping
 * the first is what makes an ordinary library — where nothing is duplicated —
 * pass through untouched.
 */
function splitIds<T extends { readonly id: string }>(records: readonly T[]): T[] {
  const taken = new Set(records.map((record) => record.id))
  const seen = new Set<string>()

  return records.map((record) => {
    if (!seen.has(record.id)) {
      seen.add(record.id)
      return record
    }
    const id = nextFreeId(record.id, taken)
    taken.add(id)
    seen.add(id)
    return { ...record, id }
  })
}

/** The first `${id}-n`, from 2 up, that nothing in this library already holds. */
function nextFreeId(id: string, taken: ReadonlySet<string>): string {
  let n = 2
  while (taken.has(`${id}-${n}`)) n += 1
  return `${id}-${n}`
}
