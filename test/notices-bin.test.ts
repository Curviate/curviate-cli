/**
 * End-to-end proof, through the built bin, that a notice on a command whose
 * slim projector rebuilds its envelope still reaches the caller.
 *
 * `account list` and `connect sent` / `connect received` project their
 * response through an allowlist that never carried `notices`, so the array was
 * destroyed before the renderer could surface it. A unit test on the renderer
 * alone would have passed against that build, because the renderer was never
 * the layer at fault.
 *
 * The server here returns a shape the real API can return: a list envelope
 * with items AND a page-scoped notice, so the assertion is that the notice
 * accompanies results rather than only explaining an empty page.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { ensureFreshBuild } from "./helpers/built-cli.js";

const NOTICE = {
  code: "SOME_RESULTS_HIDDEN",
  message: "some entries on this page were not disclosed to the connected account",
};

let cliPath: string;
let server: Server;
let baseUrl: string;
let body: Record<string, unknown> = {};

beforeAll(async () => {
  cliPath = ensureFreshBuild();
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function run(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      process.execPath,
      [cliPath, ...args, "--base-url", baseUrl],
      {
        encoding: "utf8",
        timeout: 15_000,
        env: {
          ...process.env,
          NODE_ENV: "production",
          CURVIATE_API_KEY: "rdc_live_notices_test_stub",
        },
      },
      (_err, stdout, stderr) =>
        resolvePromise({ status: child.exitCode, stdout: stdout ?? "", stderr: stderr ?? "" }),
    );
    child.stdin?.end();
  });
}

describe("built bin — a notice survives a command's slim projector", () => {
  it("`account list` surfaces notices[] alongside its items", async () => {
    body = {
      object: "account_list",
      items: [
        {
          account_id: "acc_1",
          status: "active",
          auth_method: "credentials",
          full_name: "Test Person",
        },
      ],
      cursor: null,
      notices: [NOTICE],
    };
    const r = await run(["account", "list", "--json"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(parsed["notices"]).toEqual([NOTICE]);
    // The slim projection still applies to the items themselves.
    expect(Array.isArray(parsed["items"])).toBe(true);
  });

  it("`account list --fields account_id` keeps the notice while projecting items", async () => {
    body = {
      object: "account_list",
      items: [{ account_id: "acc_1", status: "active", full_name: "Test Person" }],
      cursor: null,
      notices: [NOTICE],
    };
    const r = await run(["account", "list", "--fields", "account_id", "--json"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(parsed["notices"]).toEqual([NOTICE]);
    expect(parsed["items"]).toEqual([{ account_id: "acc_1" }]);
  });

  it("`account list` with no notices emits no notice key at all", async () => {
    body = {
      object: "account_list",
      items: [{ account_id: "acc_1", status: "active" }],
      cursor: null,
    };
    const r = await run(["account", "list", "--json"]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("notices");
    expect(r.stderr).not.toContain("notice [");
  });
});
