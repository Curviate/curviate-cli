/**
 * `account link` without `--seat-id` must say where a seat id comes from.
 *
 * No CLI command lists seats, so "is required" alone left a first run with no
 * way forward. The missing-argument error now carries the flag's own help
 * description, and that description names the dashboard page that lists
 * seat ids. Spawns the built bin: citty's required-argument check and its
 * diagnostic live in the dispatcher.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderUsage, type CommandDef } from "citty";
import { cliPath } from "./helpers/built-cli.js";

const xdgHome = mkdtempSync(join(tmpdir(), "curviate-seat-hint-"));

function run(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: xdgHome, NODE_ENV: "production" };
  delete env["CURVIATE_API_KEY"];
  const r = spawnSync(process.execPath, [cliPath, ...args], { env, encoding: "utf8", input: "" });
  return { status: r.status, stderr: r.stderr };
}

describe("account link: missing --seat-id names where seat ids come from", () => {
  it("no arguments: exit 2, names --seat-id and the dashboard Billing page", () => {
    const r = run(["account", "link"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--seat-id");
    expect(r.stderr).toMatch(/Billing page of the Curviate dashboard/);
    expect(r.stderr).not.toContain("—");
  });

  it("control: with --seat-id, the missing --auth-method error carries its own hint, not the seat one", () => {
    const r = run(["account", "link", "--seat-id", "seat_1"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Missing required argument: --auth-method");
    expect(r.stderr).toContain("credentials | cookie");
    expect(r.stderr).not.toContain("Billing");
  });

  it("--help: --seat-id names the Billing page; the exit-12 note is scoped to after the required flags", async () => {
    const { accountCommand } = await import("../src/commands/account.js");
    const subs = (await (accountCommand as CommandDef).subCommands) as Record<string, CommandDef>;
    const help = await renderUsage(subs["link"]!);
    expect(help).toMatch(/--seat-id[\s\S]*Billing page of the Curviate dashboard/);
    expect(help).toMatch(/--seat-id and --auth-method[^.]*exits 12/);
  });
});
