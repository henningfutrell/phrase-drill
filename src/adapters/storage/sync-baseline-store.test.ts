import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetFakeIdb } from './idb.test-support'

import { createIndexedDbSyncBaselineStore } from './sync-baseline-store'
import { createIndexedDbSettingsStore } from './settings-store'
import { LIBRARY_FORMAT } from '../../domain'
import { CURRENT_SCHEMA_VERSION } from './migrations'

type Library = import('../../domain').Library

function library(names: readonly string[]): Library {
  return {
    format: LIBRARY_FORMAT,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: 1,
    decks: names.map((name, index) => ({
      id: `d${index}`,
      name,
      phrases: [],
      createdAt: 1,
      updatedAt: 1,
    })),
    mixes: [],
    tombstones: [],
  }
}

describe('createIndexedDbSyncBaselineStore', () => {
  beforeEach(() => {
    resetFakeIdb()
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(true) } })
  })

  it('reports no baseline before the first successful sync — a merge then falls back to whole-record rules', async () => {
    const store = createIndexedDbSyncBaselineStore()

    expect(await store.read()).toBeUndefined()
  })

  it('reads back exactly the library that was written', async () => {
    const store = createIndexedDbSyncBaselineStore()
    const written = library(['Home', 'Work'])

    await store.write(written)

    expect(await store.read()).toEqual(written)
  })

  it('replaces the previous baseline rather than accumulating snapshots', async () => {
    const store = createIndexedDbSyncBaselineStore()

    await store.write(library(['Home']))
    await store.write(library(['Work']))

    expect((await store.read())!.decks.map((d) => d.name)).toEqual(['Work'])
  })

  it('is invisible to the settings the app reads — a baseline is sync bookkeeping, not a setting', async () => {
    const baseline = createIndexedDbSyncBaselineStore()
    const settings = createIndexedDbSettingsStore()

    await baseline.write(library(['Home']))

    expect(await settings.load()).toEqual({ voice: null, lastSyncAt: null, lastExportAt: null })
  })
})
