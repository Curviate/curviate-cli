/**
 * `account link` without `--seat-id` must not dead-end a first run.
 *
 * `--seat-id` is no longer a required argument: omitted, the command
 * uses the only free seat, and says so by name when zero or several are free.
 * What remains asserted here is the dispatcher half: the flags that ARE still
 * required carry their own hint, and the help names `curviate account seats`
 * as the source of a seat id. Spawns the built bin: citty's required-argument
 * check and its diagnostic live in the dispatcher.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderUsage, type CommandDef } from "citty";
import { runBin } from "./helpers/run-bin.js";

const xdgHome = mkdtempSync(join(tmpdir(), "curviate-seat-hint-"));

const run = (args: string[]) => runBin(args, xdgHome);

describe("account link: --seat-id is optional, --auth-method is not", () => {
  it("no arguments: exit 2 on --auth-method only, never on --seat-id", () => {
    const r = run(["account", "link"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Missing required argument: --auth-method");
    expect(r.stderr).not.toMatch(/Missing required argument.*--seat-id/);
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

  it("--help: --seat-id names `curviate account seats` and is not marked required; the exit-12 note stands", async () => {
    const { accountCommand } = await import("../src/commands/account.js");
    const subs = (await (accountCommand as CommandDef).subCommands) as Record<string, CommandDef>;
    const help = await renderUsage(subs["link"]!);
    expect(help).toMatch(/--seat-id[\s\S]*curviate account seats/);
    expect(help).not.toMatch(/--seat-id[^\n]*\(required\)/);
    expect(help).toMatch(/--auth-method[^.]*exits 12/);
  });
});
