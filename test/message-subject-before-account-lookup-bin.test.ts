/**
 * `sales-nav message new` and `recruiter message new` require `--subject`
 * (Recruiter also `--signature`), enforced with `if (!subject) exit 2`. That
 * guard ran AFTER `requireAccount`, which itself issues `GET /v1/accounts`
 * when `--account` is omitted (to resolve the sole connected account): a
 * lost `--subject`/`--signature` cost that lookup before the guard ever saw
 * it. A unit test mocking the SDK client can't see this — `requireAccount`
 * only makes a real request when `--account` is genuinely absent, so the
 * defect only shows on the built binary against a real listener.
 *
 * Fixed by moving the guard before `requireAccount`. Same shape as
 * `message inmail`'s `--subject` fix (see `message-inmail-subject.test.ts`).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureFreshBuild } from "./helpers/built-cli.js";

let cliPath: string;
let server: Server;
let baseUrl: string;
let requests: string[] = [];

beforeAll(async () => {
  cliPath = ensureFreshBuild();
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests.push(`${req.method ?? ""} ${(req.url ?? "").split("?")[0]}`);
      res.writeHead(200, { "content-type": "application/json" });
      if ((req.url ?? "").startsWith("/v1/accounts")) {
        res.end(JSON.stringify({ object: "account_list", items: [{ account_id: "acc_01ONLY", full_name: "Only One", status: "OK" }], cursor: null }));
        return;
      }
      res.end(JSON.stringify({ object: "chat", id: "chat_1", chat_id: "chat_1", message_id: "msg_1" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function run(args: string[]): Promise<{ status: number | null; stderr: string; requests: string[] }> {
  requests = [];
  const xdg = mkdtempSync(join(tmpdir(), "curviate-subject-before-account-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: xdg,
    NODE_ENV: "production",
    CURVIATE_API_KEY: "cvt_test_subject_before_account",
    CURVIATE_BASE_URL: baseUrl,
  };
  delete env["CURVIATE_ACCOUNT"];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => (stderr += c));
    child.stdout.resume();
    child.on("close", (status) => resolve({ status, stderr, requests: [...requests] }));
    child.stdin.end();
  });
}

describe("--subject/--signature checked before the account lookup, --account omitted", () => {
  it("sales-nav message new: empty --subject exits 2, no GET /v1/accounts", async () => {
    const r = await run(["sales-nav", "message", "new", "--to", "ACoAAA123", "--subject", "", "hello", "--json"]);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain("--subject");
    expect(r.requests, `expected zero requests, got ${JSON.stringify(r.requests)}`).toEqual([]);
  });

  it("sales-nav message new: omitted --subject exits 2, no GET /v1/accounts", async () => {
    const r = await run(["sales-nav", "message", "new", "--to", "ACoAAA123", "hello", "--json"]);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain("--subject");
    expect(r.requests, `expected zero requests, got ${JSON.stringify(r.requests)}`).toEqual([]);
  });

  it("sales-nav message new: same-path control, a real --subject DOES reach the account lookup", async () => {
    const r = await run(["sales-nav", "message", "new", "--to", "ACoAAA123", "--subject", "Hi", "hello", "--json"]);
    expect(r.requests, r.stderr).toContain("GET /v1/accounts");
  });

  it("recruiter message new: empty --subject exits 2, no GET /v1/accounts", async () => {
    const r = await run(["recruiter", "message", "new", "--to", "AEMAAA1", "--subject", "", "--signature", "Sig", "hello", "--json"]);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain("--subject");
    expect(r.requests, `expected zero requests, got ${JSON.stringify(r.requests)}`).toEqual([]);
  });

  it("recruiter message new: empty --signature exits 2, no GET /v1/accounts", async () => {
    const r = await run(["recruiter", "message", "new", "--to", "AEMAAA1", "--subject", "Sub", "--signature", "", "hello", "--json"]);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain("--signature");
    expect(r.requests, `expected zero requests, got ${JSON.stringify(r.requests)}`).toEqual([]);
  });

  it("recruiter message new: same-path control, real --subject/--signature DO reach the account lookup", async () => {
    const r = await run(["recruiter", "message", "new", "--to", "AEMAAA1", "--subject", "Sub", "--signature", "Sig", "hello", "--json"]);
    expect(r.requests, r.stderr).toContain("GET /v1/accounts");
  });
});
