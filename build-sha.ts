/**
 * Resolves the commit this build came from, for the Diagnostics build stamp
 * (T039) she reads aloud when something is wrong on the phone.
 *
 * Two sources, because the two ways this app is built can each answer only
 * one of them:
 *
 * - **Render (production).** The builder image is `node:26-alpine`, which has
 *   no `git`, and `.dockerignore` excludes `.git` from the build context in
 *   any case — so shelling out cannot work there and never did. Render
 *   injects `RENDER_GIT_COMMIT` into the build, and the Dockerfile's
 *   `ARG RENDER_GIT_COMMIT` in the builder stage is what carries it this far.
 * - **A local build or the dev server.** No platform variable, but a real
 *   `.git` — so `git rev-parse` answers.
 *
 * Before this, only the second existed, so every deploy that has ever run
 * stamped itself `unknown`: the single question the stamp was built to settle
 * — *is she running today's code?* — was the one it could not settle. Found
 * on 2026-08-04, while trying to establish whether a phone reporting a drill
 * failure was running the fix for it.
 *
 * Never throws. A build stamp is a diagnostic aid; failing the build because
 * it could not be computed would trade a small unknown for a total one.
 */
export function readBuildSha(
  env: Record<string, string | undefined>,
  runGit: () => string,
): string {
  const injected = env.RENDER_GIT_COMMIT?.trim()
  // Short form deliberately: it is read out over the phone, and `git log`
  // resolves seven characters as readily as forty.
  if (injected) return injected.slice(0, 7)
  try {
    return runGit().trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}
