#!/usr/bin/env node
// One-off: moves every Clip's bytes from the `clips.bytes` column into the
// private Supabase Storage bucket `clips`, keyed by the Clip's content address.
// Idempotent and resumable: a row with a `storage_path` is done, a rerun picks
// up the rest. The manifest, built from Render before anything is copied, is
// the ground truth every copy and every verification is compared against.
//
// Order (migration/supabase/README.md has the whole runbook):
//   RENDER_EXTERNAL_URL=...  node scripts/clips-to-storage.mjs --manifest
//   SUPABASE_DB_URL=... SUPABASE_URL=... SUPABASE_SECRET_KEY=... \
//     node scripts/clips-to-storage.mjs [--dry-run]       copy loop
//     node scripts/clips-to-storage.mjs --verify-only
//     node scripts/clips-to-storage.mjs --finalize        drops `bytes`; verifies first, same run
//     node scripts/clips-to-storage.mjs --sweep [--dry-run]  remove objects no row names

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { createSupabase } from '../server/supabase.js'

export const BUCKET = 'clips'
export const MANIFEST_FILE = 'clips-manifest.tsv'
export const BATCH_SIZE = 50
const MANIFEST_HEADER = 'hash\tbyte_size\tlen\tsha'

export const MANIFEST_SQL =
  "SELECT hash, byte_size, octet_length(bytes) AS len, encode(sha256(bytes), 'hex') AS sha FROM clips ORDER BY hash"

export const FINALIZE_STATEMENTS = [
  'ALTER TABLE clips DROP COLUMN IF EXISTS bytes',
  'ALTER TABLE clips ALTER COLUMN storage_path SET NOT NULL',
  'VACUUM FULL clips',
]

const MODES = { '--manifest': 'manifest', '--verify-only': 'verify', '--finalize': 'finalize', '--sweep': 'sweep' }

export function parseArgs(argv) {
  let mode = 'run'
  let modeSet = false
  let dryRun = false
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true
    else if (arg in MODES) {
      if (modeSet) throw new Error('one mode at a time: --manifest, --verify-only, --finalize or --sweep')
      mode = MODES[arg]
      modeSet = true
    } else throw new Error(`unknown flag: ${arg}`)
  }
  return { mode, dryRun }
}

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex')

export function formatManifest(rows) {
  const lines = rows.map((r) => [r.hash, r.byteSize ?? '', r.len, r.sha].join('\t'))
  return `${[MANIFEST_HEADER, ...lines].join('\n')}\n`
}

/** @returns {Map<string, {byteSize: number|null, len: number, sha: string}>} */
export function parseManifest(text) {
  const [header, ...lines] = text.split('\n').filter((line, i) => i === 0 || line.length > 0)
  if (header !== MANIFEST_HEADER) throw new Error(`manifest header is not "${MANIFEST_HEADER}"`)
  const manifest = new Map()
  lines.forEach((line, i) => {
    const cells = line.split('\t')
    const len = Number(cells[2])
    const byteSize = cells[1] === '' ? null : Number(cells[1])
    if (cells.length !== 4 || !Number.isInteger(len) || Number.isNaN(byteSize)) throw new Error(`manifest line ${i + 2} is malformed`)
    if (manifest.has(cells[0])) throw new Error(`manifest has a duplicate hash: ${cells[0]}`)
    manifest.set(cells[0], { byteSize, len, sha: cells[3] })
  })
  return manifest
}

export function isAlreadyExists(error) {
  return Boolean(error) && (String(error.statusCode) === '409' || /already exists/i.test(error.message ?? ''))
}

export const findOrphans = (objectNames, rowHashes) => {
  const known = new Set(rowHashes)
  return objectNames.filter((name) => !known.has(name))
}

const matches = (bytes, expected) => bytes.length === expected.len && sha256Hex(bytes) === expected.sha

/**
 * Copies one batch. `bucket` is the storage port: upload (never upserting),
 * download, list, remove. A row is marked migrated only after the stored
 * object, downloaded back, matches the manifest.
 */
export async function copyBatch({ rows, manifest, bucket, markMigrated, dryRun = false }) {
  const result = { copied: 0, alreadyPresent: 0, failed: [] }
  const fail = (hash, reason) => result.failed.push({ hash, reason })
  for (const row of rows) {
    const expected = manifest.get(row.hash)
    if (!expected) {
      fail(row.hash, 'not in the manifest')
      continue
    }
    if (!matches(row.bytes, expected)) {
      fail(row.hash, 'row bytes do not match the manifest')
      continue
    }
    if (dryRun) {
      result.copied++
      continue
    }
    const { error } = await bucket.upload(row.hash, row.bytes, row.mime)
    const existed = isAlreadyExists(error)
    if (error && !existed) {
      fail(row.hash, `upload failed: ${error.message}`)
      continue
    }
    const { data, error: downloadError } = await bucket.download(row.hash)
    if (downloadError || !data || !matches(data, expected)) {
      fail(row.hash, 'stored object does not match the manifest')
      continue
    }
    await markMigrated(row.hash)
    if (existed) result.alreadyPresent++
    else result.copied++
  }
  return result
}

