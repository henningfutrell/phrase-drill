#!/usr/bin/env node
// T050: creates the one row `server/db.js`'s `createAuthStore` needs to let
// someone log in. There is no signup endpoint — two users, no self-service —
// so this CLI is the only way an account gets made. Username is a CLI
// argument; the password is read from stdin, never argv, so it never lands
// in shell history or `ps`.
//
// Usage:
//   npm run useradd -- her
//   (then type the password, Enter, Ctrl-D)
//
// An existing username is refused (server/db.js#createAuthStore.createUser
// raises Postgres's own unique-violation on `users.username`) — this script
// never overwrites an account; use it to create one, not to reset a
// password (also fine: same command, since a fresh id/hash simply won't be
// written if the username's taken — see "already exists" below for how a
// password reset actually happens).

import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { createPool, createAuthStore, waitForDatabase } from '../server/db.js'
import { hashPassword } from '../server/session-auth.js'

async function readPasswordFromStdin() {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, terminal: false })
    let line
    rl.on('line', (l) => {
      if (line === undefined) line = l
    })
    rl.on('close', () => (line !== undefined ? resolve(line) : reject(new Error('no password read from stdin'))))
    rl.on('error', reject)
  })
}

async function main() {
  const username = process.argv[2]
  if (!username) {
    console.error('usage: npm run useradd -- <username>   (password is read from stdin)')
    process.exitCode = 1
    return
  }

  const password = await readPasswordFromStdin()
  if (password.length === 0) {
    console.error('empty password refused')
    process.exitCode = 1
    return
  }

  const databaseUrl = process.env.DATABASE_URL ?? 'postgres://phrase_drill:phrase_drill@localhost:5432/phrase_drill'
  const pool = createPool(databaseUrl)
  await waitForDatabase(pool)
  const authStore = createAuthStore(pool)
  await authStore.init()

  const existing = await authStore.getUserByUsername(username)
  if (existing) {
    console.error(`user "${username}" already exists — this script never overwrites an account.`)
    console.error('To reset a password, delete the row from `users` and re-run this script (there is no admin UI, by design).')
    process.exitCode = 1
    await authStore.close()
    return
  }

  await authStore.createUser({
    id: randomUUID(),
    username,
    passwordHash: hashPassword(password),
    createdAt: Date.now(),
  })
  console.log(`created user "${username}"`)
  await authStore.close()
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
