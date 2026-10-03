// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseHashes, deleteClips, describeResult } from './clip-delete.mjs'
import { createClipStore } from '../server/db.js'
import { fakeClipPool } from '../server/pool.test-support.js'
import { createMemoryClipJobStore, jobFields } from '../server/clip-job-store.test-support.js'

/**
 * R2. The operator's way to replace one broken Clip without their phone: delete
 * it by hash from the Render Shell, and the next device that asks gets a fresh
 * generation. The SQL is the stores' own (`clipStore.delete`,
 * `clipJobStore.delete`), whose table closure `server/db.test.js` asserts and
 * `server/db.postgres.test.js` runs against a real Postgres; this pins the
 * script's own decisions — what an argument may be, what it reports, how it
 * exits.
 */
const execFileAsync = promisify(execFile)
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'clip-delete.mjs')
const A = 'a'.repeat(64)
const B = '0123456789abcdef'.repeat(4)

/** Runs the script for real and resolves with its exit code and streams — never throws on a non-zero exit. */
function runScript(args, env) {
  return execFileAsync(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, ...env } }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (err) => ({ code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }),
  )
}

describe('parseHashes', () => {
  it('accepts one or more 64-character lowercase hex hashes', () => {
    expect(parseHashes([A])).toEqual({ hashes: [A] })
    expect(parseHashes([A, B])).toEqual({ hashes: [A, B] })
  })

  it('refuses no arguments at all', () => {
    expect(parseHashes([]).error).toMatch(/usage/i)
  })

  // A hash is the only thing this script can be pointed at. Anything else —
  // a phrase's text, a truncated copy-paste, an uppercase rendering — is
  // refused before a connection is opened, and named, so nothing is deleted
  // by a guess.
  it.each([
    ['uppercase', A.toUpperCase()],
    ['63 characters', A.slice(1)],
    ['65 characters', `${A}0`],
    ['not hex', 'g'.repeat(64)],
    ['a phrase', 'bonjour'],
    ['a SQL fragment', `${A.slice(0, 60)}' OR 1=1`],
  ])('refuses %s, naming the argument, and deletes nothing else either', (_name, bad) => {
    const result = parseHashes([A, bad])
    expect(result.hashes).toBeUndefined()
    expect(result.error).toContain(bad)
  })
})

describe('deleteClips', () => {
  async function stores() {
    const clipStore = createClipStore(fakeClipPool())
    await clipStore.init()
    const clipJobStore = createMemoryClipJobStore()
    return { clipStore, clipJobStore }
  }
  const clip = (hash) => ({ hash, bytes: Buffer.alloc(10, 1), mime: 'audio/mpeg', durationMs: 1, createdAt: 1 })

  it('deletes the stored Clip and its job row, and says which it found', async () => {
    const { clipStore, clipJobStore } = await stores()
    await clipStore.put(clip(A))
    await clipJobStore.request(jobFields({ hash: A }), 1)

    expect(await deleteClips({ clipStore, clipJobStore }, [A])).toEqual([{ hash: A, clip: true, job: true }])
    expect(await clipStore.get(A)).toBeNull()
    expect(await clipJobStore.get(A)).toBeNull()
  })

  // The job row is the billing cap. Deleting it is the point (the next ask
  // regenerates in a fresh window) and also the cost — see the script header.
  it('deletes a job row alone, so a capped hash can be generated again', async () => {
    const { clipStore, clipJobStore } = await stores()
    await clipJobStore.request(jobFields({ hash: B }), 1)

    expect(await deleteClips({ clipStore, clipJobStore }, [B])).toEqual([{ hash: B, clip: false, job: true }])
  })

  it('reports a hash with neither row as absent, and leaves every other hash alone', async () => {
    const { clipStore, clipJobStore } = await stores()
    await clipStore.put(clip(B))

    expect(await deleteClips({ clipStore, clipJobStore }, [A])).toEqual([{ hash: A, clip: false, job: false }])
    expect(await clipStore.get(B)).not.toBeNull()
  })
})

describe('describeResult', () => {
  it('prints deleted with what was there, or absent', () => {
    expect(describeResult({ hash: A, clip: true, job: false })).toBe(`${A} deleted (clip: yes, job: no)`)
    expect(describeResult({ hash: A, clip: false, job: true })).toBe(`${A} deleted (clip: no, job: yes)`)
    expect(describeResult({ hash: A, clip: false, job: false })).toBe(`${A} absent`)
  })
})

describe('the CLI', () => {
  it('exits 1 with usage when given no hash', async () => {
    const { code, stderr } = await runScript([], { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/none' })
    expect(code).toBe(1)
    expect(stderr).toMatch(/usage/i)
  })

  it('exits 1 on a malformed hash before reading DATABASE_URL', async () => {
    const { code, stderr } = await runScript(['not-a-hash'], {})
    expect(code).toBe(1)
    expect(stderr).toContain('not-a-hash')
  })

  // The same rule `useradd.mjs` follows (T055): a hand-run CLI with no
  // DATABASE_URL is in the wrong environment, and says so at once instead of
  // defaulting to localhost and retrying in silence.
  it('exits 1 naming DATABASE_URL when it is not set', async () => {
    const { code, stderr } = await runScript([A], {})
    expect(code).toBe(1)
    expect(stderr).toMatch(/DATABASE_URL is not set/)
  })
})
