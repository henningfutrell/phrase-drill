import { describe, expect, it } from 'vitest'
import { mergeLibraries } from './library-merge'
import type { DeckRecord, Library, PhraseRecord, Tombstone } from './ports'

/**
 * T080 audit of T070 (`src/domain/library-merge.ts`).
 *
 * These tests are EXPECTED TO FAIL against the code as it stands. They are
 * evidence, not a fix. `npm test` failing with this file present is the point.
 */

const p = (id: string, french: string, english = id): PhraseRecord => ({ id, french, english })

const deck = (id: string, name: string, phrases: PhraseRecord[], updatedAt = 100): DeckRecord => ({
  id,
  name,
  phrases,
  createdAt: 1,
  updatedAt,
})

const lib = (decks: DeckRecord[], tombstones: Tombstone[] = [], schemaVersion = 6): Library => ({
  format: 'phrase-drill-library',
  schemaVersion,
  exportedAt: 1,
  decks,
  mixes: [],
  tombstones,
})

describe('T080 audit — T070 library-merge', () => {
  /**
   * FINDING 1 (high). T070 added a NEW guard:
   *
   *   if (base && base.schemaVersion !== local.schemaVersion) throw ...
   *
   * The Sync Baseline is a whole `Library` persisted verbatim in IndexedDB
   * (`sync-baseline-store.ts` — `db.put` / `db.get`, no normalization on the
   * way out). It carries the `schemaVersion` that was current when it was
   * written, and NOTHING ever migrates it.
   *
   * So the first schema bump after T070 (v6 -> v7) leaves every device that
   * has ever synced holding a v6 baseline against a v7 local library. This
   * throw then fires on EVERY round-trip, forever. The sync engine maps it to
   * `unreadable` -> `needs-update`, so the phone tells her to update an app
   * that is already up to date and stops pushing. Nothing is deleted, but
   * nothing leaves the phone either — which is the failure the whole sync
   * exists to prevent.
   *
   * The two other envelopes are both normalized before they reach the merge
   * (`normalizeLibrary` in `sync-engine.ts`). The baseline is the one that is
   * not, and it is the one this guard is aimed at.
   */
  it('a baseline written by an older schema version does not kill the merge', () => {
    const local = lib([deck('d1', 'Marché', [p('p1', 'le pain')])])
    const remote = lib([deck('d1', 'Marché', [p('p1', 'le pain')])])
    // What `sync-baseline-store.ts` would hand back on the launch after a
    // schema bump: the same records, stamped with the version in force when
    // the last successful push happened.
    const baselineFromPreviousSchema = lib([deck('d1', 'Marché', [p('p1', 'le pain')])], [], 5)

    expect(() => mergeLibraries(local, remote, baselineFromPreviousSchema)).not.toThrow()
  })

  /**
   * FINDING 2 (medium). `mergePhrases` reasons explicitly about two Phrases
   * sharing an id ("a hand-edited restore file, an import bug — no write path
   * enforces uniqueness") and keeps both rather than dropping one of hers.
   * The same reasoning is not applied one level up: two DECKS sharing an id
   * are merged independently and both emitted.
   *
   * That output is then written by `updateAll` / `importAll` with
   * `deckStore.put(record)` into a store whose keyPath is `id`, so the second
   * silently overwrites the first and every Phrase in it is gone. The merge is
   * where the duplicate could still be seen; after the put it cannot.
   *
   * Reachable by the same route `mergePhrases` names: `parseLibraryFile`
   * validates each deck record but never checks id uniqueness, so a
   * hand-edited or concatenated backup restores with one of the two decks
   * destroyed and no message.
   */
  it('two Decks sharing an id are not left for the store to collapse', () => {
    const local = lib([
      deck('d1', 'Marché', [p('p1', 'le pain')]),
      deck('d1', 'Marché (2)', [p('p2', 'le fromage')]),
    ])
    const remote = lib([deck('d1', 'Marché', [p('p1', 'le pain')])])

    const merged = mergeLibraries(local, remote, undefined)

    // Whatever the answer is — fold them, or rename one — it must not be
    // "emit both and let `put` pick". Every Phrase that went in must come out.
    const survivingPhrases = merged.decks.flatMap((d) => d.phrases.map((x) => x.id))
    const idsAreUnique = new Set(merged.decks.map((d) => d.id)).size === merged.decks.length
    expect(idsAreUnique).toBe(true)
    expect(new Set(survivingPhrases)).toEqual(new Set(['p1', 'p2']))
  })
})
