/**
 * `sales-nav` v2 list-surface cascade — built-dist routing + `--help` checks.
 *
 * The unit tests (sales-nav-v2.test.ts) call the exported run functions
 * directly and prove the source-level args object has/lacks the right flags.
 * This file additionally spawns the BUILT bin (dist/cli.js) to prove the
 * router actually dispatches the five new subcommands (not "Unknown
 * command") and that citty renders the expected `--help` text — a
 * registration or rendering regression would not be caught by the unit
 * tests alone. Mirrors test/commands/job-help.test.ts and test/routing.test.ts.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { spawnSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { SPAWN_TIMEOUT_MS, spawnTestTimeout } from "../helpers/spawn-budget.js";

// Every `it` below spawns the built bin with an inner budget of
// SPAWN_TIMEOUT_MS; vitest's own default (5s) is shorter than that, so a
// slow-but-healthy cold start under load reports "Test timed out in 5000ms"
// instead of the spawn ever getting to use its budget (see spawn-budget.ts).
vi.setConfig({ testTimeout: spawnTestTimeout() });

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "../..");
const cliPath = resolve(pkgRoot, "dist", "cli.js");

// A syntactically-valid but unroutable base URL: connections are refused
// immediately, so the SDK surfaces a network error fast (no long timeout).
const UNROUTABLE = "http://127.0.0.1:1";

function run(args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...process.env, NODE_ENV: "production", TEST: "false", CI: "false", CURVIATE_API_KEY: "rdc_live_sn_v2_dist_test_stub" },
  });
}

function helpText(args: string[]): string {
  const r = run([...args, "--help"]);
  return (r.stdout ?? "") + (r.stderr ?? "");
}

function combined(r: ReturnType<typeof run>): string {
  return (r.stdout ?? "") + (r.stderr ?? "");
}

function isUnknownCommand(r: ReturnType<typeof run>): boolean {
  return /Unknown command/i.test(combined(r));
}

const PAGINATION_ONLY_FLAGS = ["--limit", "--cursor", "--all", "--max-pages"];

beforeAll(() => {
  // Build once if missing — do not rebuild if dist is already current
  // (no double-run; the SDK/CLI edits in this branch already ran `pnpm build`).
  if (!existsSync(cliPath)) {
    execSync("node_modules/.bin/tsup", { cwd: pkgRoot, stdio: "ignore" });
  }
});

describe("sales-nav v2 — router reaches the five new subcommands (not 'Unknown command')", () => {
  it("sales-nav account-lists --account acc_x reaches the SDK path", () => {
    const r = run(["sales-nav", "account-lists", "--account", "acc_x", "--base-url", UNROUTABLE, "--json"]);
    expect(isUnknownCommand(r)).toBe(false);
    expect(r.status).toBe(7);
    expect(r.stdout).toMatch(/"error"/);
  });

  it("sales-nav lead-lists --account acc_x reaches the SDK path", () => {
    const r = run(["sales-nav", "lead-lists", "--account", "acc_x", "--base-url", UNROUTABLE, "--json"]);
    expect(isUnknownCommand(r)).toBe(false);
    expect(r.status).toBe(7);
    expect(r.stdout).toMatch(/"error"/);
  });

  it("sales-nav browse-account-list L1 --account acc_x reaches the SDK path", () => {
    const r = run(["sales-nav", "browse-account-list", "L1", "--account", "acc_x", "--base-url", UNROUTABLE, "--json"]);
    expect(isUnknownCommand(r)).toBe(false);
    expect(r.status).toBe(7);
    expect(r.stdout).toMatch(/"error"/);
  });

  it("sales-nav browse-lead-list L2 --account acc_x reaches the SDK path", () => {
    const r = run(["sales-nav", "browse-lead-list", "L2", "--account", "acc_x", "--base-url", UNROUTABLE, "--json"]);
    expect(isUnknownCommand(r)).toBe(false);
    expect(r.status).toBe(7);
    expect(r.stdout).toMatch(/"error"/);
  });

  it("sales-nav save-account --list L1 123 --account acc_x --preview renders ONLY salesNavigator.saveAccount, exits 0", () => {
    const r = run(["sales-nav", "save-account", "--list", "L1", "123", "--account", "acc_x", "--preview"]);
    expect(isUnknownCommand(r)).toBe(false);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("salesNavigator.saveAccount");
    // Exactly one preview render line (no stray second method / double-run).
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
  });

  it("sales-nav save-lead --list L2 ACw123 --account acc_x --preview renders ONLY salesNavigator.saveLead, exits 0", () => {
    const r = run(["sales-nav", "save-lead", "--list", "L2", "ACw123", "--account", "acc_x", "--preview"]);
    expect(isUnknownCommand(r)).toBe(false);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("salesNavigator.saveLead");
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
  });

  it("sales-nav save-lead without --list exits 2 (usage error — --list is required)", () => {
    const r = run(["sales-nav", "save-lead", "ACw123", "--account", "acc_x"]);
    expect(r.status).toBe(2);
  });
});

describe("sales-nav v2 — --help renders (built dist)", () => {
  it("save-account --help excludes pagination flags, keeps --account", () => {
    const text = helpText(["sales-nav", "save-account"]);
    for (const flag of PAGINATION_ONLY_FLAGS) {
      expect(text, `save-account --help must not mention ${flag}`).not.toContain(flag);
    }
    expect(text).toContain("--account");
    expect(text).toContain("--list");
  });

  it("browse-account-list --help retains pagination flags (paginated browse, not a single-read)", () => {
    const text = helpText(["sales-nav", "browse-account-list"]);
    expect(text).toContain("--limit");
    expect(text).toContain("--cursor");
    expect(text).toContain("--all");
    expect(text).toContain("--filter");
    expect(text).toContain("--sort-by");
    expect(text).toContain("--sort-order");
  });

  it("browse-lead-list --help retains pagination flags and the spotlight flag", () => {
    const text = helpText(["sales-nav", "browse-lead-list"]);
    expect(text).toContain("--limit");
    expect(text).toContain("--cursor");
    expect(text).toContain("--all");
    expect(text).toContain("--spotlight");
  });

  it("account-lists / lead-lists --help retain pagination flags (list reads)", () => {
    for (const sub of ["account-lists", "lead-lists"]) {
      const text = helpText(["sales-nav", sub]);
      expect(text, `${sub} --help must have --limit`).toContain("--limit");
      expect(text, `${sub} --help must have --cursor`).toContain("--cursor");
      expect(text, `${sub} --help must have --all`).toContain("--all");
    }
  });

  it("sales-nav --help lists all five new subcommands", () => {
    const text = helpText(["sales-nav"]);
    expect(text).toContain("account-lists");
    expect(text).toContain("lead-lists");
    expect(text).toContain("browse-account-list");
    expect(text).toContain("browse-lead-list");
    expect(text).toContain("save-account");
  });
});
