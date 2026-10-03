import { createClient } from '@supabase/supabase-js'
import type { AuthClient } from './session-auth'
import type { SupabaseEnv } from './supabase-env'

/**
 * The one place the Supabase SDK is constructed. The client persists and
 * auto-refreshes the session in `localStorage` by default; `storage` is
 * injectable for tests that have none. Only Auth is used from it — the
 * database is reached through this app's own server, never from the device.
 */
export function createSupabaseAuthClient(
  env: SupabaseEnv & { storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } },
): AuthClient {
  return createClient(env.url, env.publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storage: env.storage },
  })
}
