/**
 * Graceful shutdown on a signal (T088).
 *
 * **Why this exists.** Render sends SIGTERM to the container on every deploy
 * and every restart, then SIGKILLs what is left after its grace period. Node's
 * default action for SIGTERM is to end the process immediately, so before this
 * a deploy cut every connection open at that instant — including a
 * `PUT /api/library` carrying phrases the device has not yet had acknowledged.
 * The device retries a failed push, so the phrases are not lost; what a drain
 * buys is that the ordinary case does not have to rely on the retry path
 * working, and that the push she is watching finishes instead of showing
 * "waiting" until the next sync trigger.
 *
 * **The order matters.** `server.close()` stops accepting NEW connections and
 * waits for the in-flight ones, so the pool is ended only once no request can
 * still need it. `closeIdleConnections()` is what makes that terminate: HTTP
 * keep-alive sockets with no request on them hold `close` open indefinitely
 * otherwise, and an idle socket has nothing to drain.
 *
 * **The deadline is the backstop, not the plan.** A request that will not
 * finish (a hung provider call) must not keep the process alive until the
 * platform SIGKILLs it, because SIGKILL is exactly the abrupt end this is
 * avoiding. At the deadline the remaining sockets are forced shut and the
 * process exits non-zero, which is at least a shutdown this code chose.
 *
 * Signals arrive more than once (a deploy that is retried, SIGTERM then
 * SIGINT), so this runs once and every later call awaits the same drain.
 */
export function createShutdown({ server, pool, logger, timeoutMs = SHUTDOWN_TIMEOUT_MS, exit = defaultExit }) {
  let running = null

  return function shutdown(signal) {
    running ??= drain(signal)
    return running
  }

  async function drain(signal) {
    logger.info('shutting down', { signal })

    const deadline = setTimeout(() => {
      logger.error('shutdown timed out — forcing the remaining connections shut', { timeoutMs })
      server.closeAllConnections()
      exit(1)
    }, timeoutMs)
    // An unref'd timer never keeps the loop alive on its own: if the drain
    // finishes first, the process exits when it is ready, not at the deadline.
    deadline.unref?.()

    try {
      await new Promise((resolve) => {
        server.close(() => resolve())
        server.closeIdleConnections()
      })
      await pool.end()
      logger.info('shutdown complete', { signal })
    } catch (err) {
      // Nothing here is worth failing the shutdown over — the connections are
      // already closed and the process is on its way out either way. Say what
      // happened and let it end.
      logger.error('shutdown did not complete cleanly', { error: err instanceof Error ? err.message : String(err) })
    } finally {
      clearTimeout(deadline)
    }
  }
}

/**
 * Render's default grace period before SIGKILL is 30 s; this sits well inside
 * it so the forced close is ours and not the platform's.
 */
export const SHUTDOWN_TIMEOUT_MS = 10_000

function defaultExit(code) {
  process.exit(code)
}
