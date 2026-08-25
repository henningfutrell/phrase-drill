import type { ReactNode } from 'react'

/**
 * The slice of React's `Root` this module needs — its own minimal shape, in
 * the house style of `AudioElementLike`/`RouteHoldElementLike`, so a test can
 * supply a fake without a DOM or a real React root.
 */
export interface ReactRootLike {
  render(children: ReactNode): void
}

/**
 * Owns the app's single React root.
 *
 * `main.tsx` renders more than once: at boot, and again from `showApp()` /
 * `showLogin()` whenever the auth state changes. `showLogin` is wired to
 * `createSessionAuth({ onUnauthorized: ... })`, so **any 401 from any
 * `/api/*` call re-renders the app**. That path is not rare — a session
 * token expires while the user is mid-Drill in the car.
 *
 * Calling `createRoot` per render, as this did, calls it a second time on a
 * container that already has a root. On React 19 the new root renders over
 * the container and the displaced tree is **never unmounted**, so its effect
 * cleanups never run: a running `DrillPlayer` keeps playing, its Wake Lock is
 * never released, and no control in the app can reach either any more.
 *
 * So the root is constructed at most once, lazily, and every later render
 * goes through that same root — which unmounts the previous tree properly and
 * runs its cleanups.
 */
export function createRootRenderer(
  container: Element,
  createRootImpl: (container: Element) => ReactRootLike,
): (children: ReactNode) => void {
  let root: ReactRootLike | undefined
  return (children) => {
    root ??= createRootImpl(container)
    root.render(children)
  }
}
