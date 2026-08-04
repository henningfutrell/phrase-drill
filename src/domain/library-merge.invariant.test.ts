import { describe, expect, it } from 'vitest'
import { LIBRARY_FORMAT, type DeckRecord, type Library, type MixRecord, type PhraseRecord, type Tombstone } from './ports'
import { mergeLibraries } from './library-merge'

/**
 * The one invariant this app cannot be allowed to break, checked against
 * generated adversarial input rather than a handful of examples (T070).
 *
 * > **A Phrase is only ever removed when something explicitly records that it
 * > was deleted.**
 *
 * Her phrases are hand-written and scanned in. They are not recoverable. Every
 * other property here is a consequence of that one: a Deck leaves the merge
 * only behind a Tombstone, a Phrase leaves it only behind THIS device's own
 * saved Deck, and nothing the merge emits was invented by the merge.
 *
 * The generator is deterministic — a seeded `mulberry32`, never `Math.random`
 * — so a failure names a seed that reproduces it exactly. It deliberately
 * produces the shapes the T068 audit found dangerous: a server rolled back off
 * the baseline, wall clocks that disagree by minutes, duplicate Phrase ids,
 * Tombstones racing edits, missing optional fields, and empty libraries on
 * either side.
 */

const VERSION = 6
const CASES = 400

/** A tiny seeded PRNG. Fixed algorithm, fixed seed: same run, every machine. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Random {
  int(bound: number): number
  pick<T>(items: readonly T[]): T
  chance(probability: number): boolean
}

function randomness(seed: number): Random {
  const next = mulberry32(seed)
  return {
    int: (bound) => Math.floor(next() * bound),
    pick: (items) => items[Math.floor(next() * items.length)]!,
    chance: (probability) => next() < probability,
  }
}

const DECK_IDS = ['d1', 'd2', 'd3']
const PHRASE_IDS = ['p1', 'p2', 'p3', 'p4']
const WORDS = ['bonjour', 'la pomme de terre', 'merci', 'bonsoir', 'la clé', 'demain']

function phrase(random: Random, id: string): PhraseRecord {
  return { id, french: random.pick(WORDS), english: random.pick(WORDS).toUpperCase() }
}

function deck(random: Random, id: string, updatedAt: number): DeckRecord {
  const phrases: PhraseRecord[] = []
  for (const phraseId of PHRASE_IDS) {
    if (random.chance(0.6)) phrases.push(phrase(random, phraseId))
    // A duplicate id: no write path enforces uniqueness, so the merge meets it.
    if (random.chance(0.08)) phrases.push(phrase(random, phraseId))
  }
  return { id, name: random.pick(['Home', 'Marché', 'Travail']), phrases, createdAt: 1, updatedAt }
}

function library(random: Random, clock: number): Library {
  const decks: DeckRecord[] = []
  for (const id of DECK_IDS) if (random.chance(0.7)) decks.push(deck(random, id, clock + random.int(50)))
  const mixes: MixRecord[] = []
  for (const id of ['m1', 'm2']) {
    if (random.chance(0.4)) {
      mixes.push({
        id,
        name: random.pick(['Mornings', 'Evenings']),
        deckIds: DECK_IDS.filter(() => random.chance(0.5)),
        createdAt: 1,
        updatedAt: clock + random.int(50),
      })
    }
  }
  return { format: LIBRARY_FORMAT, schemaVersion: VERSION, exportedAt: clock, decks, mixes, tombstones: [] }
}

/** One edit somebody made to a library, on one device, after the baseline. */
function evolve(random: Random, from: Library, clock: number): Library {
  const decks = from.decks
    // A Deck she deleted: the Tombstone below is what records it.
    .filter(() => !random.chance(0.15))
    .map((record) => {
      if (random.chance(0.4)) return record
      const phrases = record.phrases
        .filter(() => !random.chance(0.3))
        .map((held) => (random.chance(0.3) ? { ...held, french: random.pick(WORDS) } : held))
      if (random.chance(0.5)) phrases.push(phrase(random, random.pick(PHRASE_IDS)))
      return {
        ...record,
        name: random.chance(0.3) ? random.pick(['Home', 'Marché', 'Travail']) : record.name,
        phrases,
        updatedAt: clock + random.int(50),
      }
    })
  const added = random.chance(0.3) ? [deck(random, random.pick(DECK_IDS), clock)] : []
  const byId = new Map([...decks, ...added].map((record) => [record.id, record]))

  const tombstones: Tombstone[] = []
  for (const id of DECK_IDS) {
    if (!byId.has(id) && from.decks.some((record) => record.id === id) && random.chance(0.7)) {
      tombstones.push({ id, kind: 'deck', deletedAt: clock + random.int(50) })
    }
  }
  return { ...from, exportedAt: clock, decks: [...byId.values()], tombstones }
}

