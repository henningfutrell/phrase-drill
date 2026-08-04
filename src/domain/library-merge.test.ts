import { describe, expect, it } from 'vitest'
import { LIBRARY_FORMAT, type DeckRecord, type Library, type MixRecord, type Tombstone } from './ports'
import { mergeLibraries } from './library-merge'

/** An arbitrary shared schema version — merge only requires the two sides to agree. */
const VERSION = 5

function deck(overrides: Partial<DeckRecord> & { id: string }): DeckRecord {
  return {
    name: 'Home',
    phrases: [{ id: 'p1', french: 'Bonjour', english: 'Hello' }],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function mix(overrides: Partial<MixRecord> & { id: string }): MixRecord {
  return { name: 'Mornings', deckIds: ['d1'], createdAt: 1, updatedAt: 1, ...overrides }
}

function library(parts: {
  decks?: readonly DeckRecord[]
  mixes?: readonly MixRecord[]
  tombstones?: readonly Tombstone[]
  exportedAt?: number
}): Library {
  return {
    format: LIBRARY_FORMAT,
    schemaVersion: VERSION,
    exportedAt: parts.exportedAt ?? 0,
    decks: parts.decks ?? [],
    mixes: parts.mixes ?? [],
    tombstones: parts.tombstones ?? [],
  }
}

describe('mergeLibraries — the union half (T060: a device that never saw a Deck cannot erase it)', () => {
  it('keeps a Deck that exists only on one side, from either side', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'local' })] }),
      library({ decks: [deck({ id: 'remote' })] }),
    )

    expect(merged.decks.map((d) => d.id).sort()).toEqual(['local', 'remote'])
  })

  it('keeps the Deck with the later updatedAt when both sides hold the same id', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', name: 'Old', updatedAt: 10 })] }),
      library({ decks: [deck({ id: 'd1', name: 'New', updatedAt: 20 })] }),
    )

    expect(merged.decks).toEqual([deck({ id: 'd1', name: 'New', updatedAt: 20 })])
  })

  it('keeps the later Deck regardless of which side it is on', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', name: 'New', updatedAt: 20 })] }),
      library({ decks: [deck({ id: 'd1', name: 'Old', updatedAt: 10 })] }),
    )

    expect(merged.decks).toEqual([deck({ id: 'd1', name: 'New', updatedAt: 20 })])
  })

  it('breaks an exact updatedAt tie in favour of the local copy, deterministically', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', name: 'Local', updatedAt: 10 })] }),
      library({ decks: [deck({ id: 'd1', name: 'Remote', updatedAt: 10 })] }),
    )

    expect(merged.decks).toEqual([deck({ id: 'd1', name: 'Local', updatedAt: 10 })])
  })

  it('never loses a Phrase held on only one side of a same-id Deck: the whole later record wins', () => {
    const older = deck({ id: 'd1', updatedAt: 10, phrases: [{ id: 'p1', french: 'a', english: 'a' }] })
    const newer = deck({
      id: 'd1',
      updatedAt: 20,
      phrases: [
        { id: 'p1', french: 'a', english: 'a' },
        { id: 'p2', french: 'b', english: 'b' },
      ],
    })

    expect(mergeLibraries(library({ decks: [older] }), library({ decks: [newer] })).decks[0]!.phrases).toHaveLength(2)
  })

  it('unions saved Mixes by the same rule, so a Mix made on one device is not erased by the other', () => {
    const merged = mergeLibraries(
      library({ mixes: [mix({ id: 'local' })] }),
      library({ mixes: [mix({ id: 'remote' })] }),
    )

    expect(merged.mixes?.map((m) => m.id).sort()).toEqual(['local', 'remote'])
  })

  it('keeps the Mix with the later updatedAt when both sides hold the same id', () => {
    const merged = mergeLibraries(
      library({ mixes: [mix({ id: 'm1', name: 'Old', updatedAt: 10 })] }),
      library({ mixes: [mix({ id: 'm1', name: 'New', updatedAt: 20 })] }),
    )

    expect(merged.mixes).toEqual([mix({ id: 'm1', name: 'New', updatedAt: 20 })])
  })
})

