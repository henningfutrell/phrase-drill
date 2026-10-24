// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createAccountPasswordSetter } from './account-password.js'

/** A Supabase client whose `admin.updateUserById` answers one canned result, recording each call. */
function fakeSupabase(result) {
  const calls = []
  const supabase = {
    auth: {
      admin: {
        updateUserById: async (id, attributes) => {
          calls.push({ id, attributes })
          if (result instanceof Error) throw result
          return result
        },
      },
    },
  }
  return { supabase, calls }
}

describe('createAccountPasswordSetter (fake client)', () => {
  it('sets the password on the named account', async () => {
    const { supabase, calls } = fakeSupabase({ data: { user: { id: 'user-1' } }, error: null })
    expect(await createAccountPasswordSetter(supabase)('user-1', 'pw')).toEqual({ ok: true })
    expect(calls).toEqual([{ id: 'user-1', attributes: { password: 'pw' } }])
  })

  it('maps same_password and weak_password to their reasons', async () => {
    const same = fakeSupabase({ data: null, error: { code: 'same_password', message: 'x' } })
    expect(await createAccountPasswordSetter(same.supabase)('u', 'pw')).toEqual({ ok: false, reason: 'same-password' })
    const weak = fakeSupabase({ data: null, error: { code: 'weak_password', message: 'x' } })
    expect(await createAccountPasswordSetter(weak.supabase)('u', 'pw')).toEqual({ ok: false, reason: 'weak-password' })
  })

  it('answers upstream for any other error, or a throw', async () => {
    const other = fakeSupabase({ data: null, error: { code: 'unexpected_failure', message: 'x' } })
    expect(await createAccountPasswordSetter(other.supabase)('u', 'pw')).toEqual({ ok: false, reason: 'upstream' })
    const thrown = fakeSupabase(new Error('network down'))
    expect(await createAccountPasswordSetter(thrown.supabase)('u', 'pw')).toEqual({ ok: false, reason: 'upstream' })
  })
})
