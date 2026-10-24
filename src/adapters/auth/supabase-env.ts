/**
 * The two public Supabase values the device build needs. Both are public by
 * design — the publishable key only opens what row-level security and the
 * disabled Data API allow — but a build or boot without them has no login at
 * all, so a missing value throws rather than falling back to anything.
 */
export interface SupabaseEnv {
  url: string
  publishableKey: string
}

export function readSupabaseEnv(env: Record<string, string | undefined>): SupabaseEnv {
  const read = (name: string): string => {
    const value = env[name]?.trim()
    if (!value) throw new Error(`${name} is not set — the app cannot log in without it (see .env.example)`)
    return value
  }
  return { url: read('VITE_SUPABASE_URL'), publishableKey: read('VITE_SUPABASE_PUBLISHABLE_KEY') }
}
