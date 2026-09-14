/**
 * Exit classification for a request that never left the process (a malformed
 * base URL -> 2) and for a server fault with no readable error body (-> 7),
 * through the built bin.
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
let reply: { status: number; type: string; body: string } = {
  status: 200,
  type: "application/json",
  body: JSON.stringify({ items: [], cursor: null }),
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
  xdg = mkdtempSync(join(tmpdir(), "curviate-base-url-bin-"));
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(reply.status, { "content-type": reply.type, "retry-after": "0" });
      res.end(reply.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const MALFORMED = ["not a url", "http//x", "http://", "", "localhost:9", "ftp://x"];

describe("a malformed base URL is a refused invocation, exit 2", () => {
  it("doctor: a well-formed base URL passes (positive control)", async () => {
    reply = { status: 200, type: "application/json", body: JSON.stringify({ items: [], cursor: null }) };
    const r = await run(["doctor", "--json", "--api-key", "cvt_test_x", "--base-url", baseUrl]);
    expect(r.status, r.stderr).toBe(0);
  });

  for (const bad of MALFORMED) {
    it(`doctor --base-url ${JSON.stringify(bad)} exits 2 and still reports`, async () => {
      const r = await run(["doctor", "--json", "--api-key", "cvt_test_x", "--base-url", bad]);
      expect(r.status, r.stdout + r.stderr).toBe(2);
      const report = JSON.parse(r.stdout.trim()) as { exit: number; api_reachable: boolean };
      expect(report.exit).toBe(2);
      expect(report.api_reachable).toBe(false);
    });
  }

  it("profile me: a well-formed base URL passes (positive control)", async () => {
    reply = { status: 200, type: "application/json", body: JSON.stringify({ provider_id: "p" }) };
    const r = await run(["profile", "me", "--json", "--api-key", "cvt_test_x", "--account", "acc_1", "--base-url", baseUrl]);
    expect(r.status, r.stderr).toBe(0);
  });

  for (const bad of MALFORMED) {
    it(`profile me --base-url ${JSON.stringify(bad)} exits 2, naming the base URL`, async () => {
      const r = await run(["profile", "me", "--json", "--api-key", "cvt_test_x", "--account", "acc_1", "--base-url", bad]);
      expect(r.status, r.stdout + r.stderr).toBe(2);
      expect(r.stdout + r.stderr).toMatch(/base URL/i);
    });
  }
});

describe("a 5xx with no readable error body is a platform fault, exit 7", () => {
  it("an HTML 502 exits 7 with PLATFORM_ERROR", async () => {
    reply = { status: 502, type: "text/html", body: "<html>Bad Gateway</html>" };
    const r = await run(["profile", "me", "--json", "--api-key", "cvt_test_x", "--account", "acc_1", "--base-url", baseUrl]);
    expect(r.status, r.stdout + r.stderr).toBe(7);
    expect(r.stdout).toContain("PLATFORM_ERROR");
  });

  it("a 500 with a declared INTERNAL envelope still exits 1 (table unchanged)", async () => {
    reply = {
      status: 500,
      type: "application/json",
      body: JSON.stringify({ code: "INTERNAL", message: "boom", user_fixable: false, retry_likely_to_succeed: false }),
    };
    const r = await run(["profile", "me", "--json", "--api-key", "cvt_test_x", "--account", "acc_1", "--base-url", baseUrl]);
    expect(r.status, r.stdout + r.stderr).toBe(1);
  });

  it("a server-sent retry-likely INTERNAL is a response, not a transport failure: exit 1", async () => {
    reply = {
      status: 503,
      type: "application/json",
      body: JSON.stringify({ code: "INTERNAL", message: "boom", user_fixable: false, retry_likely_to_succeed: true }),
    };
    const r = await run(["profile", "me", "--json", "--api-key", "cvt_test_x", "--account", "acc_1", "--base-url", baseUrl]);
    expect(r.status, r.stdout + r.stderr).toBe(1);
  });

  it("a 4xx with a non-JSON body is not reclassified", async () => {
    reply = { status: 404, type: "text/plain", body: "nope" };
    const r = await run(["profile", "me", "--json", "--api-key", "cvt_test_x", "--account", "acc_1", "--base-url", baseUrl]);
    expect(r.status, r.stdout + r.stderr).not.toBe(7);
  });
});
