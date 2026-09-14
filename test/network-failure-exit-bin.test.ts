/**
 * A request that got no response (connection refused) is a transient
 * platform fault: exit 7 on every command, the same as `doctor`.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cliPath, pkgRoot } from "./helpers/built-cli.js";

let xdg: string;
let deadUrl: string;

beforeAll(async () => {
  xdg = mkdtempSync(join(tmpdir(), "curviate-netfail-"));
  // A port that was just free: bind, read it, release it.
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  deadUrl = `http://127.0.0.1:${port}`;
});

function run(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: xdg, NODE_ENV: "production" };
  delete env["CURVIATE_ACCOUNT"];
  delete env["CURVIATE_BASE_URL"];
  env["CURVIATE_API_KEY"] = "cvt_test_netfail";
  const r = spawnSync(process.execPath, [cliPath, ...args, "--base-url", deadUrl], { env, encoding: "utf8", input: "" });
  return { status: r.status, out: r.stdout + r.stderr };
}

describe("no response is exit 7 everywhere", () => {
  const cases: string[][] = [
    ["doctor", "--json"],
    ["profile", "me", "--json", "--account", "acc_1"],
    ["account", "list", "--json"],
    ["webhook", "list", "--all", "--json"],
    // name resolution goes through its own error path
    ["profile", "me", "--json", "--account", "Some Person"],
  ];
  for (const args of cases) {
    it(args.join(" "), () => {
      const r = run(args);
      expect(r.status, r.out).toBe(7);
    });
  }

  it("every exit lookup passes the error, not only its code", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && /getExitCode\(\w+\.code\)/.test(readFileSync(p, "utf8"))) hits.push(p);
      }
    };
    const src = resolve(pkgRoot, "src");
    walk(src);
    expect(readFileSync(join(src, "lib", "exit-codes.ts"), "utf8")).toContain("export function getExitCode");
    expect(hits).toEqual([]);
  });
});