/** Hashes whose stored object is missing or differs from the manifest. */
export async function checkObjects({ manifest, bucket }) {
  const bad = []
  for (const [hash, expected] of manifest) {
    const { data, error } = await bucket.download(hash)
    if (error || !data || !matches(data, expected)) bad.push(hash)
  }
  return bad
}

export function evaluateVerify({ manifest, rowCount, unmigratedCount, objectNames, sizeSum, badObjects }) {
  const failures = []
  const expectedSum = [...manifest.values()].reduce((sum, e) => sum + e.len, 0)
  if (unmigratedCount !== 0) failures.push(`${unmigratedCount} rows have no storage_path`)
  if (rowCount !== manifest.size) failures.push(`${rowCount} rows, manifest has ${manifest.size}`)
  if (objectNames.length !== manifest.size) failures.push(`bucket holds ${objectNames.length} objects, expected ${manifest.size}`)
  if (sizeSum !== expectedSum) failures.push(`sum of byte_size is ${sizeSum}, manifest sums to ${expectedSum}`)
  if (badObjects.length > 0) failures.push(`${badObjects.length} objects missing or differing: ${badObjects.slice(0, 5).join(', ')}`)
  return { ok: failures.length === 0, failures }
}

export async function finalize({ db, verdict, dryRun = false }) {
  if (!verdict.ok) throw new Error(`verification failed, not finalizing: ${verdict.failures.join('; ')}`)
  for (const statement of FINALIZE_STATEMENTS) {
    if (dryRun) console.error(`dry run: ${statement}`)
    else await db.query(statement)
  }
}

// --- adapters: everything below touches a network or the disk --------------

/**
 * Render and Supabase poolers both require TLS. This is a one-off run from a
 * trusted machine, so certificate-chain verification is skipped for those
 * hosts (the same trade `server/db.js` makes for Render); a local URL gets none.
 */
export function connectionConfig(connectionString) {
  const { hostname } = new URL(connectionString)
  const remote = /\.(render\.com|supabase\.com|supabase\.co)$/.test(hostname)
  return remote ? { connectionString, ssl: { rejectUnauthorized: false } } : { connectionString }
}

export function bucketPort(supabase, bucket = BUCKET) {
  const storage = supabase.storage.from(bucket)
  return {
    async upload(name, bytes, mime) {
      return storage.upload(name, bytes, { contentType: mime, upsert: false })
    },
    async download(name) {
      const { data, error } = await storage.download(name)
      if (error || !data) return { data: null, error: error ?? { message: 'no data' } }
      return { data: Buffer.from(await data.arrayBuffer()), error: null }
    },
    async list() {
      const names = []
      for (let offset = 0; ; offset += 100) {
        const { data, error } = await storage.list('', { limit: 100, offset, sortBy: { column: 'name', order: 'asc' } })
        if (error) throw new Error(`list failed: ${error.message}`)
        names.push(...data.map((o) => o.name))
        if (data.length < 100) return names
      }
    },
    async remove(names) {
      const { error } = await storage.remove(names)
      if (error) throw new Error(`remove failed: ${error.message}`)
    },
  }
}

function requireEnv(env, names) {
  const missing = names.filter((n) => !env[n])
  if (missing.length > 0) throw new Error(`unset: ${missing.join(', ')}`)
}

export async function buildManifest({ db, write = writeFileSync }) {
  const { rows } = await db.query(MANIFEST_SQL)
  const entries = rows.map((r) => ({
    hash: r.hash,
    byteSize: r.byte_size === null ? null : Number(r.byte_size),
    len: Number(r.len),
    sha: r.sha,
  }))
  write(MANIFEST_FILE, formatManifest(entries))
  return entries
}

