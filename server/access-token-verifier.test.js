// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccessTokenVerifier } from './access-token-verifier.js'
import { createSupabase } from './supabase.js'

/** A Supabase client whose `getClaims` answers one canned result. */
function fakeSupabase(result) {
  return { auth: { getClaims: async () => result } }
}

describe('createAccessTokenVerifier (fake client)', () => {
  it('answers the subject of verified claims', async () => {
    const verify = createAccessTokenVerifier(fakeSupabase({ data: { claims: { sub: 'user-1', role: 'authenticated' } }, error: null }))
    expect(await verify('t')).toEqual({ sub: 'user-1' })
  })

  it('answers null when Supabase reports an error', async () => {
    const verify = createAccessTokenVerifier(fakeSupabase({ data: null, error: new Error('invalid JWT') }))
    expect(await verify('t')).toBeNull()
  })

  it('answers null when there are no claims', async () => {
    const verify = createAccessTokenVerifier(fakeSupabase({ data: null, error: null }))
    expect(await verify('t')).toBeNull()
  })

  it('answers null when the subject is missing or empty', async () => {
    expect(await createAccessTokenVerifier(fakeSupabase({ data: { claims: {} }, error: null }))('t')).toBeNull()
    expect(await createAccessTokenVerifier(fakeSupabase({ data: { claims: { sub: '' } }, error: null }))('t')).toBeNull()
  })

  it('answers null when the client throws', async () => {
    const supabase = {
      auth: {
        getClaims: async () => {
          throw new Error('network down')
        },
      },
    }
    expect(await createAccessTokenVerifier(supabase)('t')).toBeNull()
  })
})

/**
 * Opt-in against the local Supabase stack (`npx supabase start`). Set
 * `SMOKE_SUPABASE_URL` and `SMOKE_SUPABASE_SECRET_KEY` (values from
 * `npx supabase status -o env`, plus `SMOKE_SUPABASE_PUBLISHABLE_KEY` for the
 * sign-in). Skipped, not failed, when unset.
 */
const url = process.env.SMOKE_SUPABASE_URL
const secretKey = process.env.SMOKE_SUPABASE_SECRET_KEY
const publishableKey = process.env.SMOKE_SUPABASE_PUBLISHABLE_KEY

describe.skipIf(!url || !secretKey || !publishableKey)('createAccessTokenVerifier (real Supabase Auth)', () => {
  const email = `verifier-${randomUUID()}@example.test`
  const password = randomUUID()
  let admin
  let userId
  let accessToken
  let verify

  beforeAll(async () => {
    admin = createSupabase({ url, secretKey })
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (created.error) throw created.error
    userId = created.data.user.id
    // The local stack's config.toml disables the email provider (sign-ups are
    // off), which also refuses signInWithPassword; a magic-link token exchange
    // yields the same real session without it.
    const link = await admin.auth.admin.generateLink({ type: 'magiclink', email })
    if (link.error) throw link.error
    const client = createSupabase({ url, secretKey: publishableKey })
    const signedIn = await client.auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: 'magiclink' })
    if (signedIn.error) throw signedIn.error
    accessToken = signedIn.data.session.access_token
    verify = createAccessTokenVerifier(admin)
  })

  afterAll(async () => {
    if (userId) await admin.auth.admin.deleteUser(userId)
  })

  it("gives the user's id as sub for a genuine access token", async () => {
    expect(await verify(accessToken)).toEqual({ sub: userId })
  })

  it('answers null for a garbage token', async () => {
    expect(await verify('not-a-jwt')).toBeNull()
  })

  it('answers null for a token with a forged signature', async () => {
    const [header, payload] = accessToken.split('.')
    expect(await verify(`${header}.${payload}.${'A'.repeat(43)}`)).toBeNull()
  })

  it('answers null for an expired token', async () => {
    const expired = await signExpired({ sub: userId })
    expect(await verify(expired)).toBeNull()
  })
})

/** An HS256 token with the right shape and a past `exp`, signed with a key Supabase does not hold. */
async function signExpired(claims) {
  const { createHmac } = await import('node:crypto')
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ ...claims, role: 'authenticated', exp: 1 })}`
  return `${body}.${createHmac('sha256', 'wrong-key').update(body).digest('base64url')}`
}
