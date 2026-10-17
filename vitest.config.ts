import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // RAM GUARDRAIL: vitest defaults to one fork PER CPU CORE, which on a
    // 12-core development host allocates twelve Node processes before a single
    // test runs. That default exhausted memory and took a workstation down
    // twice, so the fork count is capped here rather than left to the machine.
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
