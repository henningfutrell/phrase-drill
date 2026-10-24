// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findSecretsInBundle } from './check-bundle-secrets.mjs'

const jwt = (payload) =>
  [{ alg: 'HS256', typ: 'JWT' }, payload].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + '.c2lnbmF0dXJl'

describe('findSecretsInBundle', () => {
  let dir
  const bundle = (files) => {
    dir = mkdtempSync(join(tmpdir(), 'phrase-drill-bundle-'))
    mkdirSync(join(dir, 'assets'))
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
    return dir
  }
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('passes a bundle that holds only the publishable values', () => {
    // supabase-js itself carries the bare prefix `sb_secret_` to tell key kinds apart: that is not a key.
    const d = bundle({ 'assets/index.js': 'e.startsWith(`sb_secret_`);const k="sb_publishable_abcdefghijklmnopqrstuv"' })
    expect(findSecretsInBundle(d, {})).toEqual([])
  })

  it('finds the value of a server-only env var', () => {
    const d = bundle({ 'assets/index.js': 'const k="the-anthropic-key-value"' })
    expect(findSecretsInBundle(d, { ANTHROPIC_API_KEY: 'the-anthropic-key-value' })).toEqual([
      { file: 'assets/index.js', what: 'the value of ANTHROPIC_API_KEY' },
    ])
  })

  it('finds a Supabase secret key', () => {
    // Built at run time: a literal key-shaped string here is refused by GitHub push protection.
    const d = bundle({ 'sw.js': `const k="${'sb_secret_' + 'A1b2C3d4'.repeat(4)}"` })
    expect(findSecretsInBundle(d, {})).toEqual([{ file: 'sw.js', what: 'a Supabase secret key (sb_secret_…)' }])
  })

  it('finds a legacy service_role JWT, and passes an anon one', () => {
    const d = bundle({ 'assets/a.js': `const a="${jwt({ role: 'anon' })}"`, 'assets/b.js': `const b="${jwt({ role: 'service_role' })}"` })
    expect(findSecretsInBundle(d, {})).toEqual([{ file: 'assets/b.js', what: 'a service_role JWT' }])
  })

  it('ignores an env var that is unset or empty', () => {
    const d = bundle({ 'assets/index.js': 'const x=""' })
    expect(findSecretsInBundle(d, { SUPABASE_SECRET_KEY: '', ELEVENLABS_API_KEY: undefined })).toEqual([])
  })
})
