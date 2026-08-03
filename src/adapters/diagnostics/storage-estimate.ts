/** Honest outcome of asking the browser how much storage this origin uses —
 * mirrors `persistence.ts`'s "report the real outcome, never claim what you
 * didn't get" pattern. Never a fabricated zero when the browser can't say. */
export type StorageEstimateResult =
  | { supported: true; usageBytes: number; quotaBytes: number }
  | { supported: false }

/**
 * Reads `navigator.storage.estimate()`. `storage` is injectable (defaults to
 * `globalThis.navigator?.storage`) the same way `persistence.ts` injects the
 * browser API, so this is testable without a real browser.
 */
export async function getStorageEstimate(
  storage: StorageManager | undefined = globalThis.navigator?.storage,
): Promise<StorageEstimateResult> {
  if (!storage?.estimate) return { supported: false }
  try {
    const { usage, quota } = await storage.estimate()
    if (usage === undefined || quota === undefined) return { supported: false }
    return { supported: true, usageBytes: usage, quotaBytes: quota }
  } catch {
    return { supported: false }
  }
}
