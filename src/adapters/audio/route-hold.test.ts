import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ROUTE_HOLD_WATCHDOG_MS,
  createRouteHold,
  createRouteHoldWav,
  type RouteHoldElementLike,
} from './route-hold'

/**
 * The Route hold's source, read as bytes. Same "trust the bytes, not the
 * intent" style as `clip-player.test.ts`'s unlock-source test, which caught
 * a shipped WAV whose `WAVE` tag sat at offset 9 — but stricter: that test
 * never looked inside the fmt block, and this format's whole point (16-bit
 * signed, 44.1 kHz, never digitally silent) lives there and in the samples.
 */
describe('createRouteHoldWav — the keepalive source, byte by byte', () => {
  const bytes = createRouteHoldWav()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))

  it('carries the four RIFF/WAVE tags at their fixed offsets', () => {
    expect(ascii(0, 4)).toBe('RIFF')
    expect(ascii(8, 12)).toBe('WAVE')
    expect(ascii(12, 16)).toBe('fmt ')
    expect(ascii(36, 40)).toBe('data')
  })

  it('derives both size fields from the buffer it actually produced, never from an intended length', () => {
    expect(view.getUint32(4, true)).toBe(bytes.length - 8)
    expect(view.getUint32(40, true)).toBe(bytes.length - 44)
  })

  it('declares PCM, mono, 44.1 kHz, 16-bit — the format the Clips are already in', () => {
    expect(view.getUint32(16, true)).toBe(16) // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1) // WAVE_FORMAT_PCM
    expect(view.getUint16(22, true)).toBe(1) // channels
    expect(view.getUint32(24, true)).toBe(44100)
    expect(view.getUint16(34, true)).toBe(16) // bits per sample
  })

  it('derives byteRate and blockAlign from rate/channels/bits, so a rate edit cannot leave them stale', () => {
    const channels = view.getUint16(22, true)
    const sampleRate = view.getUint32(24, true)
    const bitsPerSample = view.getUint16(34, true)
    const bytesPerFrame = (bitsPerSample / 8) * channels

    expect(view.getUint32(28, true)).toBe(sampleRate * bytesPerFrame)
    expect(view.getUint16(32, true)).toBe(bytesPerFrame)
  })

  it('is exactly one second long — 44100 mono 16-bit frames behind a 44-byte header', () => {
    expect(bytes.length).toBe(44 + 44100 * 2)
  })

  it('is never digitally silent: every frame is +1 or -1, and no frame is 0', () => {
    let zeroes = 0
    let outOfRange = 0
    for (let offset = 44; offset < bytes.length; offset += 2) {
      const sample = view.getInt16(offset, true)
      if (sample === 0) zeroes += 1
      else if (sample !== 1 && sample !== -1) outOfRange += 1
    }

    expect(zeroes).toBe(0)
    expect(outOfRange).toBe(0)
  })

  it('flips polarity exactly ten times a second — a 5 Hz square, not a per-sample one sitting on Nyquist', () => {
    const frames = (bytes.length - 44) / 2
    const sampleAt = (frame: number) => view.getInt16(44 + frame * 2, true)

    let flips = 0
    for (let frame = 1; frame < frames; frame += 1) {
      if (sampleAt(frame) !== sampleAt(frame - 1)) flips += 1
    }
    // The loop wrap is a flip too: the buffer plays end-to-start forever.
    if (sampleAt(0) !== sampleAt(frames - 1)) flips += 1

    expect(flips).toBe(10)
  })
})

// `currentTime` is read-only on the port — the hold observes the media clock,
// it never seeks. A fake has to drive it, so it is widened here and nowhere
// else.
interface FakeRouteHoldElement extends Omit<RouteHoldElementLike, 'currentTime'> {
  currentTime: number
  playCalls: number
  pauseCalls: number
  /** Every write to a property the Route hold must never touch. */
  forbiddenWrites: string[]
  listenerCount(): number
  emitTimeUpdate(): void
}

