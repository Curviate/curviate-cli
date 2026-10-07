/**
 * `curviate draft ...` through the BUILT bin against a local stub HTTP server:
 * argv parsing, the exact requests on the wire, and exit codes. No live calls.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliPath, ensureFreshBuild } from "../helpers/built-cli.js";
import { spawnTestTimeout } from "../helpers/spawn-budget.js";

vi.setConfig({ testTimeout: spawnTestTimeout() });

type Seen = { method: string; url: string; ct: string | undefined; cl: string | undefined; body: Buffer };
let seen: Seen[] = [];
let server: Server;
let base = "";
let reply: (req: Seen) => { status: number; json?: unknown } = () => ({ status: 200, json: {} });
const home = mkdtempSync(join(tmpdir(), "draft-bin-"));

beforeAll(async () => {
  ensureFreshBuild();
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const s: Seen = {
        method: req.method ?? "",
        url: req.url ?? "",
        ct: req.headers["content-type"],
        cl: req.headers["content-length"],
        body: Buffer.concat(chunks),
      };
      seen.push(s);
      const r = reply(s);
      res.statusCode = r.status;
      if (r.json !== undefined) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(r.json));
      } else res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  seen = [];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: home,
    NODE_ENV: "production",
    CURVIATE_API_KEY: "cvt_test_stub",
    CURVIATE_BASE_URL: base,
  };
  delete env["CURVIATE_ACCOUNT"];
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [cliPath, ...args, "--json"], { env });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => resolve({ code, stdout, stderr }));
    p.stdin.end();
  });
}

const draft = { object: "draft", id: "drf_1", status: "draft", attachments: [] };

describe("curviate draft (built bin, stub server)", () => {
  it("create: no account is defaulted, --schedule-at passes through unchanged, JSON body", async () => {
    reply = () => ({ status: 201, json: { ...draft, status: "scheduled" } });
    const at = "2026-10-12T09:00:00+02:00";
    const r = await run(["draft", "create", "Hello", "--schedule-at", at]);
    expect(r.code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe("/v1/drafts");
    expect(JSON.parse(seen[0]!.body.toString())).toEqual({ text: "Hello", scheduled_at: at });
  });

  it("create --attach with a file over 5 MiB: create, then raw upload with the file's type and Content-Length", async () => {
    const dir = mkdtempSync(join(tmpdir(), "draft-bin-f-"));
    const f = join(dir, "clip final.mp4");
    const size = 5 * 1024 * 1024 + 1;
    writeFileSync(f, Buffer.alloc(size, 7));
    reply = (req) => (req.url.startsWith("/v1/drafts/") ? { status: 201, json: draft } : { status: 201, json: draft });
    const r = await run(["draft", "create", "Demo", "--account", "acc_1", "--attach", f]);
    expect(r.code).toBe(0);
    expect(seen.map((s) => `${s.method} ${s.url.split("?")[0]}`)).toEqual([
      "POST /v1/drafts",
      "POST /v1/drafts/drf_1/attachments",
    ]);
    expect(JSON.parse(seen[0]!.body.toString())).toEqual({ account_id: "acc_1", text: "Demo" });
    const up = seen[1]!;
    expect(new URL(up.url, base).searchParams.get("filename")).toBe("clip final.mp4");
    expect(up.ct).toBe("video/mp4");
    expect(up.cl).toBe(String(size));
    expect(up.body.length).toBe(size);
  });

  it("create --attach with a small file stays inline (one request, base64)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "draft-bin-f-"));
    const f = join(dir, "a.png");
    writeFileSync(f, Buffer.from([1, 2, 3]));
    reply = () => ({ status: 201, json: draft });
    const r = await run(["draft", "create", "--attach", f]);
    expect(r.code).toBe(0);
    expect(seen).toHaveLength(1);
    const body = JSON.parse(seen[0]!.body.toString());
    expect(body.attachments[0]).toEqual({ content: Buffer.from([1, 2, 3]).toString("base64"), content_type: "image/png", filename: "a.png" });
  });

  it("update --unschedule sends scheduled_at:null via PATCH", async () => {
    reply = () => ({ status: 200, json: draft });
    const r = await run(["draft", "update", "drf_1", "--unschedule"]);
    expect(r.code).toBe(0);
    expect(seen[0]!.method).toBe("PATCH");
    expect(seen[0]!.url).toBe("/v1/drafts/drf_1");
    expect(JSON.parse(seen[0]!.body.toString())).toEqual({ scheduled_at: null });
  });

  it("list: --status becomes one comma list; --account none, --from/--to sent as given", async () => {
    reply = () => ({ status: 200, json: { object: "draft_list", items: [], cursor: null } });
    const r = await run(["draft", "list", "--status", "scheduled,published", "--account", "none", "--from", "2026-10-01T00:00:00Z", "--to", "2026-11-01T00:00:00Z"]);
    expect(r.code).toBe(0);
    const u = new URL(seen[0]!.url, base);
    expect(u.pathname).toBe("/v1/drafts");
    expect(u.searchParams.getAll("status")).toEqual(["scheduled,published"]);
    expect(u.searchParams.get("account_id")).toBe("none");
    expect(u.searchParams.get("from")).toBe("2026-10-01T00:00:00Z");
    expect(u.searchParams.get("to")).toBe("2026-11-01T00:00:00Z");
  });

  it("delete: DELETE, a 204 is success (exit 0)", async () => {
    reply = () => ({ status: 204 });
    const r = await run(["draft", "delete", "drf_1"]);
    expect(r.code).toBe(0);
    expect(seen[0]!.method).toBe("DELETE");
  });

  it("publish: POST /publish; the API's refusal code surfaces with its exit code (SCHEDULE_CONFLICT -> 2)", async () => {
    reply = () => ({ status: 422, json: { code: "SCHEDULE_CONFLICT", message: "Another Draft is scheduled within 5 minutes.", user_fixable: true, retry_likely_to_succeed: false } });
    const r = await run(["draft", "publish", "drf_1"]);
    expect(r.code).toBe(2);
    expect(seen[0]!.url).toBe("/v1/drafts/drf_1/publish");
    expect(r.stdout + r.stderr).toContain("SCHEDULE_CONFLICT");
  });

  it("--schedule-at with --unschedule: exit 2, no request", async () => {
    const r = await run(["draft", "update", "drf_1", "--schedule-at", "2026-10-12T09:00:00Z", "--unschedule"]);
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it("a configured default account never leaks into a Draft", async () => {
    reply = () => ({ status: 201, json: draft });
    const env = { ...process.env, CURVIATE_ACCOUNT: "acc_default" };
    const code = await new Promise<number | null>((resolve) => {
      seen = [];
      const p = spawn(process.execPath, [cliPath, "draft", "create", "x", "--json"], {
        env: { ...env, XDG_CONFIG_HOME: home, NODE_ENV: "production", CURVIATE_API_KEY: "cvt_test_stub", CURVIATE_BASE_URL: base },
      });
      p.on("close", resolve);
      p.stdin.end();
    });
    expect(code).toBe(0);
    expect(JSON.parse(seen[0]!.body.toString())).toEqual({ text: "x" });
  });
});
