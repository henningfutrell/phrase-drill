// @vitest-environment node
import { Readable, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { parseArgs, readSecretFrom, idRewriteSql, createUser, ORPHAN_LIBRARIES_SQL, orphanCheck } from './auth-user-create.mjs'

describe('parseArgs', () => {
  it('takes email and optional id', () => {
    expect(parseArgs(['--email', 'her@example.com', '--id', 'abc'])).toEqual({ email: 'her@example.com', id: 'abc', mapFromRender: false })
    expect(parseArgs(['--email', 'her@example.com'])).toEqual({ email: 'her@example.com', id: undefined, mapFromRender: false })
  })
  it('--map-from-render needs no email', () => {
    expect(parseArgs(['--map-from-render'])).toEqual({ email: undefined, id: undefined, mapFromRender: true })
  })
  it('refuses a missing email, a password flag and unknown flags', () => {
    expect(() => parseArgs([])).toThrow(/--email/)
    expect(() => parseArgs(['--email', 'a@b.c', '--password', 'x'])).toThrow(/unknown flag/)
    expect(() => parseArgs(['--email'])).toThrow(/--email/)
  })
})

describe('readSecretFrom', () => {
  const sink = () => {
    const written = []
    const stream = new Writable({ write: (c, _e, cb) => (written.push(c.toString()), cb()) })
    stream.written = written
    return stream
  }
  it('reads the first line without echoing it', async () => {
    const output = sink()
    const input = Readable.from(['hunter2\nrest\n'])
    await expect(readSecretFrom({ input, output })).resolves.toBe('hunter2')
    expect(output.written.join('')).not.toContain('hunter2')
    expect(output.written.join('')).toMatch(/password/)
  })
  it('rejects a stream that ends with no line', async () => {
    await expect(readSecretFrom({ input: Readable.from([]), output: sink() })).rejects.toThrow(/no password/)
  })
})

describe('idRewriteSql', () => {
  it('rewrites both library tables in one transaction', () => {
    const sql = idRewriteSql('old-id', 'new-id')
    expect(sql).toBe(
      [
        'BEGIN;',
        "UPDATE libraries SET library_key = 'new-id' WHERE library_key = 'old-id';",
        "UPDATE library_versions SET library_key = 'new-id' WHERE library_key = 'old-id';",
        'COMMIT;',
      ].join('\n'),
    )
  })
})

describe('createUser', () => {
  const adminWith = (impl) => ({ auth: { admin: { createUser: impl } } })
  it('passes id, email, password and email_confirm', async () => {
    let seen
    const admin = adminWith(async (a) => ((seen = a), { data: { user: { id: 'u1' } }, error: null }))
    await expect(createUser({ supabase: admin, id: 'u1', email: 'e@x.y', password: 'pw' })).resolves.toEqual({ ok: true, id: 'u1' })
    expect(seen).toEqual({ id: 'u1', email: 'e@x.y', password: 'pw', email_confirm: true })
  })
  it('omits id when none is given', async () => {
    let seen
    const admin = adminWith(async (a) => ((seen = a), { data: { user: { id: 'gen' } }, error: null }))
    await createUser({ supabase: admin, email: 'e@x.y', password: 'pw' })
    expect('id' in seen).toBe(false)
  })
  it('on a refused id, creates without it and hands back the rewrite SQL instead of running it', async () => {
    const calls = []
    const admin = adminWith(async (a) => {
      calls.push(a)
      return a.id ? { data: { user: null }, error: { message: 'id not allowed' } } : { data: { user: { id: 'gen' } }, error: null }
    })
    const result = await createUser({ supabase: admin, id: 'old', email: 'e@x.y', password: 'pw' })
    expect(result).toEqual({ ok: false, id: 'gen', fallbackSql: idRewriteSql('old', 'gen'), reason: 'id not allowed' })
    expect(calls).toHaveLength(2)
  })
  it('does not retry when the email is the problem', async () => {
    const admin = adminWith(async () => ({ data: { user: null }, error: { code: 'email_exists', message: 'exists' } }))
    await expect(createUser({ supabase: admin, id: 'old', email: 'e@x.y', password: 'pw' })).rejects.toThrow(/exists/)
  })
})

describe('orphanCheck', () => {
  it('counts libraries with no auth user and is ok only at zero', async () => {
    const db = (n) => ({ query: async (sql) => (sql === ORPHAN_LIBRARIES_SQL ? { rows: [{ count: String(n) }] } : Promise.reject(new Error(sql))) })
    await expect(orphanCheck(db(0))).resolves.toEqual({ ok: true, orphans: 0 })
    await expect(orphanCheck(db(2))).resolves.toEqual({ ok: false, orphans: 2 })
  })
})
