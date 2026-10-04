#!/usr/bin/env node
// Sets a new password on an existing Supabase Auth account — how a forgotten
// password is reset. There is no reset email: run this on backup-host, then tell
// them the new password.
//
//   SUPABASE_URL=... SUPABASE_SECRET_KEY=... \
//     node scripts/auth-password-set.mjs --email user@example.com
//   (the password is read from stdin, never from argv)
//
// Never creates an account: an address with none exits non-zero.

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createSupabase } from '../server/supabase.js'
import { readSecretFrom } from './auth-user-create.mjs'

const PAGE_SIZE = 1000

export function parseArgs(argv) {
  const out = { email: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--email') {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) throw new Error('--email needs a value')
      out.email = value
    } else throw new Error(`unknown flag: ${arg}`)
  }
  if (!out.email) throw new Error('--email is required')
  return out
}

/** Sets `password` on the account whose email is `email`; resolves to its user id. */
export async function setPassword({ supabase, email, password, perPage = PAGE_SIZE }) {
  if (password.length === 0) throw new Error('empty password refused')
  const wanted = email.trim().toLowerCase()
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage })
    if (error) throw new Error(error.message)
    const user = data.users.find((u) => u.email?.toLowerCase() === wanted)
    if (user) {
      const updated = await supabase.auth.admin.updateUserById(user.id, { password })
      if (updated.error) throw new Error(updated.error.message)
      return user.id
    }
    if (data.users.length < perPage) throw new Error(`no account for ${email}`)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const env = process.env
  const missing = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY'].filter((n) => !env[n])
  if (missing.length > 0) throw new Error(`unset: ${missing.join(', ')}`)
  const password = await readSecretFrom({
    input: process.stdin,
    output: process.stderr,
    prompt: `new password for ${args.email} (not echoed): `,
  })
  const supabase = createSupabase({ url: env.SUPABASE_URL, secretKey: env.SUPABASE_SECRET_KEY })
  const id = await setPassword({ supabase, email: args.email, password })
  console.error(`password set for ${args.email} (${id})`)
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
