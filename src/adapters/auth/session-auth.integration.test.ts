// @vitest-environment node
/**
 * Device login against a real Supabase stack. Opt-in, like the server's
 * database smoke test: set SMOKE_SUPABASE_URL, SMOKE_SUPABASE_PUBLISHABLE_KEY
 * and SMOKE_SUPABASE_SECRET_KEY (the local stack's — `npx supabase status -o env`).
 * Skipped otherwise.
 */
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createSessionAuth } from './session-auth'
import { createSupabaseAuthClient } from './supabase-client'

const url = process.env.SMOKE_SUPABASE_URL
const publishableKey = process.env.SMOKE_SUPABASE_PUBLISHABLE_KEY
const secretKey = process.env.SMOKE_SUPABASE_SECRET_KEY
const RUN = Boolean(url && publishableKey && secretKey)

describe.skipIf(!RUN)('session-auth against a real Supabase stack', () => {
  const email = `device-${randomUUID()}@example.test`
  const password = `pw-${randomUUID()}`
  let userId = ''
  const admin = RUN ? createClient(url!, secretKey!, { auth: { persistSession: false } }) : null

  beforeAll(async () => {
    const { data, error } = await admin!.auth.admin.createUser({ email, password, email_confirm: true })
    if (error) throw error
    userId = data.user.id
  })

  afterAll(async () => {
    if (userId) await admin!.auth.admin.deleteUser(userId)
  })

  it('logs in, carries a token on authFetch, refuses a wrong password, and logs out', async () => {
    const client = createSupabaseAuthClient({ url: url!, publishableKey: publishableKey!, storage: memoryStorage() })
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({ status: 200 } as Response)
    const onUnauthorized = vi.fn()
    const auth = createSessionAuth({ client, fetchImpl, onUnauthorized })

    expect(await auth.login(email, 'wrong-password')).toEqual({ ok: false, reason: 'invalid-credentials' })
    expect(await auth.login(email, password)).toEqual({ ok: true })

    const token = await auth.getAccessToken()
    expect(token.split('.')).toHaveLength(3)
    await auth.authFetch('/api/library')
    expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get('authorization')).toBe(`Bearer ${token}`)

    await auth.logout()
    await expect(auth.getAccessToken()).rejects.toThrow('login required')
  })
})

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  }
}
