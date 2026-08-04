#!/usr/bin/env node
// T050: creates the one row `server/db.js`'s `createAuthStore` needs to let
// someone log in. There is no signup endpoint — two users, no self-service —
// so this CLI is the only way an account gets made. Username is a CLI
// argument; the password is read from stdin, never argv, so it never lands
// in shell history or `ps`.
//
// Usage:
//   npm run useradd -- her
//   (then type the password and press Enter — no Ctrl-D)
//
// An existing username is refused (server/db.js#createAuthStore.users.create
// raises Postgres's own unique-violation on `users.username`) — this script
// never overwrites an account; use it to create one, not to reset a
// password (also fine: same command, since a fresh id/hash simply won't be
// written if the username's taken — see "already exists" below for how a
// password reset actually happens).

import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createPool, createAuthStore, waitForDatabase } from '../server/db.js'
import { hashPassword } from '../server/session-auth.js'

/**
 * Reads one password, resolving on the FIRST newline — never on EOF (T055).
 *
 * The earlier version resolved on readline's `close` event, which fires only
 * at EOF, so an interactive user had to press Ctrl-D. Render's web Shell does
 * not reliably deliver Ctrl-D, and where it does it can end the session
 * instead of the read — so the script simply hung after Enter, with no output
 * to say why. It also printed no prompt at all, which made a silent wait
 * indistinguishable from a crashed process.
 *
 * `output` gets the prompt (stderr by default, so `useradd ... > file` still
 * shows it). `close` is still handled, but only as the failure path: a stream
 * that ends without ever yielding a line means no password was supplied.
 */
export function readPasswordFrom({ input, output }) {
  return new Promise((resolve, reject) => {
    output.write(`password for the new account (typing is not echoed back by this script): `)
    const rl = createInterface({ input, terminal: false })
    let settled = false
    rl.on('line', (line) => {
      if (settled) return
      settled = true
      rl.close()
      // `close()` pauses the stream but does not UNREF it, and a referenced
      // `process.stdin` holds the event loop open forever. Without this the
      // account is created and the process then hangs with nothing printed —
      // from the keyboard, identical to the bug above. `unref` is absent on a
      // plain Readable, hence the guard.
      input.unref?.()
      // A CRLF terminal leaves \r on the line; hashing it would make the
      // password unenterable from anywhere that sends bare \n.
      resolve(line.replace(/\r$/, ''))
    })
    rl.on('close', () => {
      if (settled) return
      settled = true
      reject(new Error('no password read from stdin'))
    })
    rl.on('error', (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}

async function main() {
  const username = process.argv[2]
  if (!username) {
    console.error('usage: npm run useradd -- <username>   (password is read from stdin)')
    process.exitCode = 1
    return
  }

  const password = await readPasswordFrom({ input: process.stdin, output: process.stderr })
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

  const existing = await authStore.users.getByUsername(username)
  if (existing) {
    console.error(`user "${username}" already exists — this script never overwrites an account.`)
    console.error('To reset a password, delete the row from `users` and re-run this script (there is no admin UI, by design).')
    process.exitCode = 1
    await authStore.close()
    return
  }

  await authStore.users.create({
    id: randomUUID(),
    username,
    passwordHash: hashPassword(password),
    createdAt: Date.now(),
  })
  console.log(`created user "${username}"`)
  await authStore.close()
}

// Only run when executed directly. `useradd.test.js` imports `readPasswordFrom`
// from this module, and an unguarded `main()` would open a database connection
// on import — the test would hang against a database that isn't there.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
