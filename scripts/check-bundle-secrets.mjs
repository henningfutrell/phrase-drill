#!/usr/bin/env node
/**
 * Refuses a device bundle that carries a server credential.
 *
 *   node scripts/check-bundle-secrets.mjs [dist]
 *
 * The device holds no credential but the publishable key (AGENTS.md, T041).
 * This reads every file of the built bundle and reports:
 *
 * - the value of any server-only env var that is set while it runs
 *   (`SERVER_SECRET_ENV`). CI builds with canary values in them, so a config
 *   change that inlines `process.env` into the bundle fails here;
 * - any Supabase secret key (`sb_secret_` followed by a key body). The bare
 *   prefix alone is not a key: supabase-js carries it to tell key kinds apart;
 * - any legacy JWT key whose payload says `"role":"service_role"`.
 *
 * Exit 0: clean. Exit 1: a finding, named by file and kind, never by value.
 */
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SERVER_SECRET_ENV = ['SUPABASE_SECRET_KEY', 'ELEVENLABS_API_KEY', 'ANTHROPIC_API_KEY', 'DATABASE_URL']

const SECRET_KEY = /sb_secret_[A-Za-z0-9_-]{16,}/
const JWT = /eyJ[A-Za-z0-9_-]+\.(eyJ[A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

function hasServiceRoleJwt(text) {
  for (const match of text.matchAll(JWT)) {
    try {
      if (JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')).role === 'service_role') return true
    } catch {
      // Not a JWT after all: a minified identifier that happens to match.
    }
  }
  return false
}

/** Every finding in the bundle at `dir`, as `{ file, what }`, `file` relative to `dir`. */
export function findSecretsInBundle(dir, env) {
  const values = SERVER_SECRET_ENV.filter((name) => env[name]).map((name) => [name, env[name]])
  const findings = []
  for (const path of filesUnder(dir).sort()) {
    const text = readFileSync(path, 'utf8')
    const file = relative(dir, path)
    for (const [name, value] of values) if (text.includes(value)) findings.push({ file, what: `the value of ${name}` })
    if (SECRET_KEY.test(text)) findings.push({ file, what: 'a Supabase secret key (sb_secret_…)' })
    if (hasServiceRoleJwt(text)) findings.push({ file, what: 'a service_role JWT' })
  }
  return findings
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? 'dist'
  const findings = findSecretsInBundle(dir, process.env)
  for (const { file, what } of findings) console.error(`${dir}/${file}: ${what}`)
  if (findings.length > 0) process.exit(1)
  console.log(`${dir}: no server credential found`)
}
