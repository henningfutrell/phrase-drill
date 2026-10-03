import { createClient } from '@supabase/supabase-js'

/** The server's one Supabase client: Auth token verification and Storage. */
export function createSupabase({ url, secretKey }) {
  return createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
}
