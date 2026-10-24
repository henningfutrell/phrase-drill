/**
 * Plain mirrors of `LoginResult` and `PasswordChangeResult`
 * (adapters/auth/session-auth.ts) — no adapter type crosses into UI
 * (AGENTS.md: only App.tsx/main.tsx import from both domain/ and adapters/*).
 * The composition root passes the adapter's results in, which is where
 * TypeScript checks the two still agree.
 */
export type LoginResult = { ok: true } | { ok: false; reason: 'invalid-credentials' | 'network' }

export type PasswordChangeResult =
  | { ok: true }
  | { ok: false; reason: 'weak-password' | 'same-password' | 'signed-out' | 'network' }
