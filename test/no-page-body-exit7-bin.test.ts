/**
 * A plain (non-`--all`) read on a streaming command must apply the same
 * `readablePage` guard the `--all` stream already applies: a 2xx body that is
 * not a page (here, `null` — the exact shape from the reported bug, `company
 * posts x1` with a null body) is a platform fault, exit 7 — never a silent
 * exit 0: "on every path that reads one", the same rule the `--all` streams
 * already follow.
 *
 * The streaming surface is discovered from the live command tree
 * (`discoverStreamingNodes`), never a hand-written list, so a new streaming
 * command is covered automatically and none of them can silently skip the
 * guard.
 *
 * Positive control, same path: the identical command against a server that
 * DOES return a real page exits 0 — proving the guard fires on the bad body
 * specifically, not on the command in general.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliPath } from "./helpers/built-cli.js";
import { discoverStreamingNodes, argvFor, type Node } from "./helpers/streaming-nodes.js";

const xdg = mkdtempSync(join(tmpdir(), "curviate-no-page-body-"));

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

let nullServer: Server;
let nullBaseUrl: string;
let pageServer: Server;
let pageBaseUrl: string;

beforeAll(async () => {
  // Every response is a syntactically valid JSON `null` — the exact shape
  // the transport layer cannot catch (it is not an unreadable 5xx/non-JSON
  // body, see lib/client.ts's platformFaultIfUnreadable): a real 2xx whose
  // decoded value is simply not a page.
  nullServer = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("null");
    });
  });
  await new Promise<void>((r) => nullServer.listen(0, r));
  nullBaseUrl = `http://127.0.0.1:${(nullServer.address() as { port: number }).port}`;

  pageServer = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", id: "ACoAAB1234", items: [], cursor: null }));
    });
  });
  await new Promise<void>((r) => pageServer.listen(0, r));
  pageBaseUrl = `http://127.0.0.1:${(pageServer.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => nullServer.close(() => r()));
  await new Promise<void>((r) => pageServer.close(() => r()));
});

describe("plain (non---all) streaming reads: a null body is exit 7, same guard as --all", async () => {
  const nodes: Node[] = await discoverStreamingNodes();

  it("the sweep covers the streaming surface", () => {
    expect(nodes.length).toBeGreaterThan(50);
  });

  for (const node of nodes) {
    it(`${node.path.join(" ")}: a null body exits 7 (bad); a real page exits 0 (same-path control)`, async () => {
      const argv = argvFor(node);
      const bad = await run(argv, nullBaseUrl);
      expect(bad.status, `stdout=${bad.stdout} stderr=${bad.stderr}`).toBe(7);

      const good = await run(argv, pageBaseUrl);
      expect(good.status, `stdout=${good.stdout} stderr=${good.stderr}`).toBe(0);
    });
  }
});
