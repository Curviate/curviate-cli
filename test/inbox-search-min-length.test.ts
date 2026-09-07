/**
 * `inbox search <query>` refuses a term under 3 characters BEFORE the wire.
 *
 * The API raised its `query` minimum from 1 to 3: the search
 * index is built from overlapping 3-character sequences, so a shorter term
 * cannot probe it and falls back to a scan. The server refuses such a term with
 * `400 INVALID_REQUEST`.
 *
 * ## Why this asserts on the captured request set, not on stdout
 *
 * The exit code alone cannot tell "refused locally" apart from "sent, and the
 * server refused it": both end at exit 2, because `INVALID_REQUEST` already maps
 * to 2 in the shared error table. That distinction IS the feature — a local
 * refusal costs no round trip and no rate-limit budget — so the proof has to be
 * that no request was made. An empty request set is the only evidence of that,
 * and the 3-character arm is the control that the sink records anything at all.
 *
 * TypeScript cannot express a string minimum length, so the SDK's generated type
 * for `query` is plain `string` and the compiler catches nothing here. This guard
 * is the whole of the client-side protection.
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
}

let cliPath: string;
let server: Server;
let baseUrl: string;
let recorded: Recorded[] = [];

const ACCOUNTS = {
  object: "account_list",
  items: [{ account_id: "acc_01SEARCH", full_name: "Ada Lovelace", status: "active" }],
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
      res.end(JSON.stringify({ object: "chat_list", items: [], cursor: null }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

afterEach(() => {
  recorded = [];
});

interface RunResult {
  status: number | null;
  stderr: string;
  requests: Recorded[];
}

function search(query: string): Promise<RunResult> {
  recorded = [];
  const xdg = mkdtempSync(join(tmpdir(), "curviate-search-min-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: xdg,
    NODE_ENV: "production",
    CURVIATE_API_KEY: "cvt_test_search_min_stub",
    CURVIATE_BASE_URL: baseUrl,
    CURVIATE_ACCOUNT: "acc_01SEARCH",
  };
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cliPath, "inbox", "search", query, "--json"], { env });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("close", (status) => resolvePromise({ status, stderr, requests: [...recorded] }));
    child.stdin.end();
  });
}

describe("inbox search — the 3-character floor is enforced before the request", () => {
  it("a 2-character term exits 2, names the minimum, and makes NO request", async () => {
    const r = await search("ab");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("at least 3 characters");
    // The load-bearing assertion: nothing reached the wire, not even the
    // account resolution that a later guard would have triggered first.
    expect(r.requests).toEqual([]);
  });

  it("a 1-character term is refused the same way", async () => {
    const r = await search("a");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("at least 3 characters");
    expect(r.requests).toEqual([]);
  });

  it("CONTROL: a 3-character term is allowed through and DOES reach the wire", async () => {
    // Without this arm, "no requests" is equally consistent with a sink that
    // records nothing and a CLI that never runs.
    const r = await search("abc");
    expect(r.status).toBe(0);
    expect(r.requests.length).toBeGreaterThan(0);
    expect(r.requests.some((q) => q.url.includes("/chats/search"))).toBe(true);
  });
});
