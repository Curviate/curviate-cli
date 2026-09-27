/**
 * `--cursor ""` is a LOST cursor, not an omitted one.
 *
 * Every paginated command used to guard the flag with `if (flags.cursor)`,
 * so an empty or whitespace-only value was dropped client-side and the page
 * walk silently restarted at page one — `--cursor "$NEXT"` with `NEXT` unset
 * re-reads the first page forever and reports exit 0 every time. The server
 * now answers 400 on an empty cursor, but the CLI never let it get that
 * far. Both halves are now refused here: exit 2, before any list request,
 * naming the flag.
 *
 * Same ruling as `account link --seat-id ""` in 0.37.0.
 *
 * The surface is discovered from the live command tree
 * (`discoverCursorNodes`), never a hand-written list, so a new paginated
 * command is covered automatically.
 *
 * Positive control, SAME PATH: the identical argv with a real cursor value
 * exits 0 AND that value reaches the outgoing request (query or body). That
 * control is what the `--cursor`-accepted-then-ignored defect would have
 * failed: exit 2 alone would pass on a command that refuses the empty string
 * and still throws a real cursor away.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliPath } from "./helpers/built-cli.js";
import { discoverCursorNodes, argvFor, type Node } from "./helpers/streaming-nodes.js";

const xdg = mkdtempSync(join(tmpdir(), "curviate-cursor-empty-"));

/** Distinctive enough that it cannot appear in a request by accident. */
const PROBE = "c_probe_9f3a2b";

/**
 * Commands that DECLARE `--cursor` against an endpoint that has no cursor
 * input at all.
 *
 * Ruling applied: every one of the below (plus `recruiter applicants`, found
 * the same way but missing from the original hand list) now uses
 * `READ_SINGLE_FLAGS` / `WRITE_SINGLE_FLAGS` in place of the removed
 * `NON_STREAM_FLAGS`, so none of them declares `--cursor` anymore and this
 * set is empty. `recruiter search parameters` keeps `--limit` (the served
 * endpoint takes `limit`/`offset`, just no `cursor`) added back directly on
 * its own args; see `test/cursorless-flags-removed-bin.test.ts` for the
 * dedicated coverage this ruling needed (unknown-flag refusal, not emptiness)
 * that this file's shape (empty vs. real cursor value) can't express.
 *
 * ponytail: exclusion list, delete entries as the flag sets are corrected.
 * The exact count below is the upgrade trigger — a node cannot drift in
 * silently, and a fixed node cannot stay excluded. Left in place, emptied,
 * rather than deleted outright: a future command spreading the wrong flag
 * bundle re-populates `declared` with it, and this mechanism is exactly
 * where that entry gets named and justified (or the flag set gets fixed
 * instead).
 */
const NO_CURSOR_INPUT_ON_THE_ENDPOINT = new Set<string>([]);

let server: Server;
let baseUrl: string;
/** Every request this run received, as "<url> <body>". */
let seen: string[] = [];

function run(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: xdg, NODE_ENV: "production" };
    delete env["CURVIATE_API_KEY"];
    delete env["CURVIATE_ACCOUNT"];
    delete env["CURVIATE_BASE_URL"];
    const child = spawn(process.execPath, [cliPath, ...args, "--json", "--beta", "--api-key", "cvt_test_x", "--account", "acc_1", "--base-url", baseUrl], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (status) => done({ status, stdout, stderr }));
    child.stdin.end("");
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      seen.push(`${req.url ?? ""} ${body}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", id: "ACoAAB1234", items: [], cursor: null }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("--cursor: an empty value is refused, a real one is honoured", async () => {
  const declared: Node[] = await discoverCursorNodes();
  const nodes = declared.filter((n) => !NO_CURSOR_INPUT_ON_THE_ENDPOINT.has(n.path.join(" ")));

  it("the sweep covers the paginated surface", () => {
    expect(nodes.length).toBeGreaterThan(50);
  });

  it("every excluded command still exists and still declares --cursor", () => {
    // A stale exclusion is as bad as a missing one: it would silently drop a
    // command out of the sweep after someone corrected its flag set.
    const declaredPaths = new Set(declared.map((n) => n.path.join(" ")));
    const stale = [...NO_CURSOR_INPUT_ON_THE_ENDPOINT].filter((p) => !declaredPaths.has(p));
    expect(stale, `exclusions that no longer declare --cursor: ${stale.join(", ")}`).toEqual([]);
    expect(NO_CURSOR_INPUT_ON_THE_ENDPOINT.size).toBe(0);
  });

  for (const node of nodes) {
    it(`${node.path.join(" ")}: --cursor "" / "  " exit 2; --cursor <value> reaches the request (same-path control)`, async () => {
      const argv = argvFor(node);

      for (const empty of ["", "   "]) {
        seen = [];
        const bad = await run([...argv, "--cursor", empty]);
        expect(bad.status, `stdout=${bad.stdout} stderr=${bad.stderr}`).toBe(2);
        expect(bad.stderr).toContain("--cursor");
      }

      seen = [];
      const good = await run([...argv, "--cursor", PROBE]);
      expect(good.status, `stdout=${good.stdout} stderr=${good.stderr}`).toBe(0);
      expect(
        seen.some((s) => s.includes(PROBE)),
        `no request carried the cursor; requests were ${JSON.stringify(seen)}`,
      ).toBe(true);
    });
  }
});
