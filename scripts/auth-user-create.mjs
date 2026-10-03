#!/usr/bin/env node
// One-off: creates their Supabase Auth user, keeping their old `users.id` so
// `libraries.library_key` needs no rewrite. Replaces useradd.mjs.
//
//   RENDER_EXTERNAL_URL=... node scripts/auth-user-create.mjs --map-from-render
//   SUPABASE_URL=... SUPABASE_SECRET_KEY=... SUPABASE_DB_URL=... \
//     node scripts/auth-user-create.mjs --email user@example.com --id <users.id>
//   (the password is read from stdin, never from argv)
//
// Exits non-zero unless every library has an auth user afterwards.

import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { createSupabase } from '../server/supabase.js'
import { connectionConfig } from './clips-to-storage.mjs'

export const ORPHAN_LIBRARIES_SQL =
  'SELECT count(*) AS count FROM libraries l LEFT JOIN auth.users u ON u.id::text = l.library_key WHERE u.id IS NULL'

export function parseArgs(argv) {
  const out = { email: undefined, id: undefined, mapFromRender: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--map-from-render') out.mapFromRender = true
    else if (arg === '--email' || arg === '--id') {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      out[arg.slice(2)] = value
    } else throw new Error(`unknown flag: ${arg}`)
  }
  if (!out.mapFromRender && !out.email) throw new Error('--email is required')
  return out
}

/** First line of `input`, prompt on `output`, nothing typed is echoed back. Resolves on the first newline, not EOF. */
export function readSecretFrom({ input, output }) {
  return new Promise((resolve, reject) => {
    output.write('password for the new account (not echoed): ')
    const muted = new Writable({ write: (_c, _e, cb) => cb() })
    const rl = createInterface({ input, output: muted, terminal: Boolean(input.isTTY) })
    let settled = false
    rl.on('line', (line) => {
      if (settled) return
      settled = true
      rl.close()
      input.unref?.()
      output.write('\n')
      resolve(line.replace(/\r$/, ''))
    })
    rl.on('close', () => {
      if (settled) return
      settled = true
      reject(new Error('no password read from stdin'))
    })
  })
}

const quote = (s) => `'${String(s).replaceAll("'", "''")}'`

export function idRewriteSql(oldId, newId) {
  return [
    'BEGIN;',
    `UPDATE libraries SET library_key = ${quote(newId)} WHERE library_key = ${quote(oldId)};`,
    `UPDATE library_versions SET library_key = ${quote(newId)} WHERE library_key = ${quote(oldId)};`,
    'COMMIT;',
  ].join('\n')
}

/**
 * Creates the user. If the API refuses the requested `id`, creates the user
 * with a generated one and returns the SQL that moves their library onto it — it
 * is printed for the operator, never run.
 */
export async function createUser({ supabase, id, email, password }) {
  const attrs = { email, password, email_confirm: true }
  const first = await supabase.auth.admin.createUser(id ? { id, ...attrs } : attrs)
  if (!first.error) return { ok: true, id: first.data.user.id }
  if (!id || first.error.code === 'email_exists') throw new Error(first.error.message)
  const second = await supabase.auth.admin.createUser(attrs)
  if (second.error) throw new Error(second.error.message)
  return { ok: false, id: second.data.user.id, fallbackSql: idRewriteSql(id, second.data.user.id), reason: first.error.message }
}

export async function orphanCheck(db) {
  const orphans = Number((await db.query(ORPHAN_LIBRARIES_SQL)).rows[0].count)
  return { ok: orphans === 0, orphans }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const env = process.env
  if (args.mapFromRender) {
    if (!env.RENDER_EXTERNAL_URL) throw new Error('unset: RENDER_EXTERNAL_URL')
    const render = new pg.Client(connectionConfig(env.RENDER_EXTERNAL_URL))
    await render.connect()
    try {
      const { rows } = await render.query('SELECT id, username, created_at FROM users ORDER BY created_at')
      for (const r of rows) console.log(`${r.id}\t${r.username}\t${r.created_at}`)
      console.error(`${rows.length} users. Pass the id you want kept as --id.`)
    } finally {
      await render.end()
    }
    return
  }

  const missing = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_DB_URL'].filter((n) => !env[n])
  if (missing.length > 0) throw new Error(`unset: ${missing.join(', ')}`)
  const password = await readSecretFrom({ input: process.stdin, output: process.stderr })
  if (password.length === 0) throw new Error('empty password refused')

  const supabase = createSupabase({ url: env.SUPABASE_URL, secretKey: env.SUPABASE_SECRET_KEY })
  const result = await createUser({ supabase, id: args.id, email: args.email, password })
  if (result.ok) console.error(`created ${args.email} as ${result.id}`)
  else {
    console.error(`the API refused id ${args.id} (${result.reason}); created ${args.email} as ${result.id} instead.`)
    console.error('Run this against the target database, then rerun the check below. Not run for you:')
    console.log(result.fallbackSql)
  }

  const db = new pg.Client(connectionConfig(env.SUPABASE_DB_URL))
  await db.connect()
  try {
    const check = await orphanCheck(db)
    console.error(`libraries with no auth user: ${check.orphans}`)
    if (!check.ok || !result.ok) process.exitCode = 1
  } finally {
    await db.end()
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
