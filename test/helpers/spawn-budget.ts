/**
 * Shared timeout budget for tests that spawn the built dist bin (or another
 * child process) and give that child an explicit kill-`timeout` larger than
 * vitest's own default `testTimeout` (5000ms).
 *
 * That combination is a defect shape, not a coincidence: a `spawnSync`/
 * `execFile` `timeout` option is only a ceiling for a HUNG child. It does
 * nothing to protect a slow-but-healthy run — under load, a cold `node
 * dist/cli.js` start can itself eat several seconds. `spawnSync` blocks the
 * event loop, so vitest cannot preempt it either way: when the synchronous
 * call finally returns (whether the child finished or was killed at its own
 * `timeout`), vitest's already-expired 5s timer fires on the very next tick
 * and reports "Test timed out in 5000ms" — hiding whatever the test actually
 * meant to assert. The per-test (or per-file) timeout must always exceed the
 * child's own kill budget, with margin for scheduling jitter, or the ceiling
 * a test author deliberately chose can never be reached.
 */

/** The `timeout` option most dist-bin-spawning tests give `spawnSync`/`execFile`. */
export const SPAWN_TIMEOUT_MS = 15_000;

const MARGIN_MS = 5_000;

/**
 * Vitest test/describe/file timeout that leaves room for `spawnsPerTest`
 * sequential spawns, each budgeted at `spawnTimeoutMs`, to actually run out
 * their budget and still report, rather than vitest declaring the TEST timed
 * out first. Pass `spawnsPerTest` > 1 for a body that awaits more than one
 * real spawn in sequence — a shared per-file budget must cover its WORST
 * test, not just the common one-spawn case, or the same mismatch this file
 * exists to fix survives on exactly the tests most likely to run long.
 */
export function spawnTestTimeout(spawnTimeoutMs: number = SPAWN_TIMEOUT_MS, spawnsPerTest = 1): number {
  return spawnTimeoutMs * spawnsPerTest + MARGIN_MS;
}
