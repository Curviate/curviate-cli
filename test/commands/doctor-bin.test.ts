/**
 * `curviate doctor` through the BUILT bin.
 *
 * ## Why this file exists
 *
 * Its sibling `doctor.test.ts` injects every seam, including `version`. That
 * makes nine green tests against a command that could not run at all: the
 * real version reader resolved `package.json` relative to `src/commands/`,
 * which is not where the bundled chunk lives, so the shipped binary died with
 * `Cannot find module '../../package.json'` on every invocation.
 *
 * An injected seam cannot fail in the direction that matters when the thing
 * under test IS the seam's default. So this arm injects nothing: it runs the
 * artifact a user runs, against a stub API, and reads the exit code and the
 * emitted object.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cliPath, pkgRoot } from "../helpers/built-cli.js";

const PROFILE_KEY = "rdc_live_DOCTORBIN_PROFILE";
const ENV_KEY = "rdc_live_DOCTORBIN_ENV";
const LOGIN_ONLY_KEY = "rdc_live_DOCTORBIN_LOGINONLY";

let xdg: string;
let server: Server;
let baseUrl: string;

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<Run> {
  return new Promise((resolvePromise, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_CONFIG_HOME: xdg,
      NODE_ENV: "production",
      ...extraEnv,
    };
    delete env["CURVIATE_ACCOUNT"];
    delete env["CURVIATE_BASE_URL"];
    if (extraEnv["CURVIATE_API_KEY"] === undefined) delete env["CURVIATE_API_KEY"];

    const child = spawn(process.execPath, [cliPath, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
    child.stdin.end("");
  });
}

/**
 * Run the built bin with stdout reporting itself as a terminal, so the human
 * render is reachable.
 *
 * A tiny wrapper module rather than a pseudo-terminal: `process.stdout.isTTY`
 * is a writable property, so setting it before importing the real bin
 * exercises the shipped artifact's human branch in a real child process,
 * with no platform-specific `script`/pty invocation to go stale.
 */
