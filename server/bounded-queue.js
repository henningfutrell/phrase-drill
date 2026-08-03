/**
 * Bounds how many async tasks run at once, queuing the rest — the
 * concurrency limiter `docs/scale.md` names as missing (the device used to
 * fire 2n simultaneous ElevenLabs calls with no bound at all). Every
 * outbound call to a paid upstream API goes through one of these, shared
 * across every inbound request, so the device's own unthrottled fan-out
 * (still true today, but now aimed at this server instead of ElevenLabs
 * directly) cannot turn into an unbounded fan-out against the paid API.
 */
export function createBoundedQueue({ concurrency }) {
  let active = 0
  const waiting = []

  function drain() {
    while (active < concurrency && waiting.length > 0) {
      const item = waiting.shift()
      active++
      item
        .fn()
        .then(
          (value) => {
            active--
            item.resolve(value)
            drain()
          },
          (err) => {
            active--
            item.reject(err)
            drain()
          },
        )
    }
  }

  return {
    run(fn) {
      return new Promise((resolve, reject) => {
        waiting.push({ fn, resolve, reject })
        drain()
      })
    },
  }
}
