/**
 * Local commands (no API request) declare and accept only the flags they act on.
 *
 * `login` and the `config` subcommands used to spread the whole GLOBAL_FLAGS
 * set, so `--cursor`, `--all`, `--fields`, `--preview`... appeared in their
 * help and were accepted silently while doing nothing. An agent reading that
 * help (or a table generated from it) is misled. Each refusal case below is
 * paired with a positive control on the same command, so a command that
 * refuses everything cannot pass.
 *
 * Spawns the built bin: unknown-flag rejection lives in the dispatcher.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderUsage, type CommandDef } from "citty";
import { runBin } from "./helpers/run-bin.js";

let xdgHome: string;

const run = (args: string[]) => runBin(args, xdgHome);

/** Flags that only mean something on an API request. */
const INERT = [
  ["--limit", "5"],
  ["--cursor", "abc"],
  ["--all"],
  ["--max-pages", "2"],
  ["--page-delay", "0"],
  ["--fields", "id"],
  ["--preview"],
  ["--verbose"],
  ["--timeout", "1000"],
] as const;

beforeAll(() => {
  xdgHome = mkdtempSync(join(tmpdir(), "curviate-local-flags-"));
  // A profile to act on for the config subcommands.
  const r = run(["login", "--api-key", "cvt_test_x", "--profile", "p1"]);
  expect(r.status, r.stderr).toBe(0);
});

describe("login", () => {
  it("positive control: every flag login acts on is accepted", () => {
    const r = run([
      "login", "--api-key", "cvt_test_key", "--profile", "p2",
      "--account", "acc_1", "--base-url", "https://api.example.test", "--json",
    ]);
    expect(r.status, r.stderr).toBe(0);
    const cfg = JSON.parse(readFileSync(join(xdgHome, "curviate", "config.json"), "utf8")) as {
      profiles: Record<string, { apiKey: string; account?: string; baseUrl?: string }>;
    };
    expect(cfg.profiles["p2"]).toMatchObject({
      apiKey: "cvt_test_key", account: "acc_1", baseUrl: "https://api.example.test",
    });
  });

  it.each(INERT)("refuses %s like an unknown flag (exit 2)", (...flag) => {
    const r = run(["login", "--api-key", "cvt_test_key", "--profile", "p3", ...(flag as readonly string[])]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`unknown flag \`${flag[0]}\``);
  });

  // In-process: citty's help path exits before a spawned child's stdout flushes.
  it("--help names none of the inert flags, and still names its own", async () => {
    const { loginCommand } = await import("../src/commands/login.js");
    const help = await renderUsage(loginCommand as CommandDef);
    expect(help).toContain("--api-key");
    for (const [flag] of INERT) expect(help).not.toContain(flag);
  });
});

const CONFIG_CASES: Array<[string, string[]]> = [
  ["list", ["config", "list", "--json"]],
  ["set-account", ["config", "set-account", "acc_9", "--profile", "p1", "--json"]],
  ["set-base-url", ["config", "set-base-url", "https://api.example.test", "--profile", "p1", "--json"]],
  ["reset", ["config", "reset", "--profile", "nonexistent-profile", "--yes", "--json"]],
];

describe.each(CONFIG_CASES)("config %s", (_name, ok) => {
  it("positive control: its own flags are accepted", () => {
    const r = run(ok);
    expect(r.stderr).not.toContain("unknown flag");
    expect(r.status, r.stderr).toBe(0);
  });

  it.each([...INERT, ["--api-key", "cvt_x"], ["--base-url", "https://x.test"]] as const)("refuses %s (exit 2)", (...flag) => {
    const r = run([...ok, ...(flag as readonly string[])]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`unknown flag \`${flag[0]}\``);
  });
});

describe("webhook verify (offline)", () => {
  const base = ["webhook", "verify", "--secret", "whsec_x", "--header", "t=1,v1=00", "--body", "{}", "--json"];

  it("positive control: its own flags reach verification", () => {
    const r = run([...base, "--max-age-secs", "300"]);
    expect(r.stderr).not.toContain("unknown flag");
    expect(r.stderr).toContain("webhook verification failed");
  });

  it.each([...INERT, ["--api-key", "cvt_x"], ["--base-url", "https://x.test"], ["--account", "acc_1"], ["--profile", "p1"]] as const)(
    "refuses %s (exit 2, before verification)",
    (...flag) => {
      const r = run([...base, ...(flag as readonly string[])]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`unknown flag \`${flag[0]}\``);
      expect(r.stderr).not.toContain("webhook verification failed");
    },
  );
});