function fakeElement(play: () => Promise<void> = () => Promise.resolve()): FakeRouteHoldElement {
  const listeners: (() => void)[] = []
  const forbiddenWrites: string[] = []

  const element: FakeRouteHoldElement = {
    src: '',
    loop: false,
    currentTime: 0,
    playCalls: 0,
    pauseCalls: 0,
    forbiddenWrites,
    play() {
      element.playCalls += 1
      return play()
    },
    pause() {
      element.pauseCalls += 1
    },
    addEventListener(_type: 'timeupdate', listener: () => void) {
      listeners.push(listener)
    },
    removeEventListener(_type: 'timeupdate', listener: () => void) {
      const index = listeners.indexOf(listener)
      if (index >= 0) listeners.splice(index, 1)
    },
    listenerCount: () => listeners.length,
    emitTimeUpdate: () => {
      for (const listener of [...listeners]) listener()
    },
  }

  // `muted` and `volume` are not on RouteHoldElementLike, so TypeScript
  // already refuses them — these record a write at runtime too, because the
  // reason they are forbidden is a device fact (a muted element holds no
  // route; iOS ignores media `volume`), not a typing convenience.
  for (const forbidden of ['muted', 'volume']) {
    Object.defineProperty(element, forbidden, {
      configurable: true,
      get: () => undefined,
      set: () => forbiddenWrites.push(forbidden),
    })
  }

  return element
}

