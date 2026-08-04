/**
 * `curviate login --api-key -` end to end through the real bin.
 *
 * ## The defect this test exists for
 *
 * The dispatcher rewrites every bare `-` in the leaf argument list to the
 * internal stdin sentinel before citty/mri parses argv, because mri silently
 * swallows a bare `-`. `login` tested only `apiKey === "-"`, so in the real
 * binary the comparison never matched: the sentinel fell through and was
 * written into the config file as if the user had typed it. The shipped 0.20.0
 * therefore answered `login --api-key -` with "Saved to profile" and exit 0,
 * and then failed every later command with "Invalid or revoked API key" —
 * blaming the user's credentials for a fault the CLI created.
 *
 * ## Why this test spawns the built bin
 *
 * The correct behaviour was already required and already believed covered, and
 * the defect still shipped, because the only way to reach it is through
 * `dispatch.ts`'s argv preprocessing. Calling
 * `loginCommand.run({ args: { "api-key": "-" } })`
 * injects a literal dash the real binary never produces, so the handler takes a
 * branch that cannot execute in production and reports a pass. Asserting on the
 * built artifact as a child process is the only assertion that means anything
 * here.
 *
 * ## Why both assertions are needed
 *
 * "A key was written" passes on the defect — the sentinel IS a key-shaped
 * string. So the first test asserts the exact value AND explicitly that it is
 * not the sentinel. The second proves the stored value is *usable*, not merely
 * present, by reading the `Authorization` header off a stubbed API.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliPath } from "../helpers/built-cli.js";
import { STDIN_SENTINEL } from "../../src/lib/stdin.js";

/** The value piped on stdin. Distinctive so it cannot collide with a fixture. */
const KEY = "cvt_live_REALVALUE";

let xdgHome: string;
let configPath: string;
let server: Server;
let baseUrl: string;
let loginRun: CliRun;
const authHeaders: string[] = [];

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the built bin asynchronously.
 *
 * `spawnSync` cannot be used for any run that must reach the stub server:
 * it blocks the parent's event loop, so the in-process HTTP server never gets
 * to accept the child's connection and both sides wait until the timeout.
 */
function runCli(args: string[], input: string): Promise<CliRun> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env: cleanEnv() });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

/**
 * A clean environment: none of the CURVIATE_* overrides may be inherited from
 * the developer's shell. `CURVIATE_API_KEY` in particular would satisfy the
 * second test without the profile ever being read, turning it green on the
 * defect.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: xdgHome,
    NODE_ENV: "production",
  };
  delete env["CURVIATE_API_KEY"];
  delete env["CURVIATE_ACCOUNT"];
  delete env["CURVIATE_BASE_URL"];
  return env;
}

beforeAll(async () => {
  xdgHome = mkdtempSync(join(tmpdir(), "curviate-login-stdin-"));
  configPath = join(xdgHome, "curviate", "config.json");

  server = createServer((req, res) => {
    authHeaders.push(String(req.headers["authorization"] ?? ""));
    // Attach the listener before the stream can drain: on a bodyless GET the
    // "end" event fires in the same tick, so resuming first loses it and the
    // response is never written (the child then blocks until its timeout).
    req.setEncoding("utf8");
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [], has_more: false }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  // The scenario's first action: pipe the key, pass `-`, write to profile `t`.
  loginRun = await runCli(["login", "--api-key", "-", "--profile", "t"], KEY);
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("login --api-key - through the built bin", () => {
  it("persists the piped key verbatim, never the stdin sentinel", () => {
    expect(loginRun.status).toBe(0);

    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      profiles: Record<string, { apiKey?: string }>;
    };
    const stored = config.profiles["t"]?.apiKey;

    // The regression, stated directly: the sentinel must never be persisted.
    // Asserting only "a key was written" passes on the defect.
    expect(stored).not.toBe(STDIN_SENTINEL);
    expect(stored).toBe(KEY);
  });

  it("the persisted key is usable: the next command sends Bearer <key>", async () => {
    const run = await runCli(
      ["account", "list", "--profile", "t", "--base-url", baseUrl, "--json"],
      "",
    );

    expect(authHeaders.length).toBeGreaterThan(0);
    expect(authHeaders[0]).toBe(`Bearer ${KEY}`);
    // Belt and braces: the sentinel must not reach the wire under any spelling.
    expect(authHeaders.join("\n")).not.toContain(STDIN_SENTINEL);
    expect(run.status).toBe(0);
  });
});
