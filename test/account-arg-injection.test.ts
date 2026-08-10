/**
 * `--account` is a request-path segment, so it is an injection point.
 *
 * ## What the defect was
 *
 * The value of `--account` was interpolated into the URL path verbatim. The
 * URL parser then did what URL parsers do:
 *
 *   --account 'x/../../../v1/accounts'  ->  PATCH /v1/accounts/chats/chat_1
 *   --account 'a?x=1'                   ->  GET   /v1/a?x=1/users/me
 *   --account '%2e%2e'                  ->  the whole /v1 prefix is popped
 *
 * So a caller-supplied string redirected a WRITE to an arbitrary path on the
 * API host, carrying the caller's bearer token. The `%2e%2e` form needs no
 * slash at all: the URL Standard treats a percent-encoded dot pair as a
 * double-dot path segment, so a value made only of "safe-looking" characters
 * still walks up the path.
 *
 * ## Why these tests assert on captured requests, not on stdout
 *
 * stdout cannot tell "rejected before the request was built" apart from
 * "request was sent and the server refused it". That distinction is the whole
 * finding, so every case here asserts against a local HTTP sink that records
 * the ACTUAL outbound request set. An empty request set is the only proof the
 * guard runs before the wire.
 *
 * `inbox mark-read` is the subject because it is a WRITE. A read redirected to
 * the wrong path wastes a round trip; a write redirected to the wrong path
 * mutates something the caller never named.
 *
 * Build prerequisite: the global setup rebuilds `dist/` whenever `src/` is
 * newer, so a red-then-green cycle cannot be measuring a stale artifact.
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

/**
 * Two accounts whose names share a prefix, plus one that does not. A fixture
 * with a single account cannot detect a missing ambiguity guard, in the same
 * way a single-tenant fixture cannot detect a missing tenant filter.
 */
const ACCOUNTS = {
  object: "account_list",
  items: [
    { account_id: "acc_01RALF", full_name: "Ralf Fischer", status: "active" },
    { account_id: "acc_01RALB", full_name: "Ralf Fisher", status: "active" },
    { account_id: "acc_01SOPH", full_name: "Sophie Ahmed", status: "active" },
  ],
  cursor: null,
};

beforeAll(async () => {
  cliPath = ensureFreshBuild();
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const url = req.url ?? "";
      recorded.push({ method: req.method ?? "", url });
      res.writeHead(200, { "content-type": "application/json" });
      if (url.startsWith("/v1/accounts")) {
        res.end(JSON.stringify(ACCOUNTS));
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

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  requests: Recorded[];
}

/**
 * Run the built bin against the sink. XDG_CONFIG_HOME points at an empty temp
 * dir and every CURVIATE_* input is set explicitly, so the developer's real
 * config file and shell environment cannot supply an account or a base URL
 * behind the test's back.
 */
function run(args: string[]): Promise<RunResult> {
  recorded = [];
  const xdg = mkdtempSync(join(tmpdir(), "curviate-acct-arg-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: xdg,
    NODE_ENV: "production",
    CURVIATE_API_KEY: "cvt_test_account_arg_stub",
    CURVIATE_BASE_URL: baseUrl,
  };
  delete env["CURVIATE_ACCOUNT"];

  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("close", (status) => {
      resolvePromise({ status, stdout, stderr, requests: [...recorded] });
    });
    child.stdin.end();
  });
}

/** `inbox mark-read <chat>` — a write — with the given `--account` value. */
function markRead(account: string): Promise<RunResult> {
  return run(["inbox", "mark-read", "chat_1", "--account", account, "--json"]);
}

describe("AC1 — a path-unsafe --account never reaches the wire", () => {
  const payloads: Array<[string, string]> = [
    ["path traversal to a sibling collection", "x/../../../v1/accounts"],
    ["path traversal to a billing route", "x/../../billing/seats"],
    ["query injection", "a?x=1"],
    ["fragment injection", "a#x"],
    ["a bare slash", "a/b"],
    ["a backslash", "a\\b"],
    // No slash anywhere: the URL Standard decodes %2e when deciding whether a
    // segment is a dot segment, so this alone pops the /v1 prefix.
    ["percent-encoded dot segment", "%2e%2e"],
    ["percent-encoded dot segment, mixed case", "%2E%2e"],
    ["a lone percent sign", "a%b"],
    ["a literal dot pair", ".."],
    ["an embedded dot pair", "x/..%2fy"],
    ["a space", "acc 1"],
    ["a tab", "acc\t1"],
    ["a newline", "acc\n1"],
  ];

  for (const [label, value] of payloads) {
    it(`rejects ${label} with no outbound request at all`, async () => {
      const r = await markRead(value);
      // The load-bearing assertion: nothing left the machine. Not "the server
      // said no", not "stderr mentioned an error" — no request was built.
      expect(r.requests).toEqual([]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("--account");
    });
  }

  it("names the offending flag and points at the two accepted forms", async () => {
    const r = await markRead("x/../../../v1/accounts");
    expect(r.stderr).toMatch(/--account/);
    expect(r.stderr).toMatch(/account id|account name/i);
  });
});

describe("AC2 — a well-formed account id still works, with no added round trip", () => {
  it("sends exactly one request, and it carries the id in the path", async () => {
    const r = await markRead("acc_01SOPH");
    expect(r.status).toBe(0);
    // Exactly one: an id needs no resolution lookup. A second request here
    // would mean every existing scripted invocation just got slower.
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0]?.method).toBe("PATCH");
    expect(r.requests[0]?.url).toBe("/v1/acc_01SOPH/chats/chat_1");
  });

  it("accepts an id that is not in the connected list, without a lookup", async () => {
    // The CLI must not become an allow-list gate on ids: the API is the
    // authority on whether an id exists, and it answers with its own 404.
    const r = await markRead("acc_01NOTLISTED");
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0]?.url).toBe("/v1/acc_01NOTLISTED/chats/chat_1");
  });
});

