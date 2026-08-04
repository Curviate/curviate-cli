import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Builds dist/cli.js once before any worker starts, so the suites that
    // spawn the real bin never race each other rebuilding it, and never assert
    // against an artifact older than the source they are meant to cover.
    globalSetup: ["test/global-setup.ts"],
    // RAM GUARDRAIL: vitest defaults to one fork PER CPU CORE, which on a
    // 12-core development host allocates twelve Node processes before a single
    // test runs. That default exhausted memory and took a workstation down
    // twice, so the fork count is capped here rather than left to the machine.
    // This suite also spawns the real built binary as a child process per test,
    // on top of the forks, so the cap matters even more here than it does for a
    // pure in-process suite.
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
