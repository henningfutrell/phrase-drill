/**
 * Replaces every occurrence of a known secret with `[REDACTED]`. Used at the
 * single write path for captured errors (`error-log.ts`) so a key can never
 * ride along in a diagnostic report — see AGENTS.md "Never leak secrets."
 * `null`/`undefined`/empty entries are ignored rather than treated as a
 * secret to redact (an empty string would match everywhere).
 */
export function redactSecrets(text: string, secrets: readonly (string | null | undefined)[]): string {
  let result = text
  for (const secret of secrets) {
    if (!secret) continue
    result = result.split(secret).join('[REDACTED]')
  }
  return result
}
