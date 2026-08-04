#!/usr/bin/env node
/**
 * Logical backup (T054): `pg_dump` the database named by `DATABASE_URL`,
 * gzip it, ship it to `BACKUP_DEST` — off this platform, never a second
 * disk on the same host — and prune anything older than
 * `BACKUP_RETENTION_DAYS`. See `docs/backup.md` for the full runbook,
 * including why Render's 3-day point-in-time recovery does not cover the
 * failure this exists for ("she deleted a deck five weeks ago").
 *
 * Every step fails loudly: a non-zero exit and a logged `error`, never a
 * swallowed exception. A backup job that fails silently is worse than none.
 *
 * Env:
 *   DATABASE_URL          required. Same variable the server itself reads.
 *   BACKUP_DEST            required. `s3://bucket[/prefix]` or a local
 *                          directory path (the latter is for the restore
 *                          drill and local testing — see docs/backup.md;
 *                          production always uses `s3://`).
 *   BACKUP_S3_ENDPOINT     required when BACKUP_DEST is `s3://` and the
 *                          bucket lives on an S3-compatible provider other
 *                          than AWS itself (e.g. Cloudflare R2). Passed to
 *                          `aws s3` as `--endpoint-url`.
 *   BACKUP_RETENTION_DAYS  optional, default 180 — see docs/backup.md for
 *                          the reasoning.
 *   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY — read by the `aws` CLI
 *                          itself; this script never touches them directly
 *                          beyond redacting the secret out of its own logs.
 *
 * Requires `pg_dump` and, for an `s3://` destination, the `aws` CLI on
 * PATH — see docs/backup.md for what to install where this runs.
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

export function parseDestination(dest) {
  if (dest.startsWith('s3://')) {
    const rest = dest.slice('s3://'.length)
    const slash = rest.indexOf('/')
    if (slash === -1) return { kind: 's3', bucket: rest, prefix: '' }
    return { kind: 's3', bucket: rest.slice(0, slash), prefix: rest.slice(slash + 1) }
  }
  return { kind: 'local', dir: dest }
}

function s3Key(dest, filename) {
  return dest.prefix ? `${dest.prefix}/${filename}` : filename
}

function s3Uri(dest, filename) {
  return `s3://${dest.bucket}/${s3Key(dest, filename)}`
}

function awsArgs(extra) {
  const endpoint = process.env.BACKUP_S3_ENDPOINT
  return endpoint ? [...extra, '--endpoint-url', endpoint] : extra
}

function run(command, args, { env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: env ?? process.env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited ${code}: ${stderr.trim()}`))
    })
  })
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

async function upload({ dest, localFile, filename, logger }) {
  if (dest.kind === 's3') {
    await run('aws', awsArgs(['s3', 'cp', localFile, s3Uri(dest, filename)]))
  } else {
    await mkdir(dest.dir, { recursive: true })
    await copyFile(localFile, path.join(dest.dir, filename))
  }
  logger.info('backup: uploaded', { destination: dest.kind === 's3' ? s3Uri(dest, filename) : path.join(dest.dir, filename) })
}

async function listExisting(dest) {
  if (dest.kind === 's3') {
    let out = ''
    await new Promise((resolve, reject) => {
      const child = spawn('aws', awsArgs(['s3', 'ls', `s3://${dest.bucket}/${dest.prefix ? dest.prefix + '/' : ''}`]), {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout.on('data', (c) => {
        out += c.toString()
      })
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`aws s3 ls exited ${code}`))))
    })
    // `aws s3 ls` prints one line per object: "<date> <time> <size> <name>"
    return out
      .split('\n')
      .map((line) => line.trim().split(/\s+/).pop())
      .filter((name) => name && NAME_PATTERN.test(name))
  }
  const entries = await readdir(dest.dir).catch((err) => (err.code === 'ENOENT' ? [] : Promise.reject(err)))
  return entries.filter((name) => NAME_PATTERN.test(name))
}

async function deleteBackup(dest, name, logger) {
  if (dest.kind === 's3') {
    await run('aws', awsArgs(['s3', 'rm', s3Uri(dest, name)]))
  } else {
    await unlink(path.join(dest.dir, name))
  }
  logger.info('backup: pruned expired backup', { name })
}

async function applyRetention({ dest, retentionDays, logger }) {
  const names = await listExisting(dest)
  const expired = selectExpiredBackups(names, retentionDays)
  for (const name of expired) {
    await deleteBackup(dest, name, logger)
  }
  return expired
}

export async function main() {
  const databaseUrl = process.env.DATABASE_URL
  const destRaw = process.env.BACKUP_DEST
  const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS)

  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  if (!destRaw) throw new Error('BACKUP_DEST is required (s3://bucket[/prefix] or a local directory)')
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) throw new Error('BACKUP_RETENTION_DAYS must be a positive number')

  const { password } = parsePgUrl(databaseUrl)
  const logger = createLogger({ secrets: [password, process.env.AWS_SECRET_ACCESS_KEY].filter(Boolean) })

  const dest = parseDestination(destRaw)
  const filename = backupFileName()
  const tmpFile = path.join(os.tmpdir(), `phrase-drill-backup-${process.pid}-${Date.now()}.sql.gz`)

  logger.info('backup: starting', { filename, destinationKind: dest.kind })
  try {
    await dumpAndCompress({ databaseUrl, outFile: tmpFile })
    const { size } = await stat(tmpFile)
    logger.info('backup: dump complete', { bytes: size })

    await upload({ dest, localFile: tmpFile, filename, logger })

    const pruned = await applyRetention({ dest, retentionDays, logger })
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
  main().catch(() => {
    process.exitCode = 1
  })
}
