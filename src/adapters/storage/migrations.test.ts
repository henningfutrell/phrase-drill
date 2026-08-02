import { describe, expect, it } from 'vitest'
import { applyMigrations, CURRENT_SCHEMA_VERSION, migrateDeckRecord, type RecordMigration } from './migrations'

describe('applyMigrations', () => {
  it('returns the record unchanged when it is already at the target version', () => {
    const record = { value: 1 }
    expect(applyMigrations(record, 2, 2, [])).toBe(record)
  })

  it('chains migrations oldest-to-newest', () => {
    const v1ToV2: RecordMigration = ((r: { value: number }) => ({
      ...r,
      addedInV2: true,
    })) as RecordMigration
    const v2ToV3: RecordMigration = ((r: { value: number; addedInV2: boolean }) => ({
      value: r.value,
      renamed: r.addedInV2,
    })) as RecordMigration

    const result = applyMigrations({ value: 1 }, 1, 3, [v1ToV2, v2ToV3]) as {
      value: number
      renamed: boolean
    }

    expect(result).toEqual({ value: 1, renamed: true })
  })

  it('throws if a record claims a version newer than the target', () => {
    expect(() => applyMigrations({}, 5, 2, [])).toThrow(/newer/)
  })

  it('throws with a clear message when a required migration step is missing', () => {
    const identity: RecordMigration = ((r: unknown) => r) as RecordMigration
    expect(() => applyMigrations({}, 1, 3, [identity])).toThrow(/no migration registered/)
  })
})

describe('migrateDeckRecord', () => {
  const currentRecord = {
    id: 'd1',
    name: 'Home',
    phrases: [{ id: 'p1', french: 'Bonjour', english: 'Hello' }],
    createdAt: 1,
    updatedAt: 1,
  }

  it('is a no-op when the record is already at the current schema version', () => {
    expect(migrateDeckRecord(currentRecord, CURRENT_SCHEMA_VERSION)).toEqual(currentRecord)
  })

  it('rejects a record claiming a newer schema version than this build supports', () => {
    expect(() => migrateDeckRecord({}, CURRENT_SCHEMA_VERSION + 1)).toThrow(/newer/)
  })
})