describe('mergeLibraries — the Tombstone half (a delete must still delete)', () => {
  it('drops a Deck the other side deleted after that copy was last written', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 10 })] }),
      library({ tombstones: [{ id: 'd1', kind: 'deck', deletedAt: 20 }] }),
    )

    expect(merged.decks).toEqual([])
  })

  it('drops a Deck deleted locally even when the server still holds it', () => {
    const merged = mergeLibraries(
      library({ tombstones: [{ id: 'd1', kind: 'deck', deletedAt: 20 }] }),
      library({ decks: [deck({ id: 'd1', updatedAt: 10 })] }),
    )

    expect(merged.decks).toEqual([])
  })

  it('drops a Deck whose Tombstone carries the same instant as its last write — the delete of exactly that record', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 10 })] }),
      library({ tombstones: [{ id: 'd1', kind: 'deck', deletedAt: 10 }] }),
    )

    expect(merged.decks).toEqual([])
  })

  it('keeps a Deck written again after the delete — recreating an id beats the Tombstone', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 30 })] }),
      library({ tombstones: [{ id: 'd1', kind: 'deck', deletedAt: 20 }] }),
    )

    expect(merged.decks.map((d) => d.id)).toEqual(['d1'])
  })

  it('discards a Tombstone the recreated Deck has outlived, so it cannot delete the Deck again later', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 30 })] }),
      library({ tombstones: [{ id: 'd1', kind: 'deck', deletedAt: 20 }] }),
    )

    expect(merged.tombstones).toEqual([])
  })

  it('carries every still-effective Tombstone into the result, so the next device to merge also deletes', () => {
    const merged = mergeLibraries(
      library({ tombstones: [{ id: 'd1', kind: 'deck', deletedAt: 20 }] }),
      library({ decks: [deck({ id: 'd1', updatedAt: 10 })] }),
    )

    expect(merged.tombstones).toEqual([{ id: 'd1', kind: 'deck', deletedAt: 20 }])
  })

  it('deletes a Mix by its own Tombstone, and never by a Deck Tombstone that happens to share an id', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'shared', updatedAt: 10 })], mixes: [mix({ id: 'shared', updatedAt: 10 })] }),
      library({ tombstones: [{ id: 'shared', kind: 'mix', deletedAt: 20 }] }),
    )

    expect(merged.mixes).toEqual([])
    expect(merged.decks.map((d) => d.id)).toEqual(['shared'])
  })

  it('leaves a deleted Deck deleted even when a surviving Mix still names it — a dead id resurrects nothing', () => {
    const merged = mergeLibraries(
      library({ mixes: [mix({ id: 'm1', deckIds: ['d1'], updatedAt: 30 })] }),
      library({ decks: [deck({ id: 'd1', updatedAt: 10 })], tombstones: [{ id: 'd1', kind: 'deck', deletedAt: 20 }] }),
    )

    expect(merged.decks).toEqual([])
    expect(merged.mixes?.[0]!.deckIds).toEqual(['d1'])
  })

  it('keeps the later deletedAt when both sides deleted the same Deck', () => {
    const merged = mergeLibraries(
      library({ tombstones: [{ id: 'd1', kind: 'deck', deletedAt: 20 }] }),
      library({ tombstones: [{ id: 'd1', kind: 'deck', deletedAt: 50 }] }),
    )

    expect(merged.tombstones).toEqual([{ id: 'd1', kind: 'deck', deletedAt: 50 }])
  })

  it('keeps the later deletedAt whichever side holds it', () => {
    const merged = mergeLibraries(
      library({ tombstones: [{ id: 'd1', kind: 'deck', deletedAt: 50 }] }),
      library({ tombstones: [{ id: 'd1', kind: 'deck', deletedAt: 20 }] }),
    )

    expect(merged.tombstones).toEqual([{ id: 'd1', kind: 'deck', deletedAt: 50 }])
  })

  it('unions Tombstones from both sides', () => {
    const merged = mergeLibraries(
      library({ tombstones: [{ id: 'a', kind: 'deck', deletedAt: 1 }] }),
      library({ tombstones: [{ id: 'b', kind: 'mix', deletedAt: 2 }] }),
    )

    expect(merged.tombstones?.map((t) => t.id).sort()).toEqual(['a', 'b'])
  })

  it('treats a remote library from before Mixes and Tombstones existed as having none of either', () => {
    const before: Library = { format: LIBRARY_FORMAT, schemaVersion: VERSION, exportedAt: 0, decks: [deck({ id: 'd2' })] }

    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1' })], mixes: [mix({ id: 'm1' })] }),
      before,
    )

    expect(merged.decks.map((d) => d.id).sort()).toEqual(['d1', 'd2'])
    expect(merged.mixes).toEqual([mix({ id: 'm1' })])
    expect(merged.tombstones).toEqual([])
  })

  it('treats a local library from before Mixes and Tombstones existed as having none of either', () => {
    const before: Library = { format: LIBRARY_FORMAT, schemaVersion: VERSION, exportedAt: 0, decks: [deck({ id: 'd1' })] }

    const merged = mergeLibraries(
      before,
      library({ decks: [deck({ id: 'd2' })], mixes: [mix({ id: 'm1' })] }),
    )

    expect(merged.decks.map((d) => d.id).sort()).toEqual(['d1', 'd2'])
    expect(merged.mixes).toEqual([mix({ id: 'm1' })])
    expect(merged.tombstones).toEqual([])
  })

  it('keeps a Mix written again after the delete, and discards the Tombstone it outlived', () => {
    const merged = mergeLibraries(
      library({ mixes: [mix({ id: 'm1', updatedAt: 30 })] }),
      library({ tombstones: [{ id: 'm1', kind: 'mix', deletedAt: 20 }] }),
    )

    expect(merged.mixes).toEqual([mix({ id: 'm1', updatedAt: 30 })])
    expect(merged.tombstones).toEqual([])
  })
})

