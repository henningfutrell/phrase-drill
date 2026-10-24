// @vitest-environment node
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  BATCH_SIZE,
  parseArgs,
  formatManifest,
  parseManifest,
  sha256Hex,
  isAlreadyExists,
  findOrphans,
  copyBatch,
  checkObjects,
  evaluateVerify,
  finalize,
  FINALIZE_STATEMENTS,
} from './clips-to-storage.mjs'

const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const entry = (bytes) => ({ byteSize: bytes.length, len: bytes.length, sha: sha(bytes) })
const manifestOf = (clips) => new Map(Object.entries(clips).map(([hash, bytes]) => [hash, entry(bytes)]))

/** An in-memory bucket with the port `clips-to-storage.mjs` talks to; `objects` is the one place state lives. */
function fakeBucket(initial = {}) {
  const objects = new Map(Object.entries(initial))
  const calls = { upload: [], remove: [] }
  return {
    objects,
    calls,
    async upload(name, bytes, mime) {
      calls.upload.push({ name, mime })
      if (objects.has(name)) return { error: { statusCode: '409', message: 'The resource already exists' } }
      objects.set(name, bytes)
      return { error: null }
    },
    async download(name) {
      if (!objects.has(name)) return { data: null, error: { message: 'Object not found' } }
      return { data: objects.get(name), error: null }
    },
    async list() {
      return [...objects.keys()]
    },
    async remove(names) {
      calls.remove.push(names)
      for (const name of names) objects.delete(name)
    },
  }
}

describe('parseArgs', () => {
  it('defaults to the copy run', () => {
    expect(parseArgs([])).toEqual({ mode: 'run', dryRun: false })
  })
  it.each([
    ['--manifest', 'manifest'],
    ['--verify-only', 'verify'],
    ['--finalize', 'finalize'],
    ['--sweep', 'sweep'],
  ])('%s selects %s', (flag, mode) => {
    expect(parseArgs([flag])).toEqual({ mode, dryRun: false })
  })
  it('--dry-run combines with a mode', () => {
    expect(parseArgs(['--sweep', '--dry-run'])).toEqual({ mode: 'sweep', dryRun: true })
  })
  it('refuses an unknown flag and two modes', () => {
    expect(() => parseArgs(['--frobnicate'])).toThrow(/unknown flag/)
    expect(() => parseArgs(['--verify-only', '--finalize'])).toThrow(/one mode/)
  })
})

describe('manifest', () => {
  it('round-trips through the TSV', () => {
    const rows = [
      { hash: 'a'.repeat(64), byteSize: 3, len: 3, sha: 'x'.repeat(64) },
      { hash: 'b'.repeat(64), byteSize: null, len: 5, sha: 'y'.repeat(64) },
    ]
    const parsed = parseManifest(formatManifest(rows))
    expect([...parsed.keys()]).toEqual(['a'.repeat(64), 'b'.repeat(64)])
    expect(parsed.get('b'.repeat(64))).toEqual({ byteSize: null, len: 5, sha: 'y'.repeat(64) })
  })
  it('refuses a duplicate hash, a short line and a non-numeric length', () => {
    const header = 'hash\tbyte_size\tlen\tsha\n'
    expect(() => parseManifest(`${header}a\t1\t1\ts\na\t1\t1\ts\n`)).toThrow(/duplicate/)
    expect(() => parseManifest(`${header}a\t1\n`)).toThrow(/line 2/)
    expect(() => parseManifest(`${header}a\t1\tx\ts\n`)).toThrow(/line 2/)
    expect(() => parseManifest('nope\n')).toThrow(/header/)
  })
})

describe('isAlreadyExists', () => {
  it('recognises the storage API duplicate, by status or by message', () => {
    expect(isAlreadyExists({ statusCode: '409', message: 'x' })).toBe(true)
    expect(isAlreadyExists({ message: 'The resource already exists' })).toBe(true)
    expect(isAlreadyExists({ message: 'Bucket not found' })).toBe(false)
    expect(isAlreadyExists(null)).toBe(false)
  })
})

