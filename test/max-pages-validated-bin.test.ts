/**
 * `--max-pages` is a positive integer or a usage error.
 *
 * Every streaming command parsed it with a bare `parseInt(...)`, so
 * `--max-pages abc` produced `NaN`, `pageCount >= NaN` is always false, and
 * the walk that was asked to stop after a few pages ran unbounded instead —
 * the opposite of what was typed, with exit 0 at the end of it.
 * `--max-pages 0` and `--max-pages -1` are equally meaningless: neither can
 * ever be a page budget.
 *
 * The surface is discovered from the live command tree
 * (`discoverStreamingNodes`), never a hand-written list.
 *
 * Positive control, SAME PATH: the identical argv with `--max-pages 2` still
 * streams and exits 0, so the refusal is pinned to the value, not to the
 * flag or the command.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliPath } from "./helpers/built-cli.js";
import { discoverStreamingNodes, argvFor, type Node } from "./helpers/streaming-nodes.js";

const xdg = mkdtempSync(join(tmpdir(), "curviate-max-pages-"));

/** Written as `--max-pages=<v>` so a leading `-` is a value, not the next flag. */
const REJECTED = ["abc", "0", "-1", "2.5", ""];

let server: Server;
let baseUrl: string;
let requests = 0;

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
    requests++;
    req.resume();
    req.on("end", () => {
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

describe("--max-pages must be a positive integer", async () => {
  const nodes: Node[] = await discoverStreamingNodes();

  it("the sweep covers the streaming surface", () => {
    expect(nodes.length).toBeGreaterThan(50);
  });

  for (const node of nodes) {
    it(`${node.path.join(" ")}: a non-positive-integer --max-pages exits 2; --max-pages 2 still streams (same-path control)`, async () => {
      const argv = argvFor(node);

      for (const value of REJECTED) {
        const bad = await run([...argv, "--all", `--max-pages=${value}`, "--page-delay", "0"]);
        expect(bad.status, `--max-pages=${value}: stdout=${bad.stdout} stderr=${bad.stderr}`).toBe(2);
        expect(bad.stderr).toContain("--max-pages");
      }

      requests = 0;
      const good = await run([...argv, "--all", "--max-pages=2", "--page-delay", "0"]);
      expect(good.status, `stdout=${good.stdout} stderr=${good.stderr}`).toBe(0);
      expect(requests).toBeGreaterThan(0);
    });
  }
});
