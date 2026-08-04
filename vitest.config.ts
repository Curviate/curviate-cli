import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Builds dist/cli.js once before any worker starts, so the suites that
    // spawn the real bin never race each other rebuilding it, and never assert
    // against an artifact older than the source they are meant to cover.
    globalSetup: ["test/global-setup.ts"],
    // RAM GUARDRAIL (issue #162 incident, 2026-06-06; this config capped 2026-08-04
    // after a second host-crash incident traced to it): vitest defaults to one fork
    // PER CPU CORE (12 on this host). Mirrors apps/server/vitest.config.ts's cap
    // exactly. See that file for the full incident writeup and RAM sweep data. This
    // suite also spawns the real built binary as a child process per test, on top of
    // the forks, so the cap matters even more here.
    // Override via VITEST_MAX_WORKERS. NEVER raise above a value re-measured safe
    // on this host.
    pool: "forks",
    maxWorkers: Number(process.env["VITEST_MAX_WORKERS"] ?? 2),
    minWorkers: 1,
    poolOptions: {
      forks: {
        maxForks: Number(process.env["VITEST_MAX_WORKERS"] ?? 2),
        minForks: 1,
      },
    },
  },
});
