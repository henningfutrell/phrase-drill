// @vitest-environment node
/**
 * Sign-in by emailed code, and the forgot-password reset, against a real
 * Supabase stack and its Mailpit. Opt-in: set SMOKE_SUPABASE_URL,
 * SMOKE_SUPABASE_PUBLISHABLE_KEY, SMOKE_SUPABASE_SECRET_KEY and
 * SMOKE_MAILPIT_URL (the local stack's — `npx supabase status -o env`).
 * Skipped otherwise. The code is read out of the email the stack sent, so
 * this also proves the templates in supabase/templates carry it.
 */
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSessionAuth } from './session-auth'
import { createSupabaseAuthClient } from './supabase-client'

const url = process.env.SMOKE_SUPABASE_URL
const publishableKey = process.env.SMOKE_SUPABASE_PUBLISHABLE_KEY
const secretKey = process.env.SMOKE_SUPABASE_SECRET_KEY
const mailpit = process.env.SMOKE_MAILPIT_URL
const RUN = Boolean(url && publishableKey && secretKey && mailpit)

describe.skipIf(!RUN)('email codes against a real Supabase stack', () => {
  const email = `code-${randomUUID()}@example.test`
  const password = `pw-${randomUUID()}`
  let userId = ''
  const admin = RUN ? createClient(url!, secretKey!, { auth: { persistSession: false } }) : null

  function device() {
    const client = createSupabaseAuthClient({ url: url!, publishableKey: publishableKey!, storage: memoryStorage() })
    return createSessionAuth({ client })
  }

  beforeAll(async () => {
    const { data, error } = await admin!.auth.admin.createUser({ email, password, email_confirm: true })
    if (error) throw error
    userId = data.user.id
  })

  afterAll(async () => {
    if (userId) await admin!.auth.admin.deleteUser(userId)
  })

  it('signs in with the code from the sign-in email', async () => {
    const auth = device()
    const sentAfter = Date.now()
    expect(await auth.requestSignInCode(email)).toEqual({ ok: true })
    const mail = await latestMailTo(email, sentAfter)
    expect(mail.subject).toBe('Your phrase-drill sign-in code')

    expect(await auth.verifySignInCode(email, '000000')).toEqual({ ok: false, reason: 'invalid-code' })
    expect(await auth.verifySignInCode(email, mail.code)).toEqual({ ok: true })
    expect((await auth.getAccessToken()).split('.')).toHaveLength(3)
  })

  it('refuses an address with no account, and creates none', async () => {
    const stranger = `nobody-${randomUUID()}@example.test`
    expect(await device().requestSignInCode(stranger)).toEqual({ ok: false, reason: 'unknown-email' })
    const { data } = await admin!.auth.admin.listUsers()
    expect(data.users.map((u) => u.email)).not.toContain(stranger)
  })

  it('resets a forgotten password with the code from the reset email', async () => {
    const auth = device()
    await new Promise((r) => setTimeout(r, 1100)) // the stack's per-user email gap (max_frequency)
    const sentAfter = Date.now()
    expect(await auth.requestPasswordReset(email)).toEqual({ ok: true })
    const mail = await latestMailTo(email, sentAfter)
    expect(mail.subject).toBe('Your phrase-drill code')

    expect(await auth.verifyResetCode(email, mail.code)).toEqual({ ok: true })
    const newPassword = `new-${randomUUID()}`
    expect(await auth.changePassword(newPassword)).toEqual({ ok: true })
    await auth.logout()

    const fresh = device()
    expect(await fresh.login(email, password)).toEqual({ ok: false, reason: 'invalid-credentials' })
    expect(await fresh.login(email, newPassword)).toEqual({ ok: true })
    expect(await fresh.changePassword(newPassword)).toEqual({ ok: false, reason: 'same-password' })
  })
})

/** The newest email Mailpit holds for `to`, sent no earlier than `after`, and the 6-digit code in it. */
async function latestMailTo(to: string, after: number): Promise<{ subject: string; code: string }> {
  for (let i = 0; i < 50; i++) {
    const search = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)
    const { messages } = (await search.json()) as { messages: { ID: string; Subject: string; Created: string }[] }
    const fresh = messages.find((m) => Date.parse(m.Created) >= after - 1000)
    if (fresh) {
      const message = (await (await fetch(`${mailpit}/api/v1/message/${fresh.ID}`)).json()) as { Text: string }
      const code = /\b(\d{6})\b/.exec(message.Text)?.[1]
      if (!code) throw new Error(`no 6-digit code in: ${message.Text}`)
      return { subject: fresh.Subject, code }
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`no email to ${to}`)
}

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  }
}