describe('mergeLibraries — the envelope', () => {
  it('carries the shared format and schema version through', () => {
    const merged = mergeLibraries(library({}), library({}))

    expect(merged.format).toBe(LIBRARY_FORMAT)
    expect(merged.schemaVersion).toBe(VERSION)
  })

  it('takes the later exportedAt, so the merged snapshot is never dated older than its newest input', () => {
    expect(mergeLibraries(library({ exportedAt: 100 }), library({ exportedAt: 300 })).exportedAt).toBe(300)
    expect(mergeLibraries(library({ exportedAt: 300 }), library({ exportedAt: 100 })).exportedAt).toBe(300)
  })

  it('refuses two libraries at different schema versions rather than comparing records of different shapes', () => {
    const older: Library = { ...library({}), schemaVersion: VERSION - 1 }

    expect(() => mergeLibraries(library({}), older)).toThrow(/schema version/)
  })

  it('mutates neither input', () => {
    const local = library({
      decks: [deck({ id: 'd1', updatedAt: 10 })],
      tombstones: [{ id: 'gone', kind: 'deck', deletedAt: 1 }],
    })
    const remote = library({ decks: [deck({ id: 'd2', updatedAt: 20 })], mixes: [mix({ id: 'm1' })] })
    const localBefore = JSON.stringify(local)
    const remoteBefore = JSON.stringify(remote)

    mergeLibraries(local, remote)

    expect(JSON.stringify(local)).toBe(localBefore)
    expect(JSON.stringify(remote)).toBe(remoteBefore)
  })
})

/**
 * The three-way half (T034). T060 merged whole records: two devices editing
 * different Phrases of the SAME Deck inside one round-trip still lost one
 * side, because the later whole Deck replaced the earlier whole Deck. Given
 * the last state both devices agreed on — the baseline — that loss is
 * avoidable without giving a Phrase a timestamp of its own.
 */
