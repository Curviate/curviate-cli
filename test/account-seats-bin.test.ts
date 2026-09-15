/**
 * `curviate account seats` — fake-server tests through the built bin.
 *
 * Covers: the request path, human/--json output shape, an empty list's
 * billing-attention note, 401 -> exit 3 (UNAUTHORIZED), a non-page 200 answer
 * -> exit 7 (readablePage), and --all refused as an unknown flag -> exit 2
 * (the endpoint is not paginated, mirrors `GET /v1/inboxes`).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliPath } from "./helpers/built-cli.js";

let xdg: string;
let server: Server;
let baseUrl: string;
let lastRequest: { method?: string; url?: string; authorization?: string } = {};
let reply: { status: number; type: string; body: string } = {
  status: 200,
  type: "application/json",
  body: JSON.stringify({ object: "seat_list", items: [] }),
};

function run(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: xdg, NODE_ENV: "production" };
    delete env["CURVIATE_API_KEY"];
    delete env["CURVIATE_ACCOUNT"];
    delete env["CURVIATE_BASE_URL"];
    const child = spawn(process.execPath, [cliPath, ...args], { env });
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

beforeAll(async () => {
  xdg = mkdtempSync(join(tmpdir(), "curviate-account-seats-bin-"));
  server = createServer((req, res) => {
    lastRequest = { method: req.method, url: req.url, authorization: req.headers.authorization };
    req.resume();
    req.on("end", () => {
      res.writeHead(reply.status, { "content-type": reply.type });
      res.end(reply.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const ARGS = ["account", "seats", "--api-key", "cvt_test_x"];

describe("account seats: request", () => {
  it("GETs /v1/accounts/seats, no account required", async () => {
    reply = { status: 200, type: "application/json", body: JSON.stringify({ object: "seat_list", items: [] }) };
    const r = await run([...ARGS, "--base-url", baseUrl, "--json"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(lastRequest.method).toBe("GET");
    expect(lastRequest.url).toBe("/v1/accounts/seats");
    expect(lastRequest.authorization).toBe("Bearer cvt_test_x");
  });
});

describe("account seats: output shape", () => {
  const ITEMS = [
    { seat_id: "seat_free", occupied: false, account_id: null },
    { seat_id: "seat_bound", occupied: true, account_id: "acc_1" },
  ];

  it("--json: the raw {object, items} envelope, unchanged", async () => {
    reply = { status: 200, type: "application/json", body: JSON.stringify({ object: "seat_list", items: ITEMS }) };
    const r = await run([...ARGS, "--base-url", baseUrl, "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ object: "seat_list", items: ITEMS });
  });

  // Human-mode rendering (free/bound text) needs a real TTY stdout, which a
  // spawned child's stdout never is (always a pipe) — that variant is a unit
  // test against the exported run function instead, see
  // test/commands/account.test.ts "account seats: human output".
});

describe("account seats: empty result names billing", () => {
  it("empty items: exit 0, stdout carries the empty envelope, stderr names billing", async () => {
    reply = { status: 200, type: "application/json", body: JSON.stringify({ object: "seat_list", items: [] }) };
    const r = await run([...ARGS, "--base-url", baseUrl, "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ object: "seat_list", items: [] });
    expect(r.stderr).toMatch(/billing needs attention/);
  });

  it("control: a non-empty result does NOT print the billing note", async () => {
    reply = {
      status: 200,
      type: "application/json",
      body: JSON.stringify({ object: "seat_list", items: [{ seat_id: "s1", occupied: false, account_id: null }] }),
    };
    const r = await run([...ARGS, "--base-url", baseUrl, "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/billing needs attention/);
  });
});

describe("account seats: 401 exits 3", () => {
  it("an UNAUTHORIZED error body exits 3", async () => {
    reply = {
      status: 401,
      type: "application/json",
      body: JSON.stringify({ code: "UNAUTHORIZED", message: "bad key", user_fixable: true, retry_likely_to_succeed: false }),
    };
    const r = await run([...ARGS, "--base-url", baseUrl, "--json"]);
    expect(r.status, r.stdout + r.stderr).toBe(3);
  });
});

describe("account seats: a non-page 200 answer exits 7", () => {
  it("a 200 object with no items array is a platform fault, exit 7", async () => {
    reply = { status: 200, type: "application/json", body: JSON.stringify({ object: "seat_list" }) };
    const r = await run([...ARGS, "--base-url", baseUrl, "--json"]);
    expect(r.status, r.stdout + r.stderr).toBe(7);
    expect(r.stdout).toContain("PLATFORM_ERROR");
  });

  it("control: the same shape WITH items is accepted (exit 0)", async () => {
    reply = { status: 200, type: "application/json", body: JSON.stringify({ object: "seat_list", items: [] }) };
    const r = await run([...ARGS, "--base-url", baseUrl, "--json"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});

describe("account seats: --all is refused (not paginated)", () => {
  it("--all exits 2 as an unknown flag, no request sent", async () => {
    reply = { status: 200, type: "application/json", body: JSON.stringify({ object: "seat_list", items: [] }) };
    lastRequest = {};
    const r = await run([...ARGS, "--base-url", baseUrl, "--all"]);
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(lastRequest.method).toBeUndefined();
  });
});
