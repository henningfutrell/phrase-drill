import { describe, expect, it } from 'vitest'
import type { DeckRecord, MixRecord, PhraseRecord } from '../../domain'
import { CURRENT_SCHEMA_VERSION, DECK_MIGRATIONS } from './migrations'

/**
 * A canonical, fully-populated persisted deck record — typed directly
 * against `DeckRecord`/`PhraseRecord` (the on-disk shape written to
 * IndexedDB and to the export file; see mapping.ts/library.ts), never a
 * hand-copied field list. Because it is typed, not just literal-shaped, a
 * field added to or removed from either interface fails `npm run build`
 * immediately (TypeScript's excess-property check on object literals, and
 * missing-property check, both fire on this exact assignment) — before
 * `describeShape` below even runs.
 */
const CANONICAL_DECK_RECORD: DeckRecord = {
  id: 'd1',
  name: 'Home',
  phrases: [{ id: 'p1', french: 'Bonjour', english: 'Hello' } satisfies PhraseRecord],
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
}

/**
 * The same, for a saved Mix (T059, schema v4). It holds Deck *ids*, never a
 * copy of their Phrases — a Mix that copied Phrases would go stale the
 * moment a Deck was edited, and would make deleting a Deck a data loss
 * question instead of a resolution one.
 */
const CANONICAL_MIX_RECORD: MixRecord = {
  id: 'm1',
  name: 'Mornings',
  deckIds: ['d1', 'd2'],
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
}

/**
 * Structural descriptor of a persisted value: field names and the runtime
 * type of each field, recursively. Deliberately reports `typeof`, not the
 * value itself, so the pinned snapshot below reads as a shape ("id is a
 * string") rather than fixture trivia ("id is 'd1'") — a value edit to the
 * fixture (e.g. a different id) must not itself move the snapshot.
 */
function describeShape(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.length === 0 ? ['<empty array>'] : [describeShape(value[0])]
  }
  if (value !== null && typeof value === 'object') {
    const shape: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      shape[key] = describeShape((value as Record<string, unknown>)[key])
    }
    return shape
  }
  return typeof value
}

/**
 * Printed on a snapshot mismatch, ahead of vitest's own diff (attached as
 * `cause`) — the diff alone says *what* changed, not what to do about it.
 */
function shapeChangedHelp(subject: string): string {
  return (
    `${subject}'s persisted shape changed. This is fine ONLY if, in the same change:\n` +
    '  1. CURRENT_SCHEMA_VERSION was bumped in migrations.ts\n' +
    '  2. a migration step was registered in DECK_MIGRATIONS at the matching index\n' +
    '  3. this pinned shape was updated to match (npm test -- -u), reviewed like any other diff\n' +
    'If none of that happened, the shape change is accidental and will read back wrong on the ' +
    "user's device with no error. See src/adapters/storage/README.md."
  )
}

describe('persisted DeckRecord/PhraseRecord shape', () => {
  it('pins the exact field names and types written to IndexedDB and to the export file', () => {
    try {
      expect(describeShape(CANONICAL_DECK_RECORD)).toMatchSnapshot()
    } catch (error) {
      throw new Error(shapeChangedHelp('DeckRecord'), { cause: error })
    }
  })
})

describe('persisted MixRecord shape', () => {
  it('pins the exact field names and types written to IndexedDB and to the export file', () => {
    try {
      expect(describeShape(CANONICAL_MIX_RECORD)).toMatchSnapshot()
    } catch (error) {
      throw new Error(shapeChangedHelp('MixRecord'), { cause: error })
    }
  })
})

describe('CURRENT_SCHEMA_VERSION <-> DECK_MIGRATIONS wiring', () => {
  it('registers a migration step for every version this build claims to support', () => {
    // DECK_MIGRATIONS is indexed by the version each step migrates *from*,
    // so a build that supports up to CURRENT_SCHEMA_VERSION must have an
    // entry for every index below it (0..CURRENT_SCHEMA_VERSION - 1) —
    // including index 0, which is intentionally a throwing placeholder
    // (v0 never existed), not a silent gap. A version bump with no matching
    // migration step currently only throws the first time a real device
    // hits it; this test moves that failure to CI.
    expect(DECK_MIGRATIONS.length).toBe(CURRENT_SCHEMA_VERSION)

    for (let version = 0; version < CURRENT_SCHEMA_VERSION; version += 1) {
      expect(
        typeof DECK_MIGRATIONS[version],
        `no migration step registered for schema version ${version} -> ${version + 1}; ` +
          'add one to DECK_MIGRATIONS in migrations.ts in the same change that bumped ' +
          'CURRENT_SCHEMA_VERSION',
      ).toBe('function')
    }
  })
})
