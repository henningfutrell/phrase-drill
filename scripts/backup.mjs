#!/usr/bin/env node
/**
 * MANUAL logical export (T054, re-scoped T065).
 *
 * WHAT THIS IS: an on-demand export a human runs to pull a copy of her
 * phrase library off the platform and onto a machine they control.
 * `pg_dump` the database named by `DATABASE_URL`, gzip it, write it into
 * the directory named by `BACKUP_DEST`, and prune anything there older than
 * `BACKUP_RETENTION_DAYS`. You run it; nothing runs it for you.
 *
 * WHAT THIS IS NOT: the scheduled off-site backup. That is Render's
 * managed Postgres, whose own backups are the primary mechanism — which is
 * why `render.yaml` pays for `basic-256mb` instead of the free tier that
 * has no backups at all. This script does not replace it, is not
 * scheduled, and writing it to a directory on the Render container would
 * be worthless: that filesystem evaporates on the next redeploy. Point
 * `BACKUP_DEST` at a machine you own. See `docs/backup.md`.
 *
 * Every step fails loudly: a non-zero exit and a logged `error`, never a
 * swallowed exception. An export that fails silently is worse than none.
 *
 * Env:
 *   DATABASE_URL          required. Same variable the server itself reads.
 *   BACKUP_DEST            required. A local directory path, created if it
 *                          does not exist. Not a URI — there is no bucket
 *                          destination, and a `<scheme>://` value is
 *                          refused rather than taken literally.
 *   BACKUP_RETENTION_DAYS  optional, default 180 — see docs/backup.md for
 *                          the reasoning.
 *
 * Requires `pg_dump` on PATH — see docs/backup.md for what to install
 * where this runs.
 */
import { spawn } from 'node:child_process'
import { createGzip } from 'node:zlib'
import { createWriteStream } from 'node:fs'
import { mkdir, copyFile, unlink, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createLogger } from '../server/logger.js'
import { parsePgUrl, sanitizedUriWithDatabase } from './pg-url.mjs'

const DEFAULT_RETENTION_DAYS = 180 // see docs/backup.md — "Retention policy"

export function backupFileName(date = new Date()) {
  const iso = date.toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z')
  return `phrase-drill-${iso}.sql.gz`
}

const NAME_PATTERN = /^phrase-drill-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.sql\.gz$/

export function parseBackupTimestamp(name) {
  const m = NAME_PATTERN.exec(name)
  if (!m) return null
  const [, day, hh, mm, ss] = m
  const date = new Date(`${day}T${hh}:${mm}:${ss}Z`)
  return Number.isNaN(date.getTime()) ? null : date
}

export function selectExpiredBackups(names, retentionDays, now = new Date()) {
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000
  return names.filter((name) => {
    const ts = parseBackupTimestamp(name)
    return ts !== null && ts.getTime() < cutoff
  })
}

const URI_SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//

/**
 * The destination is a directory on a machine a human controls, and nothing
 * else. A `<scheme>://` value is refused rather than taken as a literal
 * directory name: `s3://bucket` used to mean something here, and silently
 * creating `./s3:/bucket` instead would look like a successful export.
 */
export function resolveDestinationDir(dest) {
  const scheme = URI_SCHEME.exec(dest)
  if (scheme) {
    throw new Error(
      `BACKUP_DEST must be a local directory path, not "${scheme[1]}://..." — this script writes to a directory on the machine that runs it (docs/backup.md)`,
    )
  }
  return dest
}

async function dumpAndCompress({ databaseUrl, outFile }) {
  const { database, password } = parsePgUrl(databaseUrl)
  const uri = sanitizedUriWithDatabase(databaseUrl, database)

  await new Promise((resolve, reject) => {
    const child = spawn('pg_dump', ['-d', uri, '--no-owner', '--no-privileges'], {
      env: { ...process.env, PGPASSWORD: password },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)

    const gzip = createGzip()
    const out = createWriteStream(outFile)
    child.stdout.pipe(gzip).pipe(out)

    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      reject(err)
    }
    child.on('close', (code) => {
      // stderr may contain the sanitized uri or other non-secret detail;
      // the password never appears in it (never passed as an argument),
      // and this message is only ever surfaced through `logger.error`
      // below, which redacts every field against the known secrets anyway.
      if (code !== 0) fail(new Error(`pg_dump exited ${code}: ${stderr.trim()}`))
    })
    out.on('error', fail)
    gzip.on('error', fail)
    out.on('finish', () => {
      if (!settled) {
        settled = true
        resolve()
      }
    })
  })
}

async function writeToDestination({ destDir, localFile, filename, logger }) {
  await mkdir(destDir, { recursive: true })
  const destination = path.join(destDir, filename)
  await copyFile(localFile, destination)
  logger.info('backup: written', { destination })
}

async function listExisting(destDir) {
  const entries = await readdir(destDir).catch((err) => (err.code === 'ENOENT' ? [] : Promise.reject(err)))
  return entries.filter((name) => NAME_PATTERN.test(name))
}

async function applyRetention({ destDir, retentionDays, logger }) {
  const names = await listExisting(destDir)
  const expired = selectExpiredBackups(names, retentionDays)
  for (const name of expired) {
    await unlink(path.join(destDir, name))
    logger.info('backup: pruned expired backup', { name })
  }
  return expired
}

export async function main() {
  const databaseUrl = process.env.DATABASE_URL
  const destRaw = process.env.BACKUP_DEST
  const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS)

  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  if (!destRaw) throw new Error('BACKUP_DEST is required (a local directory path)')
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) throw new Error('BACKUP_RETENTION_DAYS must be a positive number')

  const { password } = parsePgUrl(databaseUrl)
  const logger = createLogger({ secrets: [password].filter(Boolean) })

  const destDir = resolveDestinationDir(destRaw)
  const filename = backupFileName()
  const tmpFile = path.join(os.tmpdir(), `phrase-drill-backup-${process.pid}-${Date.now()}.sql.gz`)

  logger.info('backup: starting', { filename, destDir })
  try {
    await dumpAndCompress({ databaseUrl, outFile: tmpFile })
    const { size } = await stat(tmpFile)
    logger.info('backup: dump complete', { bytes: size })

    await writeToDestination({ destDir, localFile: tmpFile, filename, logger })

    const pruned = await applyRetention({ destDir, retentionDays, logger })
    logger.info('backup: done', { filename, prunedCount: pruned.length })
  } catch (err) {
    logger.error('backup: failed', { error: err instanceof Error ? err.message : String(err) })
    throw err
  } finally {
    await unlink(tmpFile).catch(() => {})
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href
if (isMain) {
  main().catch((err) => {
    // Not redundant with the `logger.error` inside main(): the config checks
    // above it throw before a logger exists, and without this they exit 1
    // having printed nothing — silence that reads like a clean run.
    process.stderr.write(`backup: failed — ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  })
}
