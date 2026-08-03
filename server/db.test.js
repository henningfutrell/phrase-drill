// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createLibraryStore } from './db.js'

describe('createLibraryStore', () => {
  it('returns null for a key with no stored library', () => {
    const store = createLibraryStore(':memory:')
    expect(store.get('nonexistent')).toBeNull()
    store.close()
  })

  it('round-trips a put through get', () => {
    const store = createLibraryStore(':memory:')
    store.put('key1', '{"format":"phrase-drill-library"}', 1000)
    const row = store.get('key1')
    expect(row.data).toBe('{"format":"phrase-drill-library"}')
    expect(row.updatedAt).toBe(1000)
    store.close()
  })

  it('overwrites on a second put to the same key', () => {
    const store = createLibraryStore(':memory:')
    store.put('key1', '{"v":1}', 1000)
    store.put('key1', '{"v":2}', 2000)
    const row = store.get('key1')
    expect(row.data).toBe('{"v":2}')
    expect(row.updatedAt).toBe(2000)
    store.close()
  })

  it('keeps libraries for different keys independent', () => {
    const store = createLibraryStore(':memory:')
    store.put('a', '{"v":"a"}', 1)
    store.put('b', '{"v":"b"}', 2)
    expect(store.get('a').data).toBe('{"v":"a"}')
    expect(store.get('b').data).toBe('{"v":"b"}')
    store.close()
  })
})