/** Server-side cursor: 50 rows (about 5 MB) in memory at a time. Row updates go through `db`, a different connection. */
export async function copyAll({ db, cursorClient, manifest, bucket, dryRun, log = console.error }) {
  const totals = { copied: 0, alreadyPresent: 0, failed: [] }
  const markMigrated = (hash) => db.query('UPDATE clips SET storage_path = $1 WHERE hash = $1', [hash])
  await cursorClient.query('BEGIN READ ONLY')
  try {
    await cursorClient.query('DECLARE clip_cursor NO SCROLL CURSOR FOR SELECT hash, mime, bytes FROM clips WHERE storage_path IS NULL ORDER BY hash')
    for (;;) {
      const { rows } = await cursorClient.query(`FETCH ${BATCH_SIZE} FROM clip_cursor`)
      if (rows.length === 0) break
      const batch = await copyBatch({ rows, manifest, bucket, markMigrated, dryRun })
      totals.copied += batch.copied
      totals.alreadyPresent += batch.alreadyPresent
      totals.failed.push(...batch.failed)
      for (const f of batch.failed) log(`FAILED ${f.hash}: ${f.reason}`)
      log(`batch: copied ${totals.copied}, already present ${totals.alreadyPresent}, failed ${totals.failed.length}`)
    }
  } finally {
    await cursorClient.query('ROLLBACK')
  }
  return totals
}

export async function gatherVerify({ db, bucket, manifest }) {
  const scalar = async (sql) => Number((await db.query(sql)).rows[0].n)
  return evaluateVerify({
    manifest,
    rowCount: await scalar('SELECT count(*) AS n FROM clips'),
    unmigratedCount: await scalar('SELECT count(*) AS n FROM clips WHERE storage_path IS NULL'),
    sizeSum: await scalar('SELECT coalesce(sum(byte_size), 0) AS n FROM clips'),
    objectNames: await bucket.list(),
    badObjects: await checkObjects({ manifest, bucket }),
  })
}

export async function sweep({ db, bucket, dryRun, log = console.error }) {
  const { rows } = await db.query('SELECT hash FROM clips')
  const orphans = findOrphans(await bucket.list(), rows.map((r) => r.hash))
  for (const name of orphans) log(`${dryRun ? 'would remove' : 'removing'} orphan object ${name}`)
  if (!dryRun && orphans.length > 0) await bucket.remove(orphans)
  return orphans
}

async function main() {
  const { mode, dryRun } = parseArgs(process.argv.slice(2))
  const env = process.env

  if (mode === 'manifest') {
    requireEnv(env, ['RENDER_EXTERNAL_URL'])
    const render = new pg.Client(connectionConfig(env.RENDER_EXTERNAL_URL))
    await render.connect()
    try {
      await render.query('SET default_transaction_read_only = on')
      const entries = await buildManifest({ db: render })
      console.error(`${MANIFEST_FILE}: ${entries.length} clips, ${entries.reduce((s, e) => s + e.len, 0)} bytes`)
    } finally {
      await render.end()
    }
    return
  }

  requireEnv(env, ['SUPABASE_DB_URL', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY'])
  const bucket = bucketPort(createSupabase({ url: env.SUPABASE_URL, secretKey: env.SUPABASE_SECRET_KEY }))
  const db = new pg.Client(connectionConfig(env.SUPABASE_DB_URL))
  await db.connect()
  try {
    if (mode === 'sweep') {
      const orphans = await sweep({ db, bucket, dryRun })
      console.error(`${orphans.length} orphan objects${dryRun ? ' (dry run, nothing removed)' : ' removed'}`)
      return
    }
    const manifest = parseManifest(readFileSync(MANIFEST_FILE, 'utf8'))
    const hasBytes = (await db.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'clips' AND column_name = 'bytes'")).rowCount > 0

    if (mode === 'run') {
      if (!hasBytes) throw new Error('clips.bytes is gone: already finalized, nothing to copy')
      const cursorClient = new pg.Client(connectionConfig(env.SUPABASE_DB_URL))
      await cursorClient.connect()
      try {
        const totals = await copyAll({ db, cursorClient, manifest, bucket, dryRun })
        console.error(`copied ${totals.copied}, already present ${totals.alreadyPresent}, failed ${totals.failed.length}${dryRun ? ' (dry run)' : ''}`)
        if (totals.failed.length > 0) process.exitCode = 1
      } finally {
        await cursorClient.end()
      }
      return
    }

    const verdict = await gatherVerify({ db, bucket, manifest })
    for (const f of verdict.failures) console.error(`VERIFY FAIL: ${f}`)
    console.error(`verify: ${verdict.ok ? 'PASS' : 'FAIL'}`)
    if (mode === 'verify') {
      if (!verdict.ok) process.exitCode = 1
      return
    }
    await finalize({ db, verdict, dryRun })
    console.error(dryRun ? 'finalize: dry run, nothing changed' : 'finalize: done (bytes dropped, storage_path NOT NULL, vacuumed)')
  } finally {
    await db.end()
  }
}

// Run only when executed, not when imported by the test.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
