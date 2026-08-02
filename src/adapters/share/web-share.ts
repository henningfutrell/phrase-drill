/**
 * The Web Share API (Level 2, file sharing) seam — the one place that
 * touches `navigator.share`/`navigator.canShare`. This is what gets the
 * exported backup into the iOS share sheet (Files, AirDrop, Messages)
 * instead of a desktop-style download that lands invisibly in Downloads
 * (docs/design.md §3.6).
 *
 * iOS Safari has supported Level 2 file sharing since iOS 15, but support
 * is not guaranteed (older iOS, in-app browsers, a permissions-policy
 * block) — every caller must treat 'unsupported' as an expected outcome
 * and fall back to a plain download, not an error. Not verified against a
 * real device in this change (see T016 report); the `canShare` guard plus
 * a caught `share()` rejection is the defensive posture for that gap.
 */

export type ShareOutcome = 'shared' | 'cancelled' | 'unsupported'

/** The slice of `Navigator` this adapter needs — injectable so it is
 * testable without a browser that actually implements Web Share. */
export interface ShareCapableNavigator {
  canShare?(data: { files?: File[] }): boolean
  share?(data: { files?: File[] }): Promise<void>
}

export async function shareBackupFile(
  file: File,
  nav: ShareCapableNavigator | undefined = globalThis.navigator as unknown as ShareCapableNavigator,
): Promise<ShareOutcome> {
  if (typeof nav?.canShare !== 'function' || typeof nav.share !== 'function') {
    return 'unsupported'
  }
  if (!nav.canShare({ files: [file] })) {
    return 'unsupported'
  }

  try {
    await nav.share({ files: [file] })
    return 'shared'
  } catch (error) {
    // AbortError is the person dismissing the share sheet — expected, not a
    // fault. Any other rejection (permissions policy, lost user-activation
    // after the async exportAll() read, a genuine platform refusal) falls
    // back the same way 'unsupported' does: this adapter never throws.
    if (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError') {
      return 'cancelled'
    }
    return 'unsupported'
  }
}