describe('mergeLibraries — the three-way half (T034: two devices editing one Deck)', () => {
  const P1 = { id: 'p1', french: 'Bonjour', english: 'Hello' }
  const P2 = { id: 'p2', french: 'Merci', english: 'Thanks' }
  const P3 = { id: 'p3', french: 'Bonsoir', english: 'Good evening' }

  /** The state both devices last agreed on: one Deck, one Phrase. */
  const base = library({ decks: [deck({ id: 'd1', updatedAt: 1, phrases: [P1] })] })

  it('keeps a Phrase added on each device to the same Deck — neither side is discarded', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 10, phrases: [P1, P2] })] }),
      library({ decks: [deck({ id: 'd1', updatedAt: 20, phrases: [P1, P3] })] }),
      base,
    )

    expect(merged.decks[0]!.phrases.map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
  })

  it('keeps both additions whichever device wrote later', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 30, phrases: [P1, P2] })] }),
      library({ decks: [deck({ id: 'd1', updatedAt: 20, phrases: [P1, P3] })] }),
      base,
    )

    expect(merged.decks[0]!.phrases.map((p) => p.id).sort()).toEqual(['p1', 'p2', 'p3'])
  })

  it('keeps a Phrase edited on one device while the other added a different Phrase', () => {
    const edited = { ...P1, french: 'Salut' }
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 10, phrases: [edited] })] }),
      library({ decks: [deck({ id: 'd1', updatedAt: 20, phrases: [P1, P2] })] }),
      base,
    )

    expect(merged.decks[0]!.phrases).toEqual([edited, P2])
  })

  it('applies a Phrase the other device deleted, when this one never touched it', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 10, phrases: [P1, P2] })] }),
      library({ decks: [deck({ id: 'd1', updatedAt: 20, phrases: [] })] }),
      library({ decks: [deck({ id: 'd1', updatedAt: 1, phrases: [P1] })] }),
    )

    expect(merged.decks[0]!.phrases.map((p) => p.id)).toEqual(['p2'])
  })

  it('applies a deletion made on this device, when the other never touched that Phrase', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 10, phrases: [] })] }),
      library({ decks: [deck({ id: 'd1', updatedAt: 20, phrases: [P1, P2] })] }),
      library({ decks: [deck({ id: 'd1', updatedAt: 1, phrases: [P1] })] }),
    )

    expect(merged.decks[0]!.phrases.map((p) => p.id)).toEqual(['p2'])
  })

  it('keeps a Phrase one device edited and the other deleted — an edit is never discarded by a delete', () => {
    const edited = { ...P1, french: 'Salut' }
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 10, phrases: [edited] })] }),
      library({ decks: [deck({ id: 'd1', updatedAt: 20, phrases: [] })] }),
      base,
    )

    expect(merged.decks[0]!.phrases).toEqual([edited])
  })

  it('keeps the edit whichever side of the merge deleted the Phrase', () => {
    const edited = { ...P1, french: 'Salut' }
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 10, phrases: [] })] }),
      library({ decks: [deck({ id: 'd1', updatedAt: 20, phrases: [edited] })] }),
      base,
    )

    expect(merged.decks[0]!.phrases).toEqual([edited])
  })

  it('takes the later Deck\'s text when both devices edited the same Phrase — the one real conflict', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 10, phrases: [{ ...P1, french: 'Older' }] })] }),
      library({ decks: [deck({ id: 'd1', updatedAt: 20, phrases: [{ ...P1, french: 'Newer' }] })] }),
      base,
    )

    expect(merged.decks[0]!.phrases).toEqual([{ ...P1, french: 'Newer' }])
  })

  it('breaks a same-Phrase conflict at an exact updatedAt tie in favour of the local copy', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 10, phrases: [{ ...P1, french: 'Local' }] })] }),
      library({ decks: [deck({ id: 'd1', updatedAt: 10, phrases: [{ ...P1, french: 'Remote' }] })] }),
      base,
    )

    expect(merged.decks[0]!.phrases).toEqual([{ ...P1, french: 'Local' }])
  })

  it('takes the whole record of the only side that changed, deletions included', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 1, phrases: [P1] })] }),
      library({ decks: [deck({ id: 'd1', updatedAt: 20, phrases: [] })] }),
      base,
    )

    expect(merged.decks[0]!.phrases).toEqual([])
  })

  it('leaves a Deck neither device changed exactly as the baseline had it', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 1, phrases: [P1] })] }),
      library({ decks: [deck({ id: 'd1', updatedAt: 1, phrases: [P1] })] }),
      base,
    )

    expect(merged.decks).toEqual([deck({ id: 'd1', updatedAt: 1, phrases: [P1] })])
  })

  it('keeps the later name when both devices renamed the same Deck', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', name: 'Older', updatedAt: 10, phrases: [P1, P2] })] }),
      library({ decks: [deck({ id: 'd1', name: 'Newer', updatedAt: 20, phrases: [P1, P3] })] }),
      base,
    )

    expect(merged.decks[0]!.name).toBe('Newer')
  })

  it('keeps the local name at an exact updatedAt tie, matching the whole-record rule', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', name: 'Local', updatedAt: 10, phrases: [P1, P2] })] }),
      library({ decks: [deck({ id: 'd1', name: 'Remote', updatedAt: 10, phrases: [P1, P3] })] }),
      base,
    )

    expect(merged.decks[0]!.name).toBe('Local')
  })

  it('dates a merged Deck by the later write and the earlier creation — it holds data from both', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', createdAt: 5, updatedAt: 10, phrases: [P1, P2] })] }),
      library({ decks: [deck({ id: 'd1', createdAt: 2, updatedAt: 20, phrases: [P1, P3] })] }),
      base,
    )

    expect(merged.decks[0]!.updatedAt).toBe(20)
    expect(merged.decks[0]!.createdAt).toBe(2)
  })

  it('unions the Phrases of a same-id Deck with no baseline at all — nothing says either side deleted anything (T070)', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 10, phrases: [P1, P2] })] }),
      library({ decks: [deck({ id: 'd1', updatedAt: 20, phrases: [P1, P3] })] }),
    )

    expect(merged.decks[0]!.phrases.map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
  })

  it('takes the later record\'s name and dates with no baseline, while still keeping every Phrase', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', name: 'Older', updatedAt: 10, phrases: [P1, P2] })] }),
      library({ decks: [deck({ id: 'd1', name: 'Newer', updatedAt: 20, phrases: [P1, P3] })] }),
    )

    expect(merged.decks[0]!.name).toBe('Newer')
    expect(merged.decks[0]!.updatedAt).toBe(20)
  })

  it('unions the Phrases of a Deck the baseline never saw', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'other', updatedAt: 10, phrases: [P1, P2] })] }),
      library({ decks: [deck({ id: 'other', updatedAt: 20, phrases: [P1, P3] })] }),
      base,
    )

    expect(merged.decks[0]!.phrases.map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
  })

  it('still deletes a Deck by Tombstone when neither device rewrote it since the baseline', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 10, phrases: [P1] })] }),
      library({
        decks: [deck({ id: 'd1', updatedAt: 20, phrases: [P1] })],
        tombstones: [{ id: 'd1', kind: 'deck', deletedAt: 30 }],
      }),
      base,
    )

    expect(merged.decks).toEqual([])
  })

  it('merges saved Mixes by last-write-wins even with a baseline — a Mix is a small list of ids, not phrases', () => {
    const merged = mergeLibraries(
      library({ mixes: [mix({ id: 'm1', deckIds: ['a'], updatedAt: 10 })] }),
      library({ mixes: [mix({ id: 'm1', deckIds: ['b'], updatedAt: 20 })] }),
      library({ mixes: [mix({ id: 'm1', deckIds: [], updatedAt: 1 })] }),
    )

    expect(merged.mixes).toEqual([mix({ id: 'm1', deckIds: ['b'], updatedAt: 20 })])
  })

  it('mutates no input, the baseline included', () => {
    const local = library({ decks: [deck({ id: 'd1', updatedAt: 10, phrases: [P1, P2] })] })
    const remote = library({ decks: [deck({ id: 'd1', updatedAt: 20, phrases: [P1, P3] })] })
    const before = [local, remote, base].map((l) => JSON.stringify(l))

    mergeLibraries(local, remote, base)

    expect([local, remote, base].map((l) => JSON.stringify(l))).toEqual(before)
  })

  it('refuses a baseline at a different schema version rather than comparing records of different shapes', () => {
    const older: Library = { ...base, schemaVersion: VERSION - 1 }

    expect(() => mergeLibraries(library({}), library({}), older)).toThrow(/schema version/)
  })
})

