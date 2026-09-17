/**
 * No `--account`, no `CURVIATE_ACCOUNT`, no profile account: the CLI looks up
 * the connected accounts and uses the only one. Zero or several connected is a
 * usage error that writes nothing. Any explicit source wins and costs no
 * lookup. Asserted on the requests a local sink actually received.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureFreshBuild } from "./helpers/built-cli.js";

interface Recorded {
  method: string;
  url: string;
}

const ONE = [{ account_id: "acc_01ONLY", full_name: "Only One", status: "OK" }];
const MANY = [
  { account_id: "acc_01RALF", full_name: "Ralf Fischer", status: "OK" },
  { account_id: "acc_01SOPH", full_name: "Sophie Ahmed", status: "OK" },
];

let cliPath: string;
let server: Server;
let baseUrl: string;
let recorded: Recorded[] = [];
let connected: unknown[] = ONE;
let endless = false;

beforeAll(async () => {
  cliPath = ensureFreshBuild();
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const url = req.url ?? "";
      recorded.push({ method: req.method ?? "", url });
      res.writeHead(200, { "content-type": "application/json" });
      if (url.startsWith("/v1/accounts")) {
        res.end(JSON.stringify({ object: "account_list", items: connected, cursor: endless ? "next" : null }));
        return;
      }
      res.end(JSON.stringify({ object: "chat", unread_count: 0 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

afterEach(() => {
  connected = ONE;
  endless = false;
});

function run(
  args: string[],
  opts: { env?: Record<string, string>; profileAccount?: string } = {},
): Promise<{ status: number | null; stderr: string; requests: Recorded[] }> {
  recorded = [];
  const xdg = mkdtempSync(join(tmpdir(), "curviate-acct-auto-"));
  if (opts.profileAccount) {
    mkdirSync(join(xdg, "curviate"), { recursive: true });
    writeFileSync(
      join(xdg, "curviate", "config.json"),
      JSON.stringify({ active: "default", profiles: { default: { account: opts.profileAccount } } }),
    );
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: xdg,
    NODE_ENV: "production",
    CURVIATE_API_KEY: "cvt_test_account_auto_stub",
    CURVIATE_BASE_URL: baseUrl,
    ...opts.env,
  };
  // Only when the case did not ask for one: deleting it on an EMPTY value is
  // what hid the empty-value defect, since an empty env var is a value.
  if (!(opts.env && "CURVIATE_ACCOUNT" in opts.env)) delete env["CURVIATE_ACCOUNT"];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => (stderr += c));
    child.stdout.resume();
    child.on("close", (status) => resolve({ status, stderr, requests: [...recorded] }));
    child.stdin.end();
  });
}

const markRead = ["inbox", "mark-read", "chat_1", "--json"];
const writes = (reqs: Recorded[]) => reqs.filter((q) => !q.url.startsWith("/v1/accounts"));

describe("no account given: resolve the only connected one", () => {
  it("exactly one connected: one lookup, then the write under that id", async () => {
    const r = await run(markRead);
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests.map((q) => `${q.method} ${q.url.split("?")[0]}`)).toEqual([
      "GET /v1/accounts",
      "PATCH /v1/acc_01ONLY/chats/chat_1",
    ]);
  });

  it("a read resolves the same way (the command login tells a new user to run)", async () => {
    const r = await run(["profile", "me", "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests.map((q) => q.url.split("?")[0])).toEqual(["/v1/accounts", "/v1/acc_01ONLY/users/me"]);
  });

  it("zero connected: exit 2, says so, writes nothing", async () => {
    connected = [];
    const r = await run(markRead);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("no LinkedIn account is connected to this workspace yet");
    expect(writes(r.requests)).toEqual([]);
    expect(r.requests).toHaveLength(1);
  });

  it("several connected: exit 2, lists every candidate, writes nothing", async () => {
    connected = MANY;
    const r = await run(markRead);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("acc_01RALF");
    expect(r.stderr).toContain("acc_01SOPH");
    expect(writes(r.requests)).toEqual([]);
  });

  it("a truncated account list refuses rather than picking the one it saw", async () => {
    endless = true;
    const r = await run(markRead);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("ACCOUNT_LIST_TRUNCATED");
    expect(writes(r.requests)).toEqual([]);
  });

  it("--preview issues no lookup, so it still needs --account", async () => {
    const r = await run([...markRead, "--preview"]);
    expect(r.status).toBe(2);
    expect(r.requests).toEqual([]);
  });
});

describe("an empty or blank account is never an omitted one", () => {
  it.each([
    ["--account ''", { args: ["--account", ""] }],
    ["--account '   '", { args: ["--account", "   "] }],
    ["CURVIATE_ACCOUNT=''", { env: { CURVIATE_ACCOUNT: "" } }],
    ["CURVIATE_ACCOUNT='  '", { env: { CURVIATE_ACCOUNT: "  " } }],
  ] as const)("%s exits 2 and sends nothing", async (_label, src) => {
    const r = await run([...markRead, ...("args" in src ? src.args : [])], src as never);
    expect(r.status).toBe(2);
    expect(r.requests, "not even the lookup: the value is a usage error").toEqual([]);
  });

  // The reported defect, end to end: an empty env value beat the configured
  // profile account, then read as "no account given", and the write went out
  // under a DIFFERENT persona than the one configured.
  it("an empty CURVIATE_ACCOUNT does not auto-pick over a configured profile account", async () => {
    const r = await run(markRead, { env: { CURVIATE_ACCOUNT: "" }, profileAccount: "acc_02B" });
    expect(r.status).toBe(2);
    expect(writes(r.requests)).toEqual([]);
    expect(r.requests.map((q) => q.url)).not.toContain("/v1/acc_01ONLY/chats/chat_1");
  });
});

describe("a listing row that cannot be read makes the set incomplete", () => {
  it.each([
    ["a missing account_id", { full_name: "No Id" }],
    ["an empty account_id", { account_id: "", full_name: "Blank" }],
    ["a non-string account_id", { account_id: 42, full_name: "Number" }],
  ] as const)("%s beside one good row refuses to auto-pick, and writes nothing", async (_label, bad) => {
    connected = [...ONE, bad];
    const r = await run(markRead);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("ACCOUNT_LIST_TRUNCATED");
    expect(writes(r.requests)).toEqual([]);
  });

  it("the same unreadable row also blocks resolving a name to the good row", async () => {
    connected = [...ONE, { full_name: "No Id" }];
    const r = await run([...markRead, "--account", "Only One"]);
    expect(r.status).toBe(2);
    expect(writes(r.requests)).toEqual([]);
  });

  // CONTROL: two readable rows are read fine, so the guard above is about the
  // unreadable row and not about a second row existing.
  it("control: a readable second row still resolves by name", async () => {
    connected = MANY;
    const r = await run([...markRead, "--account", "Sophie Ahmed"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests.map((q) => q.url)).toContain("/v1/acc_01SOPH/chats/chat_1");
  });
});

describe("an explicit account wins, with no lookup", () => {
  it.each([
    ["--account", { args: ["--account", "acc_01FLAG"] }],
    ["CURVIATE_ACCOUNT", { env: { CURVIATE_ACCOUNT: "acc_01FLAG" } }],
    ["the profile's account", { profileAccount: "acc_01FLAG" }],
  ] as const)("%s", async (_label, src) => {
    connected = MANY;
    const r = await run([...markRead, ...("args" in src ? src.args : [])], src as never);
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests.map((q) => q.url)).toEqual(["/v1/acc_01FLAG/chats/chat_1"]);
  });
});
