/**
 * The documented first run, end to end through the built bin.
 *
 * `account link --help` says a non-interactive shell exits 12 at the
 * verification step and finishes with `account checkpoint solve`. That path
 * used to be unreachable: argument validation refused the call for a missing
 * `--seat-id` an agent had no command to obtain. With `--seat-id` omitted the
 * command now reads the seats itself and connects into the only free one, so
 * exit 12 is reached.
 *
 * Asserted on the requests a local sink actually received, so "it resolved the
 * seat" is the seat id in the connect body, not a message claiming it.
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
  const xdg = mkdtempSync(join(tmpdir(), "curviate-link-noseat-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: xdg,
    NODE_ENV: "production",
    CURVIATE_API_KEY: "cvt_test_link_noseat_stub",
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

/** The command the public install files tell an agent to run, minus the seat id. */
const LINK = [
  "account",
  "link",
  "--auth-method",
  "cookie",
  "--li-at",
  "li_at_value",
  "--user-agent",
  "UA/1",
  "--json",
];

describe("account link without --seat-id", () => {
  it("reaches the documented checkpoint path: exit 12, seat resolved from the seats read", async () => {
    const r = await run(LINK);
    expect(r.status, r.stderr).toBe(12);
    expect(r.requests.map((q) => `${q.method} ${q.url.split("?")[0]}`)).toEqual([
      "GET /v1/accounts/seats",
      "POST /v1/auth/intent",
    ]);
    expect(JSON.parse(r.requests[1]!.body) as { seat_id: string }).toMatchObject({ seat_id: "seat_free" });
    // The exit-12 envelope carries the account id the follow-up command needs.
    expect(r.stdout).toContain("acc_new");
  });

  it("zero free seats: exit 2, nothing connected, and the fix is named", async () => {
    seats = [{ seat_id: "seat_taken", occupied: true, account_id: "acc_old" }];
    const r = await run(LINK);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("curviate account seats");
    expect(r.stderr).not.toContain("—");
    expect(r.requests.map((q) => q.url.split("?")[0])).toEqual(["/v1/accounts/seats"]);
  });

  it("several free seats: exit 2, both candidates named, nothing connected", async () => {
    seats = [
      { seat_id: "seat_a", occupied: false, account_id: null },
      { seat_id: "seat_b", occupied: false, account_id: null },
    ];
    const r = await run(LINK);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("seat_a");
    expect(r.stderr).toContain("seat_b");
    expect(r.requests.map((q) => q.url.split("?")[0])).toEqual(["/v1/accounts/seats"]);
  });

  // The resolve-then-bind window: another session can take the seat in between.
  // The CLI must surface the server's refusal as itself, not retry into a
  // different seat, and not claim a connect that did not happen.
  it("a seat taken between the read and the connect surfaces the server's refusal", async () => {
    intentReply = {
      status: 409,
      body: {
        code: "SEAT_NOT_EMPTY",
        message: "That seat is not empty.",
        user_fixable: true,
        retry_likely_to_succeed: false,
      },
    };
    const r = await run(LINK);
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBe(12);
    expect(r.stdout + r.stderr).toContain("SEAT_NOT_EMPTY");
    expect(r.requests.filter((q) => q.url.startsWith("/v1/auth/intent"))).toHaveLength(1);
  });

  // CONTROL: an explicit --seat-id costs no seats read, so the case above is
  // the resolution and not something every link now does.
  it("control: --seat-id given issues no seats read", async () => {
    const r = await run([...LINK, "--seat-id", "seat_explicit"]);
    expect(r.status, r.stderr).toBe(12);
    expect(r.requests.map((q) => q.url.split("?")[0])).toEqual(["/v1/auth/intent"]);
    expect(JSON.parse(r.requests[0]!.body) as { seat_id: string }).toMatchObject({ seat_id: "seat_explicit" });
  });
});
