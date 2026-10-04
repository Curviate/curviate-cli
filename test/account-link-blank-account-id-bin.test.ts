/**
 * `account link --account-id` with an empty or blank value: refused before any
 * request (exit 2). It used to open a NEW connect (empty) or send a reconnect
 * for a blank id (whitespace).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureFreshBuild } from "./helpers/built-cli.js";

interface Recorded {
  method: string;
  url: string;
  body: string;
}

const FREE_ONE = [
  { seat_id: "seat_taken", occupied: true, account_id: "acc_old" },
  { seat_id: "seat_free", occupied: false, account_id: null },
];

let cliPath: string;
let server: Server;
let baseUrl: string;
let recorded: Recorded[] = [];
let seats: unknown[] = FREE_ONE;
/** What POST /v1/auth/intent answers. Default: the checkpoint challenge. */
let intentReply: { status: number; body: unknown } = {
  status: 202,
  body: {
    object: "account",
    status: "checkpoint_required",
    account_id: "acc_new",
    checkpoint: { type: "OTP" },
  },
};

beforeAll(async () => {
  cliPath = ensureFreshBuild();
  server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (body += c));
    req.on("end", () => {
      const url = req.url ?? "";
      recorded.push({ method: req.method ?? "", url, body });
      if (url.startsWith("/v1/accounts/seats")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "seat_list", items: seats }));
        return;
      }
      res.writeHead(intentReply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(intentReply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

afterEach(() => {
  seats = FREE_ONE;
  intentReply = {
    status: 202,
    body: { object: "account", status: "checkpoint_required", account_id: "acc_new", checkpoint: { type: "OTP" } },
  };
});

function run(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string; requests: Recorded[] }> {
  recorded = [];
  const xdg = mkdtempSync(join(tmpdir(), "curviate-link-blankacc-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: xdg,
    NODE_ENV: "production",
    CURVIATE_API_KEY: "cvt_test_link_blankacc_stub",
    CURVIATE_BASE_URL: baseUrl,
  };
  delete env["CURVIATE_ACCOUNT"];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("close", (status) => resolve({ status, stdout, stderr, requests: [...recorded] }));
    child.stdin.end("");
  });
}

const LINK = [
  "account", "link", "--auth-method", "cookie", "--li-at", "li_at_value",
  "--user-agent", "UA/1", "--country", "US", "--seat-id", "seat_taken", "--json",
];

describe("account link --account-id blank", () => {
  for (const [label, value] of [["empty", ""], ["whitespace", "  "]] as const) {
    it(`${label}: exit 2, guiding message, zero requests`, async () => {
      const r = await run([...LINK, "--account-id", value]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("--account-id was given an empty value");
      expect(r.requests).toEqual([]);
    });
  }

  it("positive control: a real id sends the reconnect with account_id in the body", async () => {
    const r = await run([...LINK, "--account-id", "acc_old"]);
    expect(r.status, r.stderr).toBe(12);
    expect(r.requests.map((q) => `${q.method} ${q.url.split("?")[0]}`)).toEqual(["POST /v1/auth/intent"]);
    expect(JSON.parse(r.requests[0]!.body) as { account_id: string }).toMatchObject({ account_id: "acc_old" });
  });
});
