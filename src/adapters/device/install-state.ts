/**
 * Whether this app is running as an installed app, and on what.
 *
 * Neither browser that matters will offer installation on its own. iOS Safari
 * has never implemented `beforeinstallprompt` and there is no API to trigger
 * the Share-sheet flow. Chrome removed its automatic mini-infobar and now hides
 * installation behind an omnibox icon or a menu item. So the app has to say it
 * itself, and it has to know when to stop saying it.
 *
 * This matters more than tidiness: a Home Screen web app on iOS keeps its own
 * counter of days of use and escapes Safari's 7-day wipe of script-writable
 * storage. Uninstalled, her whole library is deleted after a fortnight of not
 * drilling, silently. Installed, it is not.
 */
export type InstallPlatform = 'ios' | 'other'

export interface InstallState {
  readonly platform: InstallPlatform
  /** True when already running standalone — the banner must not appear. */
  readonly installed: boolean
}

export interface InstallStateInput {
  readonly userAgent: string
  /** `navigator.standalone` — iOS only, `undefined` everywhere else. */
  readonly iosStandalone: boolean | undefined
  /** `matchMedia('(display-mode: standalone)').matches`. */
  readonly displayModeStandalone: boolean
  /** `navigator.maxTouchPoints`; iPadOS reports a Mac user-agent and is caught by this. */
  readonly maxTouchPoints?: number
}

export function readInstallState(input: InstallStateInput): InstallState {
  const isIPhoneOrIPod = /iPhone|iPod/.test(input.userAgent)
  // iPadOS 13+ reports the desktop Safari user-agent verbatim. Touch points is
  // the only reliable tell left, and Apple is unlikely to shrink it back.
  const isIPadPretendingToBeAMac =
    /Macintosh/.test(input.userAgent) && (input.maxTouchPoints ?? 0) > 1
  const isIPad = /iPad/.test(input.userAgent) || isIPadPretendingToBeAMac

  return {
    platform: isIPhoneOrIPod || isIPad ? 'ios' : 'other',
    installed: input.iosStandalone === true || input.displayModeStandalone,
  }
}

/** Reads the live browser. Split from `readInstallState` so the logic is testable without a DOM. */
export function readInstallStateFromBrowser(): InstallState {
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean }
  return readInstallState({
    userAgent: navigator.userAgent,
    iosStandalone: navigatorWithStandalone.standalone,
    displayModeStandalone:
      typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches,
    maxTouchPoints: navigator.maxTouchPoints,
  })
}
