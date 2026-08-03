/// <reference types="vite/client" />

/**
 * Build identifier, injected by `vite.config.ts`'s `define` at build/dev
 * start (`git rev-parse --short HEAD`) — the visible build stamp T039 asks
 * for, so she can read it aloud and say whether she has today's deploy.
 * Falls back to `'unknown'` if git isn't available (e.g. building from a
 * source archive with no `.git`).
 */
declare const __BUILD_SHA__: string

/** ISO timestamp of when the build/dev server started, from the same `define`. */
declare const __BUILD_TIME__: string
