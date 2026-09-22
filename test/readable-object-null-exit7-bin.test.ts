/**
 * A single-object read's 2xx must be a readable object: `null`, a scalar, or
 * a bare array is no API answer for a single-resource read — a platform
 * fault, exit 7 (per the exit-code spec's As-built note), never a silent
 * exit 0 (e.g. `company x1` with a `null` body, the reported bug).
 *
 * The read surface is discovered from the live command tree
 * (`discoverReadableObjectNodes`), never a hand-written list, so a new
 * single-object read is covered automatically and none of them can silently
 * skip the guard.
 *
 * Positive control, same path: the identical command against a server that
 * DOES return a real object exits 0 — proving the guard fires on the bad
 * body specifically, not on the command in general. `--verbose` is added to
 * every argv so the control response bypasses each command's own slim
 * projector (which may assume fields a minimal fixture object doesn't carry)
 * — the guard under test runs before any projection either way, so this
 * cannot mask a guard that failed to fire.
 *
 * `null` and a valid object are swept across EVERY discovered node — this is
 * what proves each call site is actually WIRED (not just that the guard
 * function works, which `test/lib/paginate.test.ts` already covers
 * exhaustively for null/scalar/array/valid in-process, no process spawn).
 * Scalar and array are spot-checked on one representative node only: the
 * guard's `isPlainObject` check treats every non-object shape identically,
 * so a second and third process-spawn per node here would re-prove the same
 * function-level fact 29 more times at real CI wall-clock cost for no added
 * assurance (code-review finding, follow-up trim).
 *
 * A companion regression at the bottom: a WRITE that gets a genuine `204`
 * (null body) must keep exiting 0 — `renderSuccess` is shared between reads
 * and writes, and only a read's call site passes its result through
 * `readableObject`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliPath } from "./helpers/built-cli.js";
import { discoverReadableObjectNodes, argvForRead } from "./helpers/read-guard-nodes.js";

const xdg = mkdtempSync(join(tmpdir(), "curviate-readable-object-"));

function run(args: string[], baseUrl: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
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

/** A server that returns the same 2xx JSON body (or 204 empty) for every request. */
async function bodyServer(body: string | null): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (body === null) {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { server, baseUrl };
}

let nullSrv: { server: Server; baseUrl: string };
let scalarSrv: { server: Server; baseUrl: string };
let arraySrv: { server: Server; baseUrl: string };
let objectSrv: { server: Server; baseUrl: string };
let emptySrv: { server: Server; baseUrl: string };

beforeAll(async () => {
  nullSrv = await bodyServer("null");
  scalarSrv = await bodyServer('"a string"');
  arraySrv = await bodyServer("[]");
  objectSrv = await bodyServer(JSON.stringify({ id: "ok_1", name: "ok" }));
  emptySrv = await bodyServer(null); // genuine 204, empty body -> the SDK reads this as null.
});

afterAll(async () => {
  await Promise.all(
    [nullSrv, scalarSrv, arraySrv, objectSrv, emptySrv].map(
      ({ server }) => new Promise<void>((r) => server.close(() => r())),
    ),
  );
});

describe("single-object reads: null/scalar/array bodies are exit 7, same guard as readablePage", async () => {
  const nodes = await discoverReadableObjectNodes();

  it("the sweep covers the single-object read surface", () => {
    expect(nodes.length).toBeGreaterThanOrEqual(20);
  });

  for (const [i, node] of nodes.entries()) {
    const path = node.path.join(" ");
    const argv = [...argvForRead(node), "--verbose"];

    it(`${path}: a null body exits 7`, async () => {
      const bad = await run(argv, nullSrv.baseUrl);
      expect(bad.status, `stdout=${bad.stdout} stderr=${bad.stderr}`).toBe(7);
    });

    it(`${path}: a valid object body exits 0 (same-path positive control)`, async () => {
      const good = await run(argv, objectSrv.baseUrl);
      expect(good.status, `stdout=${good.stdout} stderr=${good.stderr}`).toBe(0);
    });

    // Scalar/array: representative spot-check on the first node only (see
    // module doc). isPlainObject rejects null/scalar/array identically, so
    // this proves the wiring generalizes across shapes without re-spawning
    // a process per shape per node.
    if (i === 0) {
      it(`${path}: a scalar body exits 7 (representative spot-check)`, async () => {
        const bad = await run(argv, scalarSrv.baseUrl);
        expect(bad.status, `stdout=${bad.stdout} stderr=${bad.stderr}`).toBe(7);
      });

      it(`${path}: an array body exits 7 (representative spot-check)`, async () => {
        const bad = await run(argv, arraySrv.baseUrl);
        expect(bad.status, `stdout=${bad.stdout} stderr=${bad.stderr}`).toBe(7);
      });
    }
  }
});

describe("writes keep rendering a null 204 body: renderSuccess is shared, only a READ's call site adds readableObject", () => {
  it("comment delete: a genuine 204 (empty body, decodes to null) still exits 0", async () => {
    const result = await run(
      ["comment", "delete", "1", "1", "--verbose"],
      emptySrv.baseUrl,
    );
    expect(result.status, `stdout=${result.stdout} stderr=${result.stderr}`).toBe(0);
  });
});