describe("AC3 — a name that matches exactly one account resolves to its id", () => {
  it("puts the id in the request path, never the name", async () => {
    const r = await markRead("Sophie Ahmed");
    expect(r.status).toBe(0);
    const paths = r.requests.map((q) => q.url);
    // The resolution lookup, then the write against the resolved id.
    expect(paths.some((p) => p.startsWith("/v1/accounts"))).toBe(true);
    expect(paths).toContain("/v1/acc_01SOPH/chats/chat_1");
    // The name must not appear anywhere on the wire, in any encoding.
    expect(paths.join(" ")).not.toMatch(/Sophie|Ahmed|%20/i);
  });

  it("resolves a unique prefix of a name", async () => {
    const r = await markRead("Sophie");
    expect(r.status).toBe(0);
    expect(r.requests.map((q) => q.url)).toContain("/v1/acc_01SOPH/chats/chat_1");
  });

  it("resolves case-insensitively", async () => {
    const r = await markRead("sophie ahmed");
    expect(r.status).toBe(0);
    expect(r.requests.map((q) => q.url)).toContain("/v1/acc_01SOPH/chats/chat_1");
  });

  it("prefers an exact name over a longer name it prefixes", async () => {
    const r = await markRead("Ralf Fisher");
    expect(r.status).toBe(0);
    expect(r.requests.map((q) => q.url)).toContain("/v1/acc_01RALB/chats/chat_1");
  });
});

describe("AC4 — an ambiguous name errors distinctly and writes nothing", () => {
  it("never silently picks a candidate", async () => {
    const r = await markRead("Ralf");
    expect(r.status).not.toBe(0);
    // The resolution lookup is allowed. The write is not: picking either
    // candidate would land a reputation-affecting action on a persona the
    // caller did not name.
    const nonLookup = r.requests.filter((q) => !q.url.startsWith("/v1/accounts"));
    expect(nonLookup).toEqual([]);
  });

  it("names every candidate so the caller can disambiguate", async () => {
    const r = await markRead("Ralf");
    const text = r.stdout + r.stderr;
    expect(text).toContain("acc_01RALF");
    expect(text).toContain("acc_01RALB");
    expect(text).toContain("Ralf Fischer");
    expect(text).toContain("Ralf Fisher");
  });

  it("uses its own error code, distinct from the not-found one", async () => {
    const ambiguous = await markRead("Ralf");
    const missing = await markRead("Nobody At All");
    const codeOf = (s: string) => /\[([A-Z_]+)\]/.exec(s)?.[1] ?? "";
    const ambiguousCode = codeOf(ambiguous.stderr);
    const missingCode = codeOf(missing.stderr);
    expect(ambiguousCode).not.toBe("");
    expect(missingCode).not.toBe("");
    expect(ambiguousCode).not.toBe(missingCode);
    expect(ambiguousCode).not.toBe("ACCOUNT_NOT_FOUND");
  });
});

describe("AC5 — a name that matches nothing gets its own error, not a wire 404", () => {
  it("errors before the write, and says the name matched no account", async () => {
    const r = await markRead("Nobody At All");
    expect(r.status).not.toBe(0);
    const nonLookup = r.requests.filter((q) => !q.url.startsWith("/v1/accounts"));
    expect(nonLookup).toEqual([]);
    expect(r.stderr.toLowerCase()).toMatch(/no connected account|matched no/);
  });

  it("lists what is connected, so the caller can act on the message", async () => {
    const r = await markRead("Nobody At All");
    const text = r.stdout + r.stderr;
    expect(text).toContain("Ralf Fischer");
    expect(text).toContain("Sophie Ahmed");
  });
});

describe("the same guard applies wherever the account arrives from", () => {
  it("rejects a path-unsafe CURVIATE_ACCOUNT", async () => {
    recorded = [];
    const xdg = mkdtempSync(join(tmpdir(), "curviate-acct-env-"));
    const r = await new Promise<RunResult>((resolvePromise) => {
      const child = spawn(process.execPath, [cliPath, "inbox", "mark-read", "chat_1", "--json"], {
        env: {
          ...process.env,
          XDG_CONFIG_HOME: xdg,
          NODE_ENV: "production",
          CURVIATE_API_KEY: "cvt_test_account_arg_stub",
          CURVIATE_BASE_URL: baseUrl,
          CURVIATE_ACCOUNT: "x/../../../v1/accounts",
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
    expect(r.requests).toEqual([]);
    expect(r.status).toBe(2);
  });

  it("rejects a path-unsafe --account on a read as well", async () => {
    const r = await run(["inbox", "list", "--account", "x/../../../v1/accounts", "--json"]);
    expect(r.requests).toEqual([]);
    expect(r.status).toBe(2);
  });
});
