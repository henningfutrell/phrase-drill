#!/usr/bin/env node
// R2: deletes one or more Clips from the server's shared store, by content
// address, so the next device that asks gets a fresh generation. For a Clip
// that is broken (truncated, garbled, the wrong voice settings) when her
// phone is not to hand — on the device, *Redo audio* does the same through
// `POST /api/tts/regenerate`.
//
// Usage (Render Shell, where the service env is present):
//   node scripts/clip-delete.mjs <hash> [<hash> ...]
//   npm run clip-delete -- <hash> [<hash> ...]
//
// A hash is SHA-256 of `provider|modelId|voiceId|lang|text`, 64 lowercase hex
// — docs/server.md "Deleting a broken Clip by hash" has the one-line command
// that computes it. Nothing else is accepted: this script never deletes by a
// guess.
//
// **It deletes the `clip_jobs` row too, and that is a trade-off taken on
// purpose.** The job row carries the hash's billing count (two provider calls
// per 24 h, server/clip-job-store.js). Leaving it would keep a capped hash
// refused until tomorrow, which defeats the reason the operator is here.
// Removing it opens a fresh billing window: the next request may bill twice
// more today. That is an operator's deliberate action, one hash at a time,
// not a path any device can reach — so the cap still holds for everything the
// app does by itself.
//
// It touches only `clips` and `clip_jobs`, and only through their stores
// (`clipStore.delete`, `clipJobStore.delete`), whose table closure
// server/db.test.js asserts. Her library is out of its reach.

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createPool, createClipStore, waitForDatabase } from '../server/db.js'
import { createClipJobStore } from '../server/clip-job-store.js'

/** `host:port/database` — never the password, which is the only part of a connection string worth hiding. */
export function describeTarget(connectionString) {
  try {
    const url = new URL(connectionString)
    return `${url.hostname}:${url.port || '5432'}${url.pathname}`
  } catch {
    return '(unparseable DATABASE_URL)'
  }
}

const USAGE = 'usage: node scripts/clip-delete.mjs <hash> [<hash> ...]   (64 lowercase hex characters each)'
const CLIP_HASH = /^[0-9a-f]{64}$/

/**
 * `{ hashes }`, or `{ error }` naming the first argument that is not a Clip
 * hash. All or nothing: one bad argument refuses the whole run, so a typo in
 * the middle of a list never deletes the half before it.
 */
export function parseHashes(args) {
  if (args.length === 0) return { error: USAGE }
  const bad = args.find((arg) => !CLIP_HASH.test(arg))
  if (bad !== undefined) return { error: `not a Clip hash (64 lowercase hex characters): ${bad}\n${USAGE}` }
  return { hashes: args }
}

/** Deletes each hash's stored Clip and job row; one result per hash, in order, saying which existed. */
export async function deleteClips({ clipStore, clipJobStore }, hashes) {
  const results = []
  for (const hash of hashes) {
    const clip = await clipStore.delete(hash)
    const job = await clipJobStore.delete(hash)
    results.push({ hash, clip, job })
  }
  return results
}

/** One line per hash: `deleted` with what was there, or `absent` when neither row was. */
export function describeResult({ hash, clip, job }) {
  if (!clip && !job) return `${hash} absent`
  return `${hash} deleted (clip: ${clip ? 'yes' : 'no'}, job: ${job ? 'yes' : 'no'})`
}

async function main() {
  const parsed = parseHashes(process.argv.slice(2))
  if (parsed.error) {
    console.error(parsed.error)
    process.exitCode = 1
    return
  }

  // No localhost fallback, for the reason a hosted shell gives (T055): a
  // hand-run CLI with no DATABASE_URL is in the wrong environment.
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set — nothing to connect to.')
    console.error('In Render, run this from the service Shell so the service env is present.')
    process.exitCode = 1
    return
  }

  console.error(`connecting to ${describeTarget(databaseUrl)} ...`)
  const pool = createPool(databaseUrl, { connectionTimeoutMillis: 3000 })
  try {
    // 3 tries: a CLI in front of a human must fail while they watch.
    await waitForDatabase(pool, { retries: 3, delayMs: 1000 })
  } catch (err) {
    console.error(`could not reach the database at ${describeTarget(databaseUrl)} after 3 tries.`)
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
    await pool.end()
    return
  }

  // Idempotent, as on every server boot: a database the server has never
  // started against answers `absent` rather than "relation does not exist".
  const clipStore = createClipStore(pool)
  const clipJobStore = createClipJobStore(pool)
  await clipStore.init()
  await clipJobStore.init()

  for (const result of await deleteClips({ clipStore, clipJobStore }, parsed.hashes)) console.log(describeResult(result))
  await pool.end()
}

// Only run when executed directly — `clip-delete.test.js` imports this module.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
