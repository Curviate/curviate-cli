/**
 * Every caller-supplied value that becomes a path segment, not just `--account`.
 *
 * ## What was still open
 *
 * `--account` was routed through the path-safety rule; the positionals were
 * not, and they are the same injection point. Observed on the built binary
 * before this guard existed, with a valid `--account` set:
 *
 *     inbox mark-read 'x/../../../v1/accounts'  ->  PATCH /v1/v1/accounts
 *     inbox mark-read '%2e%2e'                  ->  PATCH /v1/acc_probe/
 *     inbox mark-read 'a?x=1'                   ->  PATCH /v1/acc_probe/chats/a?x=1
 *     message send 'x/../../../v1/accounts' hi  ->  POST  /v1/v1/accounts/messages
 *
 * All four exit 0. The first and last are WRITES redirected onto a path the
 * caller never named, carrying the caller's bearer token, and this CLI is wired
 * into agent loops where a chat id is plausibly filled from model or user text.
 *
 * ## Why this suite does not enumerate the arguments
 *
 * A list of "the ids that are path segments" is exactly the list that loses a
 * member: the SDK has 69 distinct interpolating path templates and grows, and
 * an argument added next month would be unguarded and look identical to a
 * guarded one from the outside. So the guard is applied once at the SDK-call
 * boundary, over every leading string argument of every method, and this suite
 * samples across namespaces to prove it is the boundary that holds rather than
 * a per-command habit. The last case deliberately picks a command no part of
 * the implementation mentions.
 *
 * Assertions are on the recorded request set. stdout cannot tell "refused
 * before the request was built" from "sent, and the far end refused it", and
 * that difference is the whole finding.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureFreshBuild } from "./helpers/built-cli.js";

interface Recorded {
  method: string;
  url: string;
}

let cliPath: string;
let server: Server;
let baseUrl: string;
let recorded: Recorded[] = [];

beforeAll(async () => {
  cliPath = ensureFreshBuild();
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      recorded.push({ method: req.method ?? "", url: req.url ?? "" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "probe", items: [], cursor: null, id: "probe_1" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  requests: Recorded[];
}

/**
 * The account is a well-formed id supplied through the environment, so an
 * empty request set can only mean the POSITIONAL was refused. If the account
 * were the thing being rejected, every case here would pass vacuously.
 */
function run(args: string[]): Promise<RunResult> {
  recorded = [];
  const xdg = mkdtempSync(join(tmpdir(), "curviate-path-seg-"));
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: xdg,
        NODE_ENV: "production",
        CURVIATE_API_KEY: "cvt_test_path_segment_stub",
        CURVIATE_BASE_URL: baseUrl,
        CURVIATE_ACCOUNT: "acc_01PROBE",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("close", (status) => resolvePromise({ status, stdout, stderr, requests: [...recorded] }));
    child.stdin.end();
  });
}

const TRAVERSAL = "x/../../../v1/accounts";

describe("a redirecting positional never reaches the wire, on writes", () => {
  const writes: Array<[string, string[]]> = [
    ["inbox mark-read <chat>", ["inbox", "mark-read", TRAVERSAL]],
    ["message send <chat> <text>", ["message", "send", TRAVERSAL, "hello"]],
    ["post react <post>", ["post", "react", TRAVERSAL, "--reaction", "like"]],
    ["connect accept <invitation>", ["connect", "accept", TRAVERSAL]],
  ];

  for (const [label, argv] of writes) {
    it(`${label} issues no request at all`, async () => {
      const r = await run(argv);
      // The load-bearing assertion: no write was redirected anywhere, because
      // no request was built.
      expect(r.requests).toEqual([]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("INVALID_PATH_SEGMENT");
    });
  }
});

describe("the same rule holds on reads, and for every redirecting shape", () => {
  const payloads: Array<[string, string]> = [
    ["path traversal", TRAVERSAL],
    ["percent-encoded dot segment", "%2e%2e"],
    ["percent-encoded dot segment, mixed case", "%2E%2e"],
    ["query injection", "a?x=1"],
    ["fragment injection", "a#x"],
    ["a backslash", "a\\b"],
    ["a literal dot pair", ".."],
    ["a newline", "chat\n1"],
  ];

  for (const [label, value] of payloads) {
    it(`inbox get <chat> refuses ${label}`, async () => {
      const r = await run(["inbox", "get", value]);
      expect(r.requests).toEqual([]);
      expect(r.status).toBe(2);
    });
  }
});

describe("a path argument that is not the first one is guarded too", () => {
  it("message get <chat> <message> refuses a redirecting second id", async () => {
    const r = await run(["message", "get", "2-cleanchatid", TRAVERSAL]);
    expect(r.requests).toEqual([]);
    expect(r.status).toBe(2);
  });
});

describe("the guard is at the SDK-call boundary, not a per-command habit", () => {
  it("refuses on a command the guard's implementation never mentions", async () => {
    // `group members` is deliberately unrelated to anything the fix touches.
    // If the rule lived in the commands rather than at the boundary, a command
    // nobody remembered would be exactly the one still open.
    const r = await run(["group", "members", TRAVERSAL]);
    expect(r.requests).toEqual([]);
    expect(r.status).toBe(2);
  });

  it("names the offending argument and says what the value would have done", async () => {
    const r = await run(["inbox", "mark-read", TRAVERSAL]);
    expect(r.stderr).toMatch(/markChatRead/);
    expect(r.stderr).toMatch(/redirect the request/i);
  });
});

describe("the shapes a real identifier takes still work", () => {
  const accepted: Array<[string, string[], string]> = [
    [
      "a base64 chat id with = padding",
      ["inbox", "get", "2-NmMyYzhlZWEtYjA5OS00OWQ0XzEwMA=="],
      "/v1/acc_01PROBE/chats/2-NmMyYzhlZWEtYjA5OS00OWQ0XzEwMA==",
    ],
    ["a URN with colons", ["post", "get", "urn:li:activity:7100000000000000000"], "urn:li:activity:7100000000000000000"],
    ["a public slug", ["profile", "raphael-redmer"], "/v1/acc_01PROBE/users/raphael-redmer"],
    ["a bare numeric id", ["company", "1035"], "/v1/acc_01PROBE/companies/1035"],
    ["a COMPANY_ chat id", ["inbox", "get", "COMPANY_83734124_PRIMARY"], "COMPANY_83734124_PRIMARY"],
  ];

  for (const [label, argv, expectedInUrl] of accepted) {
    it(`${label} still reaches the wire`, async () => {
      const r = await run(argv);
      expect(r.status, `stderr: ${r.stderr.slice(0, 200)}`).toBe(0);
      expect(r.requests.map((q) => q.url).join(" ")).toContain(expectedInUrl);
    });
  }

  it("a member URL still normalises to its slug rather than being refused", async () => {
    // The URL is normalised client-side before it becomes a path segment, so
    // the guard must see the slug. A guard that ran on the raw positional
    // would reject a documented input instead.
    const r = await run(["profile", "https://www.linkedin.com/in/raphael-redmer"]);
    expect(r.status).toBe(0);
    expect(r.requests.map((q) => q.url)).toContain("/v1/acc_01PROBE/users/raphael-redmer");
  });

  it("a group URL still normalises to its numeric id", async () => {
    const r = await run(["group", "get", "https://www.linkedin.com/groups/9123014/"]);
    expect(r.status).toBe(0);
    expect(r.requests.map((q) => q.url)).toContain("/v1/acc_01PROBE/groups/9123014");
  });
});
