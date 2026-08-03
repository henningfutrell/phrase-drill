// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createBoundedQueue } from './bounded-queue.js'

function deferred() {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}

describe('createBoundedQueue', () => {
  it('never runs more than `concurrency` tasks at once', async () => {
    const queue = createBoundedQueue({ concurrency: 2 })
    let active = 0
    let maxActive = 0
    const gates = [deferred(), deferred(), deferred(), deferred(), deferred()]

    const runs = gates.map((gate, i) =>
      queue.run(async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await gate.promise
        active--
        return i
      }),
    )

    // Let the first `concurrency` tasks start.
    await Promise.resolve()
    await Promise.resolve()
    expect(maxActive).toBe(2)

    gates[0].resolve()
    gates[1].resolve()
    await Promise.resolve()
    await Promise.resolve()
    gates[2].resolve()
    gates[3].resolve()
    gates[4].resolve()

    const results = await Promise.all(runs)
    expect(results).toEqual([0, 1, 2, 3, 4])
    expect(maxActive).toBe(2)
  })

  it('propagates a task rejection to its own caller only', async () => {
    const queue = createBoundedQueue({ concurrency: 1 })
    const failing = queue.run(() => Promise.reject(new Error('boom')))
    const succeeding = queue.run(() => Promise.resolve('ok'))

    await expect(failing).rejects.toThrow('boom')
    await expect(succeeding).resolves.toBe('ok')
  })
})