describe('copyBatch', () => {
  const clipA = Buffer.from('audio-a')
  const clipB = Buffer.from('audio-bb')
  const rowOf = (hash, bytes) => ({ hash, mime: 'audio/mpeg', bytes })

  it('uploads, verifies by download and marks each row migrated', async () => {
    const bucket = fakeBucket()
    const marked = []
    const result = await copyBatch({
      rows: [rowOf('a', clipA), rowOf('b', clipB)],
      manifest: manifestOf({ a: clipA, b: clipB }),
      bucket,
      markMigrated: async (h) => marked.push(h),
    })
    expect(result).toEqual({ copied: 2, alreadyPresent: 0, failed: [] })
    expect(marked).toEqual(['a', 'b'])
    expect(bucket.calls.upload).toEqual([
      { name: 'a', mime: 'audio/mpeg' },
      { name: 'b', mime: 'audio/mpeg' },
    ])
  })

  it('treats "already exists" as ok when the stored object matches the manifest', async () => {
    const bucket = fakeBucket({ a: clipA })
    const marked = []
    const result = await copyBatch({ rows: [rowOf('a', clipA)], manifest: manifestOf({ a: clipA }), bucket, markMigrated: async (h) => marked.push(h) })
    expect(result).toEqual({ copied: 0, alreadyPresent: 1, failed: [] })
    expect(marked).toEqual(['a'])
  })

  it('leaves the row unmigrated when the existing object differs from the manifest', async () => {
    const bucket = fakeBucket({ a: Buffer.from('something else') })
    const marked = []
    const result = await copyBatch({ rows: [rowOf('a', clipA)], manifest: manifestOf({ a: clipA }), bucket, markMigrated: async (h) => marked.push(h) })
    expect(marked).toEqual([])
    expect(result.failed).toEqual([{ hash: 'a', reason: 'stored object does not match the manifest' }])
  })

  it('does not upload a row whose bytes differ from the manifest', async () => {
    const bucket = fakeBucket()
    const result = await copyBatch({ rows: [rowOf('a', clipB)], manifest: manifestOf({ a: clipA }), bucket, markMigrated: async () => {} })
    expect(bucket.calls.upload).toEqual([])
    expect(result.failed).toEqual([{ hash: 'a', reason: 'row bytes do not match the manifest' }])
  })

  it('reports a hash the manifest does not know and carries on with the rest', async () => {
    const bucket = fakeBucket()
    const marked = []
    const result = await copyBatch({
      rows: [rowOf('ghost', clipA), rowOf('b', clipB)],
      manifest: manifestOf({ b: clipB }),
      bucket,
      markMigrated: async (h) => marked.push(h),
    })
    expect(result.failed).toEqual([{ hash: 'ghost', reason: 'not in the manifest' }])
    expect(marked).toEqual(['b'])
  })

  it('reports a failed upload without marking', async () => {
    const bucket = fakeBucket()
    bucket.upload = async () => ({ error: { message: 'Payload too large' } })
    const result = await copyBatch({ rows: [rowOf('a', clipA)], manifest: manifestOf({ a: clipA }), bucket, markMigrated: async () => {} })
    expect(result.failed).toEqual([{ hash: 'a', reason: 'upload failed: Payload too large' }])
  })

  it('writes nothing on a dry run', async () => {
    const bucket = fakeBucket()
    const marked = []
    const result = await copyBatch({ rows: [rowOf('a', clipA)], manifest: manifestOf({ a: clipA }), bucket, markMigrated: async (h) => marked.push(h), dryRun: true })
    expect(bucket.calls.upload).toEqual([])
    expect(marked).toEqual([])
    expect(result).toEqual({ copied: 1, alreadyPresent: 0, failed: [] })
  })
})

describe('batch size', () => {
  it('is 50 rows (about 5 MB in memory)', () => {
    expect(BATCH_SIZE).toBe(50)
  })
})

describe('checkObjects', () => {
  it('names every manifest hash whose stored object is missing or differs', async () => {
    const a = Buffer.from('a')
    const b = Buffer.from('bb')
    const c = Buffer.from('ccc')
    const bucket = fakeBucket({ a, b: Buffer.from('xx') })
    const bad = await checkObjects({ manifest: manifestOf({ a, b, c }), bucket })
    expect(bad).toEqual(['b', 'c'])
  })
})

describe('findOrphans', () => {
  it('returns objects that no row names', () => {
    expect(findOrphans(['a', 'b', 'z'], ['a', 'b', 'c'])).toEqual(['z'])
    expect(findOrphans([], ['a'])).toEqual([])
  })
})

describe('evaluateVerify', () => {
  const clips = { a: Buffer.from('a'), b: Buffer.from('bb') }
  const good = () => ({
    manifest: manifestOf(clips),
    rowCount: 2,
    unmigratedCount: 0,
    objectNames: ['a', 'b'],
    sizeSum: 3,
    badObjects: [],
  })
  it('passes when every check holds', () => {
    expect(evaluateVerify(good())).toEqual({ ok: true, failures: [] })
  })
  it('fails per check, naming it', () => {
    expect(evaluateVerify({ ...good(), unmigratedCount: 1 }).failures).toEqual(['1 rows have no storage_path'])
    expect(evaluateVerify({ ...good(), rowCount: 3 }).failures).toEqual(['3 rows, manifest has 2'])
    expect(evaluateVerify({ ...good(), objectNames: ['a'] }).failures).toEqual(['bucket holds 1 objects, expected 2'])
    expect(evaluateVerify({ ...good(), sizeSum: 4 }).failures).toEqual(['sum of byte_size is 4, manifest sums to 3'])
    expect(evaluateVerify({ ...good(), badObjects: ['b'] }).failures).toEqual(['1 objects missing or differing: b'])
  })
  it('is not ok on any failure', () => {
    expect(evaluateVerify({ ...good(), unmigratedCount: 1 }).ok).toBe(false)
  })
})

describe('finalize', () => {
  const recorder = () => {
    const sql = []
    return { sql, db: { query: async (s) => void sql.push(s) } }
  }
  it('refuses unless verification passed, and runs nothing', async () => {
    const { sql, db } = recorder()
    await expect(finalize({ db, verdict: { ok: false, failures: ['x'] } })).rejects.toThrow(/verification failed/)
    expect(sql).toEqual([])
  })
  it('drops bytes, tightens storage_path, then vacuums', async () => {
    const { sql, db } = recorder()
    await finalize({ db, verdict: { ok: true, failures: [] } })
    expect(sql).toEqual(FINALIZE_STATEMENTS)
    expect(sql[0]).toMatch(/DROP COLUMN IF EXISTS bytes/)
    expect(sql[1]).toMatch(/storage_path SET NOT NULL/)
    expect(sql[2]).toBe('VACUUM FULL clips')
  })
  it('runs nothing on a dry run', async () => {
    const { sql, db } = recorder()
    await finalize({ db, verdict: { ok: true, failures: [] }, dryRun: true })
    expect(sql).toEqual([])
  })
})

describe('sha256Hex', () => {
  it('matches node crypto', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe(sha(Buffer.from('abc')))
  })
})
