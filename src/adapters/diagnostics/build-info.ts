/** What identifies this build — read aloud over the phone so a bug report
 * can be pinned to a specific deploy instead of guessed at. */
export interface BuildInfo {
  readonly sha: string
  readonly builtAt: string
}

/**
 * Reads the build stamp `vite.config.ts` embeds via `define` at build (or
 * dev-server-start) time — real git state, not a hand-edited placeholder.
 */
export function getBuildInfo(): BuildInfo {
  return { sha: __BUILD_SHA__, builtAt: __BUILD_TIME__ }
}
