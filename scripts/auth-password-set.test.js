// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { parseArgs, setPassword } from './auth-password-set.mjs'

describe('parseArgs', () => {
  it('takes the email', () => {
    expect(parseArgs(['--email', 'her@example.com'])).toEqual({ email: 'her@example.com' })
  })
  it('refuses a missing email, a password flag and unknown flags', () => {
    expect(() => parseArgs([])).toThrow(/--email/)
    expect(() => parseArgs(['--email'])).toThrow(/--email/)
    expect(() => parseArgs(['--email', 'a@b.c', '--password', 'x'])).toThrow(/unknown flag/)
  })
})

describe('setPassword', () => {
  const user = (id, email) => ({ id, email })
  function fakeAdmin(pages, updateResult = { error: null }) {
    const calls = { listUsers: [], updateUserById: [] }
    const admin = {
      auth: {
        admin: {
          listUsers: async (params) => {
            calls.listUsers.push(params)
            return { data: { users: pages[params.page - 1] ?? [] }, error: null }
          },
          updateUserById: async (id, attrs) => {
            calls.updateUserById.push([id, attrs])
            return updateResult
          },
        },
      },
    }
    return { admin, calls }
  }

  it('finds her account by email, on any page and in any case, and sets the password on it', async () => {
    const { admin, calls } = fakeAdmin([[user('u1', 'someone@x.y')], [user('u2', 'Her@Example.com')]])
    await expect(setPassword({ supabase: admin, email: 'her@example.com', password: 'pw', perPage: 1 })).resolves.toBe('u2')
    expect(calls.updateUserById).toEqual([['u2', { password: 'pw' }]])
  })

  it('refuses an address with no account, and creates none', async () => {
    const { admin, calls } = fakeAdmin([[user('u1', 'someone@x.y')]])
    await expect(setPassword({ supabase: admin, email: 'nobody@x.y', password: 'pw' })).rejects.toThrow(/no account for nobody@x.y/)
    expect(calls.updateUserById).toEqual([])
  })

  it('refuses an empty password', async () => {
    const { admin } = fakeAdmin([[user('u1', 'her@x.y')]])
    await expect(setPassword({ supabase: admin, email: 'her@x.y', password: '' })).rejects.toThrow(/empty password/)
  })

  it('passes on what Supabase refused', async () => {
    const { admin } = fakeAdmin([[user('u1', 'her@x.y')]], { error: { message: 'Password should be at least 6 characters.' } })
    await expect(setPassword({ supabase: admin, email: 'her@x.y', password: 'a' })).rejects.toThrow(/at least 6/)
  })
})

/**
 * Against a real Supabase stack. Opt-in, like the other smoke tests: set
 * SMOKE_SUPABASE_URL, SMOKE_SUPABASE_PUBLISHABLE_KEY and SMOKE_SUPABASE_SECRET_KEY.
 */
const url = process.env.SMOKE_SUPABASE_URL
const publishableKey = process.env.SMOKE_SUPABASE_PUBLISHABLE_KEY
const secretKey = process.env.SMOKE_SUPABASE_SECRET_KEY

describe.skipIf(!(url && publishableKey && secretKey))('setPassword against a real Supabase stack', () => {
  it('after a reset, the new password signs in and the old one does not', async () => {
    const admin = createClient(url, secretKey, { auth: { persistSession: false } })
    const email = `reset-${randomUUID()}@example.test`
    const { data, error } = await admin.auth.admin.createUser({ email, password: 'old-password-1', email_confirm: true })
    if (error) throw error
    try {
      await expect(setPassword({ supabase: admin, email, password: 'new-password-2' })).resolves.toBe(data.user.id)
      const device = createClient(url, publishableKey, { auth: { persistSession: false } })
      expect((await device.auth.signInWithPassword({ email, password: 'old-password-1' })).error).not.toBeNull()
      expect((await device.auth.signInWithPassword({ email, password: 'new-password-2' })).error).toBeNull()
    } finally {
      await admin.auth.admin.deleteUser(data.user.id)
    }
  })
})