/**
 * What counts as a change, and what a change does to the record around it.
 * Every case here was located by a surviving mutant: the merge took the right
 * answer for the wrong reason, and nothing in the suite could tell.
 */
describe('mergeLibraries — what the baseline says changed (T034)', () => {
  const P1 = { id: 'p1', french: 'Bonjour', english: 'Hello' }
  const P2 = { id: 'p2', french: 'Merci', english: 'Thanks' }
  const P4 = { id: 'p4', french: 'Salut', english: 'Hi' }

  const base = library({ decks: [deck({ id: 'd1', name: 'Home', updatedAt: 1, phrases: [P1] })] })

  it('hands back the other device\'s record whole when this one only re-saved without changing anything', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', name: 'Home', updatedAt: 30, phrases: [P1] })] }),
      library({ decks: [deck({ id: 'd1', name: 'Renamed', updatedAt: 20, phrases: [P1] })] }),
      base,
    )

    expect(merged.decks[0]!.name).toBe('Renamed')
    expect(merged.decks[0]!.updatedAt).toBe(20)
  })

  it('hands back this device\'s record whole when the other only re-saved without changing anything', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', name: 'Renamed', updatedAt: 10, phrases: [P1] })] }),
      library({ decks: [deck({ id: 'd1', name: 'Home', updatedAt: 40, phrases: [P1] })] }),
      base,
    )

    expect(merged.decks[0]!.name).toBe('Renamed')
    expect(merged.decks[0]!.updatedAt).toBe(10)
  })

  it('counts a rename with no Phrase touched as a change, so the other device\'s new Phrase joins it', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', name: 'Renamed', updatedAt: 30, phrases: [P1] })] }),
      library({ decks: [deck({ id: 'd1', name: 'Home', updatedAt: 20, phrases: [P1, P2] })] }),
      base,
    )

    expect(merged.decks[0]!.name).toBe('Renamed')
    expect(merged.decks[0]!.phrases.map((p) => p.id)).toEqual(['p1', 'p2'])
  })

  it('counts an edit inside an equally long list as a change', () => {
    const twoPhrases = library({ decks: [deck({ id: 'd1', updatedAt: 1, phrases: [P1, P2] })] })
    const edited = { ...P2, french: 'Merci beaucoup' }

    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 30, phrases: [P1, edited] })] }),
      library({ decks: [deck({ id: 'd1', updatedAt: 20, phrases: [P1, P2, P4] })] }),
      twoPhrases,
    )

    expect(merged.decks[0]!.phrases).toEqual([P1, edited, P4])
  })

  it('counts a Phrase retyped under a new id as a change, not as the Phrase it replaced', () => {
    const retyped = { id: 'pX', french: 'Bonjour', english: 'Hello' }

    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 30, phrases: [retyped] })] }),
      library({ decks: [deck({ id: 'd1', updatedAt: 20, phrases: [P1, P2] })] }),
      base,
    )

    expect(merged.decks[0]!.phrases).toEqual([retyped, P2])
  })

  it('counts a correction to the English side alone as a change, so a delete elsewhere cannot drop it', () => {
    const corrected = { ...P1, english: 'Good morning' }

    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 30, phrases: [corrected] })] }),
      library({ decks: [deck({ id: 'd1', updatedAt: 20, phrases: [] })] }),
      base,
    )

    expect(merged.decks[0]!.phrases).toEqual([corrected])
  })

  it('takes the other device\'s edit of a Phrase this one left alone, even when this device wrote later', () => {
    const theirEdit = { ...P1, french: 'Salut' }

    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 30, phrases: [P1, P2] })] }),
      library({ decks: [deck({ id: 'd1', updatedAt: 20, phrases: [theirEdit] })] }),
      base,
    )

    expect(merged.decks[0]!.phrases).toEqual([theirEdit, P2])
  })

  it('keeps the later Mix whichever side of the merge holds it', () => {
    const merged = mergeLibraries(
      library({ mixes: [mix({ id: 'm1', name: 'New', updatedAt: 20 })] }),
      library({ mixes: [mix({ id: 'm1', name: 'Old', updatedAt: 10 })] }),
    )

    expect(merged.mixes).toEqual([mix({ id: 'm1', name: 'New', updatedAt: 20 })])
  })

  it('breaks an exact updatedAt tie between two Mixes in favour of the local copy', () => {
    const merged = mergeLibraries(
      library({ mixes: [mix({ id: 'm1', name: 'Local', updatedAt: 10 })] }),
      library({ mixes: [mix({ id: 'm1', name: 'Remote', updatedAt: 10 })] }),
    )

    expect(merged.mixes).toEqual([mix({ id: 'm1', name: 'Local', updatedAt: 10 })])
  })
})

