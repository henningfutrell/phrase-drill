import { describe, expect, it } from 'vitest'
import { readSupabaseEnv } from './supabase-env'

describe('readSupabaseEnv', () => {
  it('returns the url and publishable key', () => {
    expect(
      readSupabaseEnv({ VITE_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x' }),
    ).toEqual({ url: 'http://127.0.0.1:54321', publishableKey: 'sb_publishable_x' })
  })

  it.each([
    ['VITE_SUPABASE_URL', { VITE_SUPABASE_PUBLISHABLE_KEY: 'k' }],
    ['VITE_SUPABASE_PUBLISHABLE_KEY', { VITE_SUPABASE_URL: 'http://x' }],
    ['VITE_SUPABASE_URL', { VITE_SUPABASE_URL: '  ', VITE_SUPABASE_PUBLISHABLE_KEY: 'k' }],
  ])('throws naming %s when it is unset or blank', (name, env) => {
    expect(() => readSupabaseEnv(env)).toThrow(name)
  })
})