/**
 * The T068 attack: the server row goes backwards off the baseline — a pg_dump
 * restore, an older device's push, a hand repair — and is then written again,
 * so its clock reads NEWER than the state it has lost.
 */
function rollBack(random: Random, from: Library, clock: number): Library {
  return {
    ...from,
    exportedAt: clock,
    decks: from.decks.map((record) => ({
      ...record,
      phrases: record.phrases.filter(() => !random.chance(0.5)),
      updatedAt: clock + random.int(50),
    })),
  }
}

type PhraseKey = string

function phraseKeys(record: DeckRecord): Set<PhraseKey> {
  return new Set(record.phrases.map((held) => held.id))
}

function deckById(from: Library | undefined): Map<string, DeckRecord> {
  return new Map((from?.decks ?? []).map((record) => [record.id, record]))
}

/** One generated three-way scenario, and the merge of it. */
function scenario(seed: number): {
  local: Library
  remote: Library
  base: Library | undefined
  merged: Library
} {
  const random = randomness(seed)
  const base = library(random, 1_000)

  // Two wall clocks that do not agree — one device off, in airplane mode, or
  // with its date set by hand (T068 finding 6).
  const localClock = 2_000 + (random.chance(0.3) ? -600_000 : 0)
  const remoteClock = 2_000 + (random.chance(0.3) ? 600_000 : 0)

  const local = random.chance(0.1) ? emptied(base) : evolve(random, base, localClock)
  const remote = random.chance(0.2)
    ? rollBack(random, base, remoteClock)
    : random.chance(0.12)
      ? emptied(base)
      : evolve(random, base, remoteClock)

  const baseline = random.chance(0.2) ? undefined : random.chance(0.15) ? emptied(base) : base
  const sent = strip(random, local)
  const received = strip(random, remote)
  return { local: sent, remote: received, base: baseline, merged: mergeLibraries(sent, received, baseline) }
}

/** A library with nothing in it — an evicted phone, or a truncated server row. */
function emptied(from: Library): Library {
  return { ...from, decks: [], mixes: [], tombstones: [] }
}

/** An envelope written before Mixes (v4) or Tombstones (v5) existed. */
function strip(random: Random, from: Library): Library {
  if (!random.chance(0.15)) return from
  const stripped: Library = { ...from }
  return { ...stripped, mixes: undefined, tombstones: undefined }
}

