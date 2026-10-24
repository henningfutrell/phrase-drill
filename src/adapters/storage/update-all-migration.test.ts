import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LIBRARY_FORMAT, type Library } from '../../domain'
import { resetFakeIdb } from './idb.test-support'
import { CURRENT_SCHEMA_VERSION } from './migrations'

/**
 * T096, item 1 — `updateAll` wrote the MIGRATED records and returned the
 * unmigrated ones (T091 audit).
 *
 *   indexed-db-deck-store.ts  if (sameLibraryContent(stored, next)) { ...
 *   indexed-db-deck-store.ts  await replaceAll(..., migratedDecks, ...)
 *   indexed-db-deck-store.ts  return { library: next, changed: true }
 *
 * Disk got `migrateLibraryDecks(next)`; the caller got `next`, and the skip
 * compared `next` too. The sync engine pushes what is returned and writes it
 * into the Sync Baseline, so the server and the baseline describe records
 * this phone does not hold. Every deck migration is the identity today, which
 * is why nothing has shown it yet. The first real one (the Phrase Tombstone
 * work, T073) makes it a live divergence.
 *
 * So this file stands in that first real migration: every deck record below
 * the current schema gets its name trimmed. The rest of `migrations.ts` is
 * the real module.
 */
vi.mock('./migrations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./migrations')>()
  return {
    ...actual,
    migrateDeckRecord(record: unknown, fromVersion: number) {
      const migrated = actual.migrateDeckRecord(record, fromVersion)
      return fromVersion < actual.CURRENT_SCHEMA_VERSION
        ? { ...migrated, name: migrated.name.trim() }
        : migrated
    },
  }
})

const { createIndexedDbDeckStore } = await import('./indexed-db-deck-store')

/** A library from the build before this one, holding a record that migrates. */
function previousSchemaLibrary(): Library {
  return {
    format: LIBRARY_FORMAT,
    schemaVersion: CURRENT_SCHEMA_VERSION - 1,
    exportedAt: 1,
    decks: [
      { id: 'd1', name: '  Marché ', phrases: [], createdAt: 1, updatedAt: 1 },
    ],
    mixes: [],
    tombstones: [],
  }
}

describe('updateAll returns and compares the library it writes (T096)', () => {
  beforeEach(() => {
    resetFakeIdb()
    vi.stubGlobal('navigator', {
      storage: { persist: vi.fn().mockResolvedValue(true) },
    })
  })

  it('returns the migrated records, at the current schema, that are now on disk', async () => {
    const store = createIndexedDbDeckStore()

    const result = await store.updateAll(() => previousSchemaLibrary())

    const onDisk = await store.exportAll()
    expect(onDisk.decks.map((d) => d.name)).toEqual(['Marché'])
    expect(result.library.decks).toEqual(onDisk.decks)
    expect(result.library.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
  })

  it('does not count the same migrated library as a change the second time', async () => {
    const store = createIndexedDbDeckStore()
    await store.updateAll(() => previousSchemaLibrary())

    const again = await store.updateAll(() => previousSchemaLibrary())

    expect(again.changed).toBe(false)
  })
})
