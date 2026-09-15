/**
 * `account link` without `--seat-id` must say where a seat id comes from.
 *
 * "is required" alone left a first run with no way forward. The
 * missing-argument error now carries the flag's own help description, and
 * that description names `curviate account seats`, the command that lists
 * seat ids. Spawns the built bin: citty's required-argument check and its
 * diagnostic live in the dispatcher.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderUsage, type CommandDef } from "citty";
import { runBin } from "./helpers/run-bin.js";

const xdgHome = mkdtempSync(join(tmpdir(), "curviate-seat-hint-"));

const run = (args: string[]) => runBin(args, xdgHome);

describe("account link: missing --seat-id names where seat ids come from", () => {
  it("no arguments: exit 2, names --seat-id and `curviate account seats`", () => {
    const r = run(["account", "link"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--seat-id");
    expect(r.stderr).toMatch(/curviate account seats/);
    expect(r.stderr).not.toContain("—");
  });

  it("control: with --seat-id, the missing --auth-method error carries its own hint, not the seat one", () => {
    const r = run(["account", "link", "--seat-id", "seat_1"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Missing required argument: --auth-method");
    expect(r.stderr).toContain("credentials | cookie");
    expect(r.stderr).not.toContain("account seats");
  });

  it("the hint is the description's first sentence, without the (required) marker: job list --state", () => {
    const r = run(["job", "list"]);
    expect(r.status).toBe(2);
    const hints = r.stderr.split("\n").filter((l) => l.startsWith("hint: "));
    expect(hints).toEqual([
      "hint: --state: Filter by state: DRAFT|OPEN|CLOSED|REVIEW|SUSPENDED, or ALL for a best-effort client-side union across every state (each state queried, re-filtered, merged and de-duplicated by id; no unified cursor).",
    ]);
  });

  it("--help: --seat-id names `curviate account seats`; the exit-12 note is scoped to after the required flags", async () => {
    const { accountCommand } = await import("../src/commands/account.js");
    const subs = (await (accountCommand as CommandDef).subCommands) as Record<string, CommandDef>;
    const help = await renderUsage(subs["link"]!);
    expect(help).toMatch(/--seat-id[\s\S]*curviate account seats/);
    expect(help).toMatch(/--seat-id and --auth-method[^.]*exits 12/);
  });
});