describe('mergeLibraries — the invariant, over generated adversarial input (T070)', () => {
  const seeds = Array.from({ length: CASES }, (_, index) => index + 1)

  it('never removes a Deck without a Tombstone in the result recording the deletion', () => {
    for (const seed of seeds) {
      const { local, remote, merged } = scenario(seed)
      const survived = new Set(merged.decks.map((record) => record.id))
      const tombstoned = new Set((merged.tombstones ?? []).filter((t) => t.kind === 'deck').map((t) => t.id))

      for (const record of [...local.decks, ...remote.decks]) {
        if (survived.has(record.id)) continue
        expect({ seed, id: record.id, tombstoned: tombstoned.has(record.id) }).toEqual({
          seed,
          id: record.id,
          tombstoned: true,
        })
      }
    }
  })

  it('never removes a Phrase this device holds, unless a Tombstone removed its whole Deck', () => {
    for (const seed of seeds) {
      const { local, merged } = scenario(seed)
      const survivingDecks = deckById(merged)
      const tombstoned = new Set((merged.tombstones ?? []).filter((t) => t.kind === 'deck').map((t) => t.id))

      for (const record of local.decks) {
        const survivor = survivingDecks.get(record.id)
        if (!survivor) {
          expect({ seed, id: record.id, tombstoned: tombstoned.has(record.id) }).toEqual({
            seed,
            id: record.id,
            tombstoned: true,
          })
          continue
        }
        const kept = phraseKeys(survivor)
        for (const held of record.phrases) {
          expect({ seed, deck: record.id, phrase: held.id, kept: kept.has(held.id) }).toEqual({
            seed,
            deck: record.id,
            phrase: held.id,
            kept: true,
          })
        }
      }
    }
  })

  it('removes a Phrase the other device holds only when this device recorded the deletion', () => {
    for (const seed of seeds) {
      const { local, remote, base, merged } = scenario(seed)
      const survivingDecks = deckById(merged)
      const localDecks = deckById(local)
      const baseDecks = deckById(base)

      for (const record of remote.decks) {
        const survivor = survivingDecks.get(record.id)
        if (!survivor) continue
        const kept = phraseKeys(survivor)
        const mine = localDecks.get(record.id)
        for (const held of record.phrases) {
          if (kept.has(held.id)) continue
          // The only record of a Phrase deletion this build has: this device
          // held it at the last state both sides agreed on, and does not now.
          const deletedHere =
            mine !== undefined &&
            !phraseKeys(mine).has(held.id) &&
            (baseDecks.get(record.id)?.phrases ?? []).some((before) => before.id === held.id)
          expect({ seed, deck: record.id, phrase: held.id, deletedHere }).toEqual({
            seed,
            deck: record.id,
            phrase: held.id,
            deletedHere: true,
          })
        }
      }
    }
  })

  it('keeps every Phrase this device holds under a duplicated id — two never collapse into one', () => {
    for (const seed of seeds) {
      const { local, merged } = scenario(seed)
      const survivingDecks = deckById(merged)

      for (const record of local.decks) {
        const survivor = survivingDecks.get(record.id)
        if (!survivor) continue
        for (const id of new Set(record.phrases.map((held) => held.id))) {
          const mineAlike = record.phrases.filter((held) => held.id === id).length
          if (mineAlike < 2) continue
          const keptAlike = survivor.phrases.filter((held) => held.id === id).length
          expect({ seed, deck: record.id, phrase: id, enough: keptAlike >= mineAlike }).toEqual({
            seed,
            deck: record.id,
            phrase: id,
            enough: true,
          })
        }
      }
    }
  })

  it('invents nothing: every Phrase in the result was written on one of the two devices', () => {
    for (const seed of seeds) {
      const { local, remote, merged } = scenario(seed)
      const written = new Set(
        [...local.decks, ...remote.decks].flatMap((record) =>
          record.phrases.map((held) => `${record.id}|${held.id}|${held.french}|${held.english}`),
        ),
      )

      for (const record of merged.decks) {
        for (const held of record.phrases) {
          const token = `${record.id}|${held.id}|${held.french}|${held.english}`
          expect({ seed, token, written: written.has(token) }).toEqual({ seed, token, written: true })
        }
      }
    }
  })

  it('is pure and deterministic: same inputs, same result, and neither input touched', () => {
    for (const seed of seeds) {
      const { local, remote, base, merged } = scenario(seed)
      const before = JSON.stringify([local, remote, base ?? null])

      const again = mergeLibraries(local, remote, base)

      expect(JSON.stringify(again)).toBe(JSON.stringify(merged))
      expect(JSON.stringify([local, remote, base ?? null])).toBe(before)
    }
  })

  it('generates the shapes it claims to — a rolled-back server, skew, duplicates and empties', () => {
    const shapes = seeds.map((seed) => scenario(seed))

    expect(shapes.some(({ base }) => base === undefined)).toBe(true)
    expect(shapes.some(({ local }) => local.decks.length === 0)).toBe(true)
    expect(shapes.some(({ remote }) => remote.decks.length === 0)).toBe(true)
    expect(shapes.some(({ local }) => local.tombstones === undefined)).toBe(true)
    expect(shapes.some(({ local, remote }) => local.exportedAt !== remote.exportedAt)).toBe(true)
    expect(
      shapes.some(({ local }) =>
        local.decks.some((record) => new Set(record.phrases.map((p) => p.id)).size !== record.phrases.length),
      ),
    ).toBe(true)
    expect(shapes.some(({ merged }) => (merged.tombstones ?? []).length > 0)).toBe(true)
  })
})