function runCliOnATerminal(args: string[]): Promise<Run> {
  const wrapper = join(xdg, "tty-wrapper.mjs");
  writeFileSync(
    wrapper,
    `process.stdout.isTTY = true;\nawait import(${JSON.stringify(pathToFileURL(cliPath).href)});\n`,
  );
  return new Promise((resolvePromise, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_CONFIG_HOME: xdg,
      NODE_ENV: "production",
    };
    delete env["CURVIATE_API_KEY"];
    delete env["CURVIATE_ACCOUNT"];
    delete env["CURVIATE_BASE_URL"];

    const child = spawn(process.execPath, [wrapper, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
    child.stdin.end("");
  });
}

beforeAll(async () => {
  xdg = mkdtempSync(join(tmpdir(), "curviate-doctor-bin-"));
  mkdirSync(join(xdg, "curviate"), { recursive: true });

  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: [{ id: "acc_bin", status: "OK" }], cursor: null }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  writeFileSync(
    join(xdg, "curviate", "config.json"),
    JSON.stringify({
      active: "default",
      profiles: {
        default: { apiKey: PROFILE_KEY, baseUrl, tenant: "Profile Workspace" },
        // Exactly what `login` writes: a key, and no `tenant` key at all.
        loginonly: { apiKey: LOGIN_ONLY_KEY, baseUrl },
      },
    }),
    { mode: 0o600 },
  );
}, 120_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("doctor runs at all", () => {
  it("exits 0 and emits a report, with no module-resolution failure", async () => {
    const run = await runCli(["doctor", "--json"]);

    expect(run.stderr).not.toMatch(/Cannot find module/);
    expect(run.status, run.stderr).toBe(0);

    const report = JSON.parse(run.stdout.trim()) as Record<string, unknown>;
    expect(report["credential_resolved"]).toBe(true);
    expect(report["api_reachable"]).toBe(true);
    expect(report["accounts"]).toEqual([{ account_id: "acc_bin", status: "OK" }]);
  });

  it("reports this package's real version, not a stub or a placeholder", async () => {
    const declared = (
      JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf8")) as { version: string }
    ).version;
    const run = await runCli(["doctor", "--json"]);
    const report = JSON.parse(run.stdout.trim()) as { version: string };

    expect(report.version).toBe(declared);
  });

  it("never prints the credential value", async () => {
    const run = await runCli(["doctor", "--json"]);
    expect(run.stdout + run.stderr).not.toContain(PROFILE_KEY);
  });
});

describe("the workspace reported belongs to the key that actually resolved", () => {
  it("a profile-tier credential reports the profile's workspace", async () => {
    const run = await runCli(["doctor", "--json"]);
    const report = JSON.parse(run.stdout.trim()) as Record<string, unknown>;
    expect(report["credential_source"]).toBe("profile");
    expect(report["tenant"]).toBe("Profile Workspace");
  });

  it("an environment credential reports no workspace, never the profile's", async () => {
    const run = await runCli(["doctor", "--json", "--base-url", baseUrl], {
      CURVIATE_API_KEY: ENV_KEY,
    });
    const report = JSON.parse(run.stdout.trim()) as Record<string, unknown>;

    expect(report["credential_source"]).toBe("env");
    // The profile's workspace belongs to a DIFFERENT key. Naming it here
    // would be worse than naming nothing.
    expect(report["tenant"]).toBeNull();
    expect(run.stdout).not.toContain("Profile Workspace");
  });

  it("a flag credential reports no workspace either", async () => {
    const run = await runCli([
      "doctor",
      "--json",
      "--base-url",
      baseUrl,
      "--api-key",
      "rdc_live_DOCTORBIN_FLAG",
    ]);
    const report = JSON.parse(run.stdout.trim()) as Record<string, unknown>;
    expect(report["credential_source"]).toBe("flag");
    expect(report["tenant"]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The workspace field is always emitted, explicitly unknown
// ---------------------------------------------------------------------------

/**
 * A `--json` consumer must never have to tell "unknown" from "absent" by a
 * missing key: a dropped field reads as an unhealthy credential to an agent
 * branching on the report.
 *
 * The sibling seam suite already covers this case, and cannot cover this
 * clause: it asserts the in-memory object, where `null` and a key removed at
 * serialisation time are indistinguishable. The claim is about the bytes, so
 * this arm reads the bytes.
 */
describe("a login-written profile still reports its workspace, as unknown", () => {
  it("emits the key, with a null value, on the wire", async () => {
    const run = await runCli(["doctor", "--json", "--profile", "loginonly"]);

    expect(run.status, run.stderr).toBe(0);
    const report = JSON.parse(run.stdout.trim()) as Record<string, unknown>;

    // Presence asserted DIRECTLY, not inferred from the value. The clause is
    // about the key being in the serialised stream, and a value-based check
    // couples that guarantee to the choice of matcher: a later move to
    // `toBeFalsy()`, or a `?? "unknown"` default in the renderer, would stop
    // testing presence while still passing. (A strict `toBeNull()` does fail
    // on an absent key today; that is a property of the matcher, not of the
    // requirement, which is exactly why it is not what this leans on.)
    expect(
      Object.prototype.hasOwnProperty.call(report, "tenant"),
      `the workspace field was dropped from the stream: ${run.stdout.trim()}`,
    ).toBe(true);
    expect(report["tenant"]).toBeNull();
  });

  it("and every other check still passes, so this is not an unhealthy report", async () => {
    const run = await runCli(["doctor", "--json", "--profile", "loginonly"]);
    const report = JSON.parse(run.stdout.trim()) as {
      ok: boolean;
      exit: number;
      credential_source: string;
      checks: Array<{ name: string; ok: boolean }>;
    };

    expect(report.ok).toBe(true);
    expect(report.exit).toBe(0);
    expect(report.credential_source).toBe("profile");
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it("names it unknown in human mode rather than printing an empty value", async () => {
    const run = await runCliOnATerminal(["doctor", "--profile", "loginonly"]);

    expect(run.status, run.stderr).toBe(0);
    const line = run.stdout.split("\n").find((l) => l.startsWith("workspace"));
    expect(line, `no workspace line in:\n${run.stdout}`).toBeDefined();
    expect(line).toMatch(/unknown/);
    // Not a label with nothing after it, which is what a dropped value looks
    // like to a human reading the render.
    expect(line!.replace(/^workspace\s*/, "").trim().length).toBeGreaterThan(0);
  });
});
