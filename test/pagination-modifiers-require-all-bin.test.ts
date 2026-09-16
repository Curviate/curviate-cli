/**
 * `--max-pages`/`--page-delay` on a streaming command, without `--all`, used
 * to be accepted and silently do nothing — an agent has no way to tell its
 * request for bounded/paced streaming was ignored. Both now refuse before
 * any request: exit 2, zero requests.
 *
 * The streaming surface is discovered from the live command tree
 * (`discoverStreamingNodes`), never a hand-written list, so a new streaming
 * command is covered automatically and none of them can silently skip the
 * refusal.
 *
 * Positive control, same path: the identical command WITH `--all` (or with
 * neither modifier) sends its request — proving the refusal fires on the
 * missing `--all` specifically, not on the command in general.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliPath } from "./helpers/built-cli.js";
import { discoverStreamingNodes, argvFor, type Node } from "./helpers/streaming-nodes.js";

const xdg = mkdtempSync(join(tmpdir(), "curviate-pagination-modifiers-"));

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

describe("--max-pages/--page-delay without --all: exit 2, zero requests", async () => {
  const nodes: Node[] = await discoverStreamingNodes();

  it("the sweep covers the streaming surface", () => {
    expect(nodes.length).toBeGreaterThan(50);
  });

  for (const node of nodes) {
    it(`${node.path.join(" ")}: refused without --all; --all (or neither modifier) sends the request (same-path control)`, async () => {
      const argv = argvFor(node);

      for (const flag of [["--max-pages", "2"], ["--page-delay", "0"]]) {
        requests = 0;
        const bad = await run([...argv, ...flag]);
        expect(bad.status, `stdout=${bad.stdout} stderr=${bad.stderr}`).toBe(2);
        expect(bad.stderr).toContain(flag[0]!);
        expect(requests, "must send zero requests").toBe(0);
      }

      requests = 0;
      const withAll = await run([...argv, "--all", "--max-pages", "2", "--page-delay", "0"]);
      expect(withAll.status, `stdout=${withAll.stdout} stderr=${withAll.stderr}`).toBe(0);
      expect(requests).toBeGreaterThan(0);

      requests = 0;
      const plain = await run(argv);
      expect(plain.status, `stdout=${plain.stdout} stderr=${plain.stderr}`).toBe(0);
      expect(requests).toBeGreaterThan(0);
    });
  }
});