/** Lets a rejecting `play()` be resolved to a real DOMException-shaped error. */
function domException(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

describe('createRouteHold — holding the output route', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('gives the element its source at construction, not inside the tap', () => {
    const element = fakeElement()
    createRouteHold({ element })

    expect(element.src).not.toBe('')
    expect(element.playCalls).toBe(0)
  })

  it('loops and plays on hold, and pauses on release', async () => {
    const element = fakeElement()
    const hold = createRouteHold({ element })

    hold.hold()
    await vi.advanceTimersByTimeAsync(0)

    expect(element.loop).toBe(true)
    expect(element.playCalls).toBe(1)
    expect(element.pauseCalls).toBe(0)

    hold.release()
    expect(element.pauseCalls).toBe(1)
  })

  it('never writes muted and never writes volume — the amplitude lives in the samples', async () => {
    const element = fakeElement()
    const hold = createRouteHold({ element })

    hold.hold()
    await vi.advanceTimersByTimeAsync(0)
    hold.release()

    expect(element.forbiddenWrites).toEqual([])
  })

  it('plays once when a second hold arrives while already holding', async () => {
    const element = fakeElement()
    const hold = createRouteHold({ element })

    hold.hold()
    hold.hold()
    await vi.advanceTimersByTimeAsync(0)

    expect(element.playCalls).toBe(1)
    expect(hold.stats().starts).toBe(1)
  })

  it('counts a re-hold after a release as a second start — the Resume tap', async () => {
    const element = fakeElement()
    const hold = createRouteHold({ element })

    hold.hold()
    await vi.advanceTimersByTimeAsync(0)
    hold.release()
    hold.hold()
    await vi.advanceTimersByTimeAsync(0)

    expect(element.playCalls).toBe(2)
    expect(hold.stats().starts).toBe(2)
  })

  it('stops listening for timeupdate once released', async () => {
    const element = fakeElement()
    const hold = createRouteHold({ element })

    hold.hold()
    await vi.advanceTimersByTimeAsync(0)
    expect(element.listenerCount()).toBe(1)

    hold.release()
    expect(element.listenerCount()).toBe(0)
  })

  it('reports advancedMs 0 when currentTime never moves — the refutation signal', async () => {
    const element = fakeElement()
    const hold = createRouteHold({ element })

    hold.hold()
    await vi.advanceTimersByTimeAsync(0)
    element.emitTimeUpdate()
    element.emitTimeUpdate()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(hold.stats().advancedMs).toBe(0)
    expect(hold.stats().totalHeldMs).toBeGreaterThanOrEqual(10_000)
  })

  it('accumulates forward currentTime deltas, and ignores the backward jump of a loop wrap', async () => {
    const element = fakeElement()
    const hold = createRouteHold({ element })

    hold.hold()
    await vi.advanceTimersByTimeAsync(0)

    element.currentTime = 0.25
    element.emitTimeUpdate()
    element.currentTime = 0.75
    element.emitTimeUpdate()
    // The 1 s source wrapped: currentTime falls back to the head. That is not
    // −750 ms of playback, it is the loop doing its job.
    element.currentTime = 0.1
    element.emitTimeUpdate()
    element.currentTime = 0.6
    element.emitTimeUpdate()

    expect(hold.stats().advancedMs).toBeCloseTo(1250, 6)
  })

  it('reports a rejecting play() exactly once, carrying the DOMException name', async () => {
    const failures: string[] = []
    const element = fakeElement(() =>
      Promise.reject(domException('NotAllowedError', 'The request is not allowed by the user agent.')),
    )
    const hold = createRouteHold({ element, onSilentFailure: (message) => failures.push(message) })

    hold.hold()
    await vi.advanceTimersByTimeAsync(0)

    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('NotAllowedError')
    expect(hold.stats().playResolved).toBe(false)
    expect(hold.stats().lastError).toEqual({
      name: 'NotAllowedError',
      message: 'The request is not allowed by the user agent.',
    })
  })

  it('does not repeat the same standing play() failure into a 50-entry ring buffer', async () => {
    const failures: string[] = []
    const element = fakeElement(() => Promise.reject(domException('NotAllowedError', 'refused')))
    const hold = createRouteHold({ element, onSilentFailure: (message) => failures.push(message) })

    hold.hold()
    await vi.advanceTimersByTimeAsync(0)
    hold.release()
    hold.hold()
    await vi.advanceTimersByTimeAsync(0)
    hold.release()

    expect(failures).toHaveLength(1)
  })

  it('records playResolved true and clears the error once a play() finally succeeds', async () => {
    const element = fakeElement()
    const hold = createRouteHold({ element })

    expect(hold.stats().playResolved).toBeNull()

    hold.hold()
    await vi.advanceTimersByTimeAsync(0)

    expect(hold.stats().playResolved).toBe(true)
    expect(hold.stats().lastError).toBeUndefined()
  })

  it('reports a hold whose media clock barely moved — the number that refutes the whole mechanism', async () => {
    const failures: string[] = []
    const element = fakeElement()
    const hold = createRouteHold({ element, onSilentFailure: (message) => failures.push(message) })

    hold.hold()
    await vi.advanceTimersByTimeAsync(600_000)
    hold.release()

    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('not actually playing')
  })

  it('says nothing about a hold whose media clock kept up', async () => {
    const failures: string[] = []
    const element = fakeElement()
    const hold = createRouteHold({ element, onSilentFailure: (message) => failures.push(message) })

    hold.hold()
    await vi.advanceTimersByTimeAsync(0)
    for (let second = 1; second <= 600; second += 1) {
      element.currentTime = 0.5
      element.emitTimeUpdate()
      element.currentTime = 1
      element.emitTimeUpdate()
      element.currentTime = 0
      await vi.advanceTimersByTimeAsync(1000)
    }
    hold.release()

    expect(failures).toEqual([])
  })

  it('stops a hold that outlived its Drill, and says so — the unreleasable-hold mitigation', async () => {
    const failures: string[] = []
    const element = fakeElement()
    const hold = createRouteHold({ element, onSilentFailure: (message) => failures.push(message) })

    hold.hold()
    await vi.advanceTimersByTimeAsync(ROUTE_HOLD_WATCHDOG_MS - 1)
    expect(hold.stats().watchdogFired).toBe(false)
    expect(element.pauseCalls).toBe(0)

    await vi.advanceTimersByTimeAsync(1)

    expect(hold.stats().watchdogFired).toBe(true)
    expect(element.pauseCalls).toBe(1)
    expect(element.listenerCount()).toBe(0)
    expect(failures.some((message) => message.includes('watchdog'))).toBe(true)
  })

  it('bounds a Drill at ninety minutes — long enough for the longest real one, short enough to matter', () => {
    expect(ROUTE_HOLD_WATCHDOG_MS).toBe(90 * 60 * 1000)
  })

  it('does not fire the watchdog for a hold that was released in time', async () => {
    const element = fakeElement()
    const hold = createRouteHold({ element })

    hold.hold()
    await vi.advanceTimersByTimeAsync(60_000)
    hold.release()
    await vi.advanceTimersByTimeAsync(ROUTE_HOLD_WATCHDOG_MS * 2)

    expect(hold.stats().watchdogFired).toBe(false)
    expect(element.pauseCalls).toBe(1)
  })

  it('is inert on a release that was never a hold', () => {
    const element = fakeElement()
    const hold = createRouteHold({ element })

    hold.release()

    expect(element.pauseCalls).toBe(0)
    expect(hold.stats()).toMatchObject({ starts: 0, totalHeldMs: 0, advancedMs: 0 })
  })
})