/**
 * T070, from the T068 audit. The server is not guaranteed to be a descendant
 * of the baseline: restoring the `pg_dump` backup (the documented recovery
 * procedure), an older device winning a concurrent push, or any hand repair
 * of `libraries.data` moves it backwards. The old merge read "in the
 * baseline, unchanged here, absent there" as *they deleted it*, which is only
 * sound against a descendant — so the recovery procedure deleted her phrases
 * off the phone and off the server in one round-trip, with no Tombstone.
 *
 * The rule now: **the other side's absence is never a deletion.** A Phrase
 * leaves a merged Deck only when THIS device's own saved Deck no longer holds
 * one the baseline says it once did — this device's write is the only record
 * of a Phrase deletion this build has, and a record is what a deletion needs.
 */
describe('mergeLibraries — a rolled-back server cannot delete a Phrase (T070)', () => {
  const P1 = { id: 'p1', french: 'Bonjour', english: 'Hello' }
  const P2 = { id: 'p2', french: 'la pomme de terre', english: 'the potato' }
  const P3 = { id: 'p3', french: 'Bonsoir', english: 'Good evening' }

  /** What this device pushed and the server accepted: both Phrases. */
  const base = library({ decks: [deck({ id: 'd1', name: 'Marché', updatedAt: 5000, phrases: [P1, P2] })] })

  it('keeps a Phrase the rolled-back server dropped, when this device never touched the Deck', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', name: 'Marché', updatedAt: 5000, phrases: [P1, P2] })] }),
      library({ decks: [deck({ id: 'd1', name: 'Marche', updatedAt: 6000, phrases: [P1] })] }),
      base,
    )

    expect(merged.decks[0]!.phrases.map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(merged.tombstones).toEqual([])
  })

  it('keeps a Phrase the rolled-back server dropped while this device was editing the same Deck', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', name: 'Marché', updatedAt: 7000, phrases: [P1, P2, P3] })] }),
      library({ decks: [deck({ id: 'd1', name: 'Marche', updatedAt: 6000, phrases: [P1] })] }),
      base,
    )

    expect(merged.decks[0]!.phrases.map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
  })

  it('keeps a Phrase the rolled-back server dropped even when it also renamed and re-added others', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', name: 'Marché', updatedAt: 5000, phrases: [P1, P2] })] }),
      library({ decks: [deck({ id: 'd1', name: 'Marche', updatedAt: 9000, phrases: [P1, P3] })] }),
      base,
    )

    expect(merged.decks[0]!.phrases.map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
  })

  it('still applies a deletion this device made — its own saved Deck is the record of it', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', name: 'Marché', updatedAt: 6000, phrases: [P1] })] }),
      library({ decks: [deck({ id: 'd1', name: 'Marché', updatedAt: 5000, phrases: [P1, P2] })] }),
      base,
    )

    expect(merged.decks[0]!.phrases.map((p) => p.id)).toEqual(['p1'])
  })

  it('still applies a deletion this device made while the other device added a different Phrase', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', name: 'Marché', updatedAt: 6000, phrases: [P1] })] }),
      library({ decks: [deck({ id: 'd1', name: 'Marché', updatedAt: 9000, phrases: [P1, P2, P3] })] }),
      base,
    )

    expect(merged.decks[0]!.phrases.map((p) => p.id)).toEqual(['p1', 'p3'])
  })

  it('keeps a Phrase this device deleted and the other device edited — an edit still outranks a delete', () => {
    const theirEdit = { ...P2, french: 'la patate' }
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', name: 'Marché', updatedAt: 6000, phrases: [P1] })] }),
      library({ decks: [deck({ id: 'd1', name: 'Marché', updatedAt: 9000, phrases: [P1, theirEdit] })] }),
      base,
    )

    expect(merged.decks[0]!.phrases).toEqual([P1, theirEdit])
  })
})

/**
 * T070, from the T068 audit. `Map`s keyed by Phrase id collapsed two Phrases
 * sharing an id into one. Nothing on the write path enforces uniqueness, so a
 * hand-edited restore file or an import bug is enough to produce it — and the
 * merge answered by throwing one of them away.
 */
