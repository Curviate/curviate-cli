/**
 * `job get` / `recruiter job get` flag-hygiene — built-dist `--help` capture.
 *
 * The source-level args-object check (recruiter-sales-nav-flags.test.ts,
 * job.test.ts) proves the citty command definition itself has no pagination
 * flags. This file additionally spawns the BUILT bin (dist/cli.js) and
 * captures the real rendered `--help` text, since that is what a caller
 * actually sees on the terminal — a citty rendering regression would not be
 * caught by inspecting the source args object alone.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { spawnSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { SPAWN_TIMEOUT_MS, spawnTestTimeout } from "../helpers/spawn-budget.js";

// Vitest's default (5s) is shorter than the spawn's own timeout below (see spawn-budget.ts).
vi.setConfig({ testTimeout: spawnTestTimeout() });

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "../..");
const cliPath = resolve(pkgRoot, "dist", "cli.js");

function helpText(args: string[]): string {
  const r = spawnSync(process.execPath, [cliPath, ...args, "--help"], {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...process.env, NODE_ENV: "production", TEST: "false", CI: "false", CURVIATE_API_KEY: "rdc_live_help_test_stub" },
  });
  return (r.stdout ?? "") + (r.stderr ?? "");
}

const PAGINATION_ONLY_FLAGS = ["--limit", "--cursor", "--all", "--max-pages"];

describe("job get / recruiter job get --help (built dist) — no pagination flags", () => {
  beforeAll(() => {
    if (!existsSync(cliPath)) {
      execSync("node_modules/.bin/tsup", { cwd: pkgRoot, stdio: "ignore" });
    }
  });

  it("curviate job get --help excludes --limit/--cursor/--all/--max-pages, keeps --fields and --verbose", () => {
    const text = helpText(["job", "get"]);
    for (const flag of PAGINATION_ONLY_FLAGS) {
      expect(text, `job get --help must not mention ${flag}`).not.toContain(flag);
    }
    expect(text).toContain("--fields");
    expect(text).toContain("--verbose");
  });

  it("curviate recruiter job get --help excludes --limit/--cursor/--all/--max-pages, keeps --fields and --verbose", () => {
    const text = helpText(["recruiter", "job", "get"]);
    for (const flag of PAGINATION_ONLY_FLAGS) {
      expect(text, `recruiter job get --help must not mention ${flag}`).not.toContain(flag);
    }
    expect(text).toContain("--fields");
    expect(text).toContain("--verbose");
  });

  it("negative control: curviate recruiter job applicants --help still has --limit/--cursor/--all (a genuine list command)", () => {
    const text = helpText(["recruiter", "job", "applicants"]);
    // job applicants is a list read — it must retain pagination flags per the
    // existing shared GLOBAL_FLAGS definition (confirms this test file's
    // spawn-and-capture technique isn't just always green).
    expect(text).toContain("--limit");
    expect(text).toContain("--cursor");
    expect(text).toContain("--all");
  });
});
