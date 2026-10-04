// @vitest-environment node
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The daily backup must restore. Runs the real `backup.mjs` against a scratch
 * database shaped like Supabase's (`public` already exists, as in every
 * Postgres), then the real `restore-drill.mjs` on the file it wrote. Opt-in,
 * against the local stack, never a hosted project:
 *
 *   REHEARSAL_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   npx vitest run scripts/backup-restore.rehearsal.test.js
 *
 * It creates one scratch database and removes it. Loopback hosts only.
 */
const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const dbUrl = process.env.REHEARSAL_DB_URL

const withDatabase = (url, database) => {
  const u = new URL(url)
  u.pathname = `/${database}`
  return u.toString()
}

function runNode(script, args, env) {
  return execFileAsync(process.execPath, [path.join(here, script), ...args], { env: { ...process.env, ...env } }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (err) => ({ code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }),
  )
}

describe.skipIf(!dbUrl)('backup → restore-drill round trip', () => {
  const sourceName = `pd_bak_${randomUUID().slice(0, 8)}`
  let admin, source, dest

  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost'].includes(new URL(dbUrl).hostname)) throw new Error('rehearsal runs against a loopback database only')
    admin = new pg.Client({ connectionString: dbUrl })
    await admin.connect()
    await admin.query(`CREATE DATABASE "${sourceName}"`)
    source = new pg.Client({ connectionString: withDatabase(dbUrl, sourceName) })
    await source.connect()
    await source.query(await readFile(path.join(root, 'migration/supabase/001_schema.sql'), 'utf8'))
    await source.query(`INSERT INTO libraries VALUES ('k1', '{"decks":[]}', 1)`)
    dest = await mkdtemp(path.join(os.tmpdir(), 'pd-backup-'))
  })

  afterAll(async () => {
    await source?.end()
    await admin?.query(`DROP DATABASE IF EXISTS "${sourceName}" WITH (FORCE)`)
    await admin?.end()
    if (dest) await rm(dest, { recursive: true, force: true })
  })

  it('a backup the timer writes passes the restore drill', async () => {
    const backup = await runNode('backup.mjs', [], { DATABASE_URL: withDatabase(dbUrl, sourceName), BACKUP_DEST: dest })
    expect(backup.code, backup.stderr).toBe(0)
    const [file] = await readdir(dest)

    const drill = await runNode('restore-drill.mjs', [path.join(dest, file), '--library-key=k1'], { DATABASE_URL: dbUrl })
    expect(drill.code, drill.stdout + drill.stderr).toBe(0)
  })

  it('a backup psql rejects early reports psql\'s error, not a crash on the closed pipe', async () => {
    const broken = path.join(dest, 'broken.sql.gz')
    await writeFile(broken, gzipSync(`SELECT no_such_function();\n${'-- padding\n'.repeat(400_000)}`))

    const drill = await runNode('restore-drill.mjs', [broken], { DATABASE_URL: dbUrl })
    expect(drill.code).toBe(1)
    expect(drill.stdout + drill.stderr).toMatch(/no_such_function/)
    expect(drill.stderr).not.toMatch(/EPIPE/)
  })
})