describe('mergeLibraries — duplicate Phrase ids are kept, never collapsed (T070)', () => {
  const P1 = { id: 'p1', french: 'a', english: 'A' }
  const TWIN = { id: 'p1', french: 'une phrase entièrement différente', english: 'a different phrase' }
  const P9 = { id: 'p9', french: 'z', english: 'Z' }

  const base = library({ decks: [deck({ id: 'd1', updatedAt: 1000, phrases: [P1] })] })

  it('keeps both Phrases that share an id when both devices changed the Deck', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 2000, phrases: [P1, TWIN] })] }),
      library({ decks: [deck({ id: 'd1', updatedAt: 3000, phrases: [P1, P9] })] }),
      base,
    )

    expect(merged.decks[0]!.phrases).toEqual([P1, TWIN, P9])
  })

  it('keeps both Phrases that share an id with no baseline at all', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 2000, phrases: [P1, TWIN] })] }),
      library({ decks: [deck({ id: 'd1', updatedAt: 3000, phrases: [P1] })] }),
    )

    expect(merged.decks[0]!.phrases).toEqual([P1, TWIN])
  })

  it('keeps a duplicate id the other device holds', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 3000, phrases: [P1] })] }),
      library({ decks: [deck({ id: 'd1', updatedAt: 2000, phrases: [P1, TWIN] })] }),
      base,
    )

    expect(merged.decks[0]!.phrases).toEqual([P1, TWIN])
  })

  it('does not duplicate a shared id further when both sides hold the same twins', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 2000, phrases: [P1, TWIN] })] }),
      library({ decks: [deck({ id: 'd1', updatedAt: 3000, phrases: [P1, TWIN] })] }),
      base,
    )

    expect(merged.decks[0]!.phrases).toEqual([P1, TWIN])
  })

  it('keeps a duplicate id the baseline itself carries', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 2000, phrases: [P1, TWIN] })] }),
      library({ decks: [deck({ id: 'd1', updatedAt: 3000, phrases: [P1, TWIN, P9] })] }),
      library({ decks: [deck({ id: 'd1', updatedAt: 1000, phrases: [P1, TWIN] })] }),
    )

    expect(merged.decks[0]!.phrases).toEqual([P1, TWIN, P9])
  })
})

/**
 * T070, from the T068 audit. Whole-record last-write-wins and the
 * `deletedAt >= updatedAt` Tombstone rule compare two unsynchronized wall
 * clocks, and Tombstones are never garbage-collected — so one phone that has
 * been off, in airplane mode, or had its date set by hand poisons a record
 * permanently.
 *
 * There is no logical clock here, and adding one would change the persisted
 * envelope. What the merge does have is the baseline, which is causal rather
 * than chronological: a record that differs from the last state both sides
 * agreed on was written AFTER that agreement, whatever any clock says. So a
 * Tombstone deletes only a record the deleting side can be shown to have
 * seen. Where there is no baseline, the clock is all there is, and that
 * exposure is pinned below rather than papered over.
 */
describe('mergeLibraries — a Tombstone deletes only what the deleting side saw (T070)', () => {
  const P1 = { id: 'p1', french: 'Bonjour', english: 'Hello' }

  it('keeps a Deck created since the baseline, whatever the deleting device\'s clock said', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 120_000, phrases: [P1] })] }),
      library({ tombstones: [{ id: 'd1', kind: 'deck', deletedAt: 300_000 }] }),
      library({ decks: [] }),
    )

    expect(merged.decks.map((d) => d.id)).toEqual(['d1'])
  })

  it('drops the outlived Tombstone too, so the next merge cannot delete the Deck again', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 120_000, phrases: [P1] })] }),
      library({ tombstones: [{ id: 'd1', kind: 'deck', deletedAt: 300_000 }] }),
      library({ decks: [] }),
    )

    expect(merged.tombstones).toEqual([])
  })

  it('keeps a Deck edited since the baseline against a Tombstone from a device that ran fast', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', name: 'Renamed', updatedAt: 120_000, phrases: [P1] })] }),
      library({ tombstones: [{ id: 'd1', kind: 'deck', deletedAt: 300_000 }] }),
      library({ decks: [deck({ id: 'd1', name: 'Home', updatedAt: 100_000, phrases: [P1] })] }),
    )

    expect(merged.decks.map((d) => d.id)).toEqual(['d1'])
  })

  it('keeps a restored Deck the server still holds a Tombstone for — the one delete a backup exists for', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 1000, phrases: [P1] })] }),
      library({ tombstones: [{ id: 'd1', kind: 'deck', deletedAt: 2000 }] }),
      library({ decks: [] }),
    )

    expect(merged.decks.map((d) => d.id)).toEqual(['d1'])
  })

  it('keeps a Mix rewritten since the baseline against a Tombstone that claims to be newer', () => {
    const merged = mergeLibraries(
      library({ mixes: [mix({ id: 'm1', name: 'Renamed', updatedAt: 120_000 })] }),
      library({ tombstones: [{ id: 'm1', kind: 'mix', deletedAt: 300_000 }] }),
      library({ mixes: [mix({ id: 'm1', name: 'Mornings', updatedAt: 100_000 })] }),
    )

    expect(merged.mixes?.map((m) => m.id)).toEqual(['m1'])
  })

  it('still deletes a Deck neither side has touched since the baseline', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 100_000, phrases: [P1] })] }),
      library({ tombstones: [{ id: 'd1', kind: 'deck', deletedAt: 300_000 }] }),
      library({ decks: [deck({ id: 'd1', updatedAt: 100_000, phrases: [P1] })] }),
    )

    expect(merged.decks).toEqual([])
  })

  it('still deletes a Mix neither side has touched since the baseline', () => {
    const merged = mergeLibraries(
      library({ mixes: [mix({ id: 'm1', updatedAt: 100_000 })] }),
      library({ tombstones: [{ id: 'm1', kind: 'mix', deletedAt: 300_000 }] }),
      library({ mixes: [mix({ id: 'm1', updatedAt: 100_000 })] }),
    )

    expect(merged.mixes).toEqual([])
  })

  /**
   * The residual exposure, pinned rather than hidden: the first sync ever, or
   * one after IndexedDB evicted the baseline, has nothing causal to reason
   * from, so the clock decides. A Deck written on a slow device can still be
   * deleted by a Tombstone from a fast one — for exactly one round-trip,
   * after which a baseline exists again.
   */
  it('falls back to the clock with no baseline, which is all there is to fall back to', () => {
    const merged = mergeLibraries(
      library({ decks: [deck({ id: 'd1', updatedAt: 120_000, phrases: [P1] })] }),
      library({ tombstones: [{ id: 'd1', kind: 'deck', deletedAt: 300_000 }] }),
    )

    expect(merged.decks).toEqual([])
  })
})

