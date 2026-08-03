import { describe, expect, it } from 'vitest'
import { readInstallState } from './install-state'

/**
 * iOS Safari does not implement `beforeinstallprompt` and never will — there is
 * no way to ask the OS to offer "Add to Home Screen". The app has to say it
 * itself, and it only matters on iOS: a Home Screen web app keeps its own
 * counter of days of use and escapes Safari's 7-day script-writable-storage
 * wipe, which is the difference between her library surviving a fortnight of
 * not drilling and being deleted with no warning.
 */
describe('readInstallState', () => {
  const iphone =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
  const desktop =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

  it('is installed when the iOS standalone flag is set', () => {
    expect(readInstallState({ userAgent: iphone, iosStandalone: true, displayModeStandalone: false }))
      .toEqual({ platform: 'ios', installed: true })
  })

  it('is installed when the display-mode media query matches, whatever the platform', () => {
    expect(readInstallState({ userAgent: desktop, iosStandalone: undefined, displayModeStandalone: true }))
      .toEqual({ platform: 'other', installed: true })
  })

  it('reports an uninstalled iPhone — the only case that needs instructions', () => {
    expect(readInstallState({ userAgent: iphone, iosStandalone: false, displayModeStandalone: false }))
      .toEqual({ platform: 'ios', installed: false })
  })

  it('does not mistake a desktop browser for an iPhone', () => {
    expect(readInstallState({ userAgent: desktop, iosStandalone: undefined, displayModeStandalone: false }))
      .toEqual({ platform: 'other', installed: false })
  })

  it('treats an iPad reporting as a Mac by its touch points, since iPadOS lies about its UA', () => {
    const ipadOS =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
    expect(readInstallState({ userAgent: ipadOS, iosStandalone: false, displayModeStandalone: false, maxTouchPoints: 5 }))
      .toEqual({ platform: 'ios', installed: false })
  })
})
