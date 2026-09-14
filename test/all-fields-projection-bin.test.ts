/**
 * `--fields` narrows each NDJSON item of an `--all` stream,
 * keeping the preserved keys; without `--fields` the stream is unchanged.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cliPath, pkgRoot } from "./helpers/built-cli.js";

const ITEM = {
  account_id: "acc_1",
  id: "wh_1",
  status: "active",
  auth_method: "credentials",
  full_name: "Test Person",
  url: "https://example.test/hook",
  extra: 1,
  notices: [{ code: "SOME_RESULTS_HIDDEN", message: "hidden" }],
  safety_warning: { row: "invites" },
  source: "store",
  observed_at: "2026-09-01T00:00:00Z",
  withdrawn: false,
};

let xdg: string;
let server: Server;
let baseUrl: string;

function run(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: xdg, NODE_ENV: "production" };
    delete env["CURVIATE_ACCOUNT"];
    delete env["CURVIATE_BASE_URL"];
    env["CURVIATE_API_KEY"] = "cvt_test_all_fields";
    const child = spawn(process.execPath, [cliPath, ...args, "--base-url", baseUrl], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
    child.stdin.end("");
  });
}

const lines = (stdout: string) =>
  stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

beforeAll(async () => {
  xdg = mkdtempSync(join(tmpdir(), "curviate-all-fields-"));
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: [ITEM, { ...ITEM, account_id: "acc_2", id: "wh_2" }], cursor: null }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const PRESERVED = ["notices", "safety_warning", "source", "observed_at", "withdrawn"];

describe("--all --fields projects each streamed item", () => {
  for (const [cmd, key] of [
    [["account", "list"], "account_id"],
    [["webhook", "list"], "id"],
  ] as const) {
    it(`${cmd.join(" ")} --all --fields ${key}: only the field plus preserved keys`, async () => {
      const r = await run([...cmd, "--all", "--json", "--fields", key]);
      expect(r.status, r.stderr).toBe(0);
      const items = lines(r.stdout);
      expect(items).toHaveLength(2);
      for (const item of items) {
        expect(Object.keys(item).sort()).toEqual([key, ...PRESERVED].sort());
      }
    });

    it(`${cmd.join(" ")} --all without --fields is unchanged (carries more than the field)`, async () => {
      const r = await run([...cmd, "--all", "--json"]);
      expect(r.status, r.stderr).toBe(0);
      const items = lines(r.stdout);
      expect(items).toHaveLength(2);
      expect(Object.keys(items[0]!)).toContain("status");
    });
  }

  it("every --all stream in the command tree writes through the projecting helper", () => {
    const dir = resolve(pkgRoot, "src", "commands");
    let loops = 0;
    let helper = 0;
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), "utf8");
      loops += src.match(/of streamAll\(/g)?.length ?? 0;
      helper += src.match(/writeNdjsonItem\(/g)?.length ?? 0;
    }
    expect(loops).toBeGreaterThan(0);
    expect(helper).toBe(loops);
  });
});
