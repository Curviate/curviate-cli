/**
 * Adaptive poll cadence for mobile-app-approval checkpoints, shared by the
 * interactive `link` / `reconnect` guided loop's mobile-approval wait and
 * the checkpoint poll wait loop.
 *
 * Keep in sync with the dashboard's poll-cadence constants (component name
 * only, not a path or a spec reference): a prompt first poll, then a fast
 * interval for the first window (the window in which most phone approvals
 * land), then a slower interval for the remainder of the checkpoint TTL,
 * this bounds substrate request volume without adding perceptible lag to
 * the common case.
 */

export const CHECKPOINT_POLL_FIRST_DELAY_MS = 1000;
export const CHECKPOINT_POLL_FAST_INTERVAL_MS = 1500;
export const CHECKPOINT_POLL_FAST_WINDOW_MS = 30_000;
export const CHECKPOINT_POLL_SLOW_INTERVAL_MS = 3000;

/** The delay before the next poll, given elapsed time since the wait loop started. */
export function nextCheckpointPollDelayMs(elapsedMs: number): number {
  return elapsedMs < CHECKPOINT_POLL_FAST_WINDOW_MS
    ? CHECKPOINT_POLL_FAST_INTERVAL_MS
    : CHECKPOINT_POLL_SLOW_INTERVAL_MS;
}