/**
 * T070. A Mix reconciles against the baseline the same way a Deck does, so a
 * wrong clock cannot discard a selection the other device never touched.
 * Its CONTENTS stay whole-record — a Mix is a name and a list of Deck ids.
 */
describe('mergeLibraries — a Mix the other device never touched keeps its edit (T070)', () => {
  it('takes this device\'s edit when the other side is unchanged from the baseline, later clock or not', () => {
    const merged = mergeLibraries(
      library({ mixes: [mix({ id: 'm1', deckIds: ['a', 'b'], updatedAt: 10 })] }),
      library({ mixes: [mix({ id: 'm1', deckIds: ['a'], updatedAt: 900 })] }),
      library({ mixes: [mix({ id: 'm1', deckIds: ['a'], updatedAt: 5 })] }),
    )

    expect(merged.mixes?.[0]!.deckIds).toEqual(['a', 'b'])
  })

  it('takes the other device\'s edit when this side is unchanged from the baseline', () => {
    const merged = mergeLibraries(
      library({ mixes: [mix({ id: 'm1', deckIds: ['a'], updatedAt: 900 })] }),
      library({ mixes: [mix({ id: 'm1', deckIds: ['a', 'b'], updatedAt: 10 })] }),
      library({ mixes: [mix({ id: 'm1', deckIds: ['a'], updatedAt: 5 })] }),
    )

    expect(merged.mixes?.[0]!.deckIds).toEqual(['a', 'b'])
  })

  it('counts a rename alone as a change', () => {
    const merged = mergeLibraries(
      library({ mixes: [mix({ id: 'm1', name: 'Evenings', updatedAt: 10 })] }),
      library({ mixes: [mix({ id: 'm1', name: 'Mornings', updatedAt: 900 })] }),
      library({ mixes: [mix({ id: 'm1', name: 'Mornings', updatedAt: 5 })] }),
    )

    expect(merged.mixes?.[0]!.name).toBe('Evenings')
  })

  it('counts a reordered Deck list as a change', () => {
    const merged = mergeLibraries(
      library({ mixes: [mix({ id: 'm1', deckIds: ['b', 'a'], updatedAt: 10 })] }),
      library({ mixes: [mix({ id: 'm1', deckIds: ['a', 'b'], updatedAt: 900 })] }),
      library({ mixes: [mix({ id: 'm1', deckIds: ['a', 'b'], updatedAt: 5 })] }),
    )

    expect(merged.mixes?.[0]!.deckIds).toEqual(['b', 'a'])
  })

  it('leaves a Mix neither device changed exactly as it was', () => {
    const merged = mergeLibraries(
      library({ mixes: [mix({ id: 'm1', updatedAt: 10 })] }),
      library({ mixes: [mix({ id: 'm1', updatedAt: 900 })] }),
      library({ mixes: [mix({ id: 'm1', updatedAt: 5 })] }),
    )

    expect(merged.mixes).toEqual([mix({ id: 'm1', updatedAt: 10 })])
  })

  it('falls back to the later write when both devices changed the same Mix', () => {
    const merged = mergeLibraries(
      library({ mixes: [mix({ id: 'm1', deckIds: ['a'], updatedAt: 10 })] }),
      library({ mixes: [mix({ id: 'm1', deckIds: ['b'], updatedAt: 20 })] }),
      library({ mixes: [mix({ id: 'm1', deckIds: [], updatedAt: 5 })] }),
    )

    expect(merged.mixes?.[0]!.deckIds).toEqual(['b'])
  })

  it('keeps a Mix the baseline never saw, resolving it by the later write', () => {
    const merged = mergeLibraries(
      library({ mixes: [mix({ id: 'm1', deckIds: ['a'], updatedAt: 10 })] }),
      library({ mixes: [mix({ id: 'm1', deckIds: ['b'], updatedAt: 20 })] }),
      library({ mixes: [] }),
    )

    expect(merged.mixes?.[0]!.deckIds).toEqual(['b'])
  })
})
