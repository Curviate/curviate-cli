/**
 * Build the bin once, before any worker starts.
 *
 * Several suites spawn `dist/cli.js` as a child process. Building from inside a
 * suite's `beforeAll` races the workers that vitest runs in parallel: one
 * rebuilds `dist/` while another is mid-spawn, and that one dies with
 * MODULE_NOT_FOUND for reasons that have nothing to do with what it asserts.
 *
 * A global setup runs once, to completion, before any of them exist.
 */

import { ensureFreshBuild } from "./helpers/built-cli.js";

export default function setup(): void {
  ensureFreshBuild();
}
