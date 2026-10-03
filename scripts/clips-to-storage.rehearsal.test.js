// @vitest-environment node
import { readFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSupabase } from '../server/supabase.js'
import { bucketPort, buildManifest, copyAll, finalize, gatherVerify, parseManifest, sweep, connectionConfig } from './clips-to-storage.mjs'

/**
 * End-to-end rehearsal of the Clip move against a real Postgres and a real
 * Supabase Storage — the local stack, never a hosted project. Opt-in:
 *
 *   REHEARSAL_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   REHEARSAL_SUPABASE_URL=http://127.0.0.1:54321 REHEARSAL_SUPABASE_SECRET_KEY=... \
 *   npx vitest run scripts/clips-to-storage.rehearsal.test.js
 *
 * It creates two scratch databases and one scratch bucket, and removes them.
 * It refuses any host that is not loopback: it drops tables.
 */
const dbUrl = process.env.REHEARSAL_DB_URL
const supabaseUrl = process.env.REHEARSAL_SUPABASE_URL
const secretKey = process.env.REHEARSAL_SUPABASE_SECRET_KEY
const configured = Boolean(dbUrl && supabaseUrl && secretKey)

const withDatabase = (url, database) => {
  const u = new URL(url)
  u.pathname = `/${database}`
  return u.toString()
}

describe.skipIf(!configured)('clip move rehearsal', () => {
  const suffix = randomUUID().slice(0, 8)
  const sourceName = `pd_src_${suffix}`
  const targetName = `pd_dst_${suffix}`
  const bucketName = `pd-rehearsal-${suffix}`
  const clips = Array.from({ length: 5 }, (_, i) => ({ hash: `${i}`.repeat(64), mime: 'audio/mpeg', bytes: randomBytes(100 + i * 700) }))
  let admin, source, target, supabase, bucket

  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost'].includes(new URL(dbUrl).hostname)) throw new Error('rehearsal runs against a loopback database only')
    admin = new pg.Client(connectionConfig(dbUrl))
    await admin.connect()
    await admin.query(`CREATE DATABASE ${sourceName}`)
    await admin.query(`CREATE DATABASE ${targetName}`)
    source = new pg.Client(connectionConfig(withDatabase(dbUrl, sourceName)))
    target = new pg.Client(connectionConfig(withDatabase(dbUrl, targetName)))
    await source.connect()
    await target.connect()

    // Source: the live (old) shape, no last_used_at, byte_size partly NULL.
    await source.query('CREATE TABLE clips (hash TEXT PRIMARY KEY, bytes BYTEA NOT NULL, mime TEXT NOT NULL, duration_ms BIGINT NOT NULL, created_at BIGINT NOT NULL, byte_size BIGINT)')
    // Target: the committed schema and fixup, applied as written.
    await target.query(readFileSync(new URL('../migration/supabase/001_schema.sql', import.meta.url), 'utf8'))
    for (const [i, c] of clips.entries()) {
      await source.query('INSERT INTO clips VALUES ($1, $2, $3, 1000, $4, NULL)', [c.hash, c.bytes, c.mime, 1700000000000 + i])
      await target.query('INSERT INTO clips (hash, bytes, mime, duration_ms, created_at) VALUES ($1, $2, $3, 1000, $4)', [c.hash, c.bytes, c.mime, 1700000000000 + i])
    }
    await target.query(readFileSync(new URL('../migration/supabase/003_fixup.sql', import.meta.url), 'utf8'))

    supabase = createSupabase({ url: supabaseUrl, secretKey })
    const created = await supabase.storage.createBucket(bucketName, { public: false })
    if (created.error) throw new Error(`createBucket: ${created.error.message}`)
    bucket = bucketPort(supabase, bucketName)
  })

  afterAll(async () => {
    if (supabase) {
      const names = await bucket.list()
      if (names.length > 0) await bucket.remove(names)
      await supabase.storage.deleteBucket(bucketName)
    }
    await source?.end()
    await target?.end()
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${sourceName} WITH (FORCE)`)
      await admin.query(`DROP DATABASE IF EXISTS ${targetName} WITH (FORCE)`)
      await admin.end()
    }
  })

  it('copies, verifies, sweeps and finalizes', async () => {
    const written = {}
    const entries = await buildManifest({ db: source, write: (_file, text) => (written.text = text) })
    expect(entries).toHaveLength(5)
    const manifest = parseManifest(written.text)

    // One object is already there from an interrupted earlier run.
    await bucket.upload(clips[0].hash, clips[0].bytes, clips[0].mime)

    const cursorClient = new pg.Client(connectionConfig(withDatabase(dbUrl, targetName)))
    await cursorClient.connect()
    try {
      const totals = await copyAll({ db: target, cursorClient, manifest, bucket, dryRun: false, log: () => {} })
      expect(totals).toEqual({ copied: 4, alreadyPresent: 1, failed: [] })
    } finally {
      await cursorClient.end()
    }

    expect(await gatherVerify({ db: target, bucket, manifest })).toEqual({ ok: true, failures: [] })

    await bucket.upload('orphan-object', Buffer.from('x'), 'audio/mpeg')
    expect((await gatherVerify({ db: target, bucket, manifest })).ok).toBe(false)
    expect(await sweep({ db: target, bucket, dryRun: false, log: () => {} })).toEqual(['orphan-object'])

    const verdict = await gatherVerify({ db: target, bucket, manifest })
    await finalize({ db: target, verdict })
    const { rows } = await target.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'clips' ORDER BY 1")
    expect(rows.map((r) => r.column_name)).not.toContain('bytes')
  })
})
