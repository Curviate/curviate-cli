/**
 * Blank account-id positionals and a blank `webhook update --account-ids` are
 * refused before any request (exit 2). A recorder sink proves ZERO requests;
 * each has a same-path positive control that does send.
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
  const xdg = mkdtempSync(join(tmpdir(), "curviate-blank-id-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: xdg,
    NODE_ENV: "production",
    CURVIATE_API_KEY: "cvt_test_blank_id_stub",
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

const CHECKPOINT_BLANK = [
  ["get"], ["disconnect"], ["update", "--metadata", "{}"],
  ["checkpoint", "solve", "--code", "123456"], ["checkpoint", "poll"], ["checkpoint", "request"],
];

describe("blank account_id positional", () => {
  for (const cmd of CHECKPOINT_BLANK) {
    for (const [label, value] of [["empty", ""], ["whitespace", "  "]] as const) {
      const [head0, ...rest] = cmd as [string, ...string[]];
      // positional goes right after the subcommand word(s)
      const lead = head0 === "checkpoint" ? [head0, rest[0]!, value, ...rest.slice(1)] : [head0, value, ...rest];
      it(`account ${cmd.slice(0, head0 === "checkpoint" ? 2 : 1).join(" ")} ${label}: exit 2, zero requests`, async () => {
        const r = await run(["account", ...lead, "--json"]);
        expect(r.status, r.stderr).toBe(2);
        expect(r.stderr).toContain("account_id is required");
        expect(r.requests).toEqual([]);
      });
    }
  }

  it("positive control: a real id sends the request", async () => {
    const r = await run(["account", "get", "acc_real", "--json"]);
    expect(r.requests.map((q) => `${q.method} ${q.url.split("?")[0]}`)).toEqual(["GET /v1/accounts/acc_real"]);
  });
  it("positive control: checkpoint request with a real id sends the request", async () => {
    const r = await run(["account", "checkpoint", "request", "acc_real", "--json"]);
    expect(r.requests.length).toBe(1);
    expect(r.requests[0]!.url + r.requests[0]!.body).toContain("acc_real");
  });
});

describe("positive controls for the other account_id sites", () => {
  for (const cmd of [["disconnect", "acc_real"], ["checkpoint", "poll", "acc_real"], ["checkpoint", "solve", "acc_real", "--code", "1"]]) {
    it(`account ${cmd.slice(0, cmd[0] === "checkpoint" ? 2 : 1).join(" ")} with a real id sends a request`, async () => {
      const r = await run(["account", ...cmd, "--json"]);
      expect(r.requests.length).toBeGreaterThan(0);
      expect(r.requests[0]!.url + r.requests[0]!.body).toContain("acc_real");
    });
  }
});

describe("webhook update --account-ids blank", () => {
  for (const [label, value] of [["empty", ""], ["whitespace", "  "], ["only commas", " , "]] as const) {
    it(`${label}: exit 2, zero requests`, async () => {
      const r = await run(["webhook", "update", "wh_1", "--account-ids", value, "--json"]);
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toContain("--account-ids was given an empty value");
      expect(r.requests).toEqual([]);
    });
  }
  it("positive control: a real list is sent as account_ids", async () => {
    const r = await run(["webhook", "update", "wh_1", "--account-ids", "acc_a, acc_b", "--json"]);
    expect(r.requests.length).toBe(1);
    expect(JSON.parse(r.requests[0]!.body) as unknown).toMatchObject({ account_ids: ["acc_a", "acc_b"] });
  });
});
