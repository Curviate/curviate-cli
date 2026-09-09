/**
 * End-to-end proof, against the built bin, for the `--beta` global flag.
 *
 * ## Why this is a bin-level test and not only a unit test
 *
 * `test/lib/beta.test.ts` proves the parser and the header builder in
 * isolation. Neither can see the two things that actually matter to a caller:
 *
 *   1. That the flag SURVIVES DISPATCH. It is stripped from the arguments
 *      before citty parses them, so a wiring mistake would either lose the
 *      header silently (the request goes out with the workspace default and
 *      the operator believes they overrode it) or leave the token in place,
 *      where citty pushes its value into positionals and the command refuses
 *      a perfectly good invocation. Both are invisible to a unit test.
 *   2. That an invalid value is a REFUSAL, with no request. citty reads
 *      `--beta=maybe` as `true`, so the failure mode being guarded is an
 *      accidental opt-IN: the call goes out consenting to beta on the
 *      strength of a typo. Asserting the exit code alone would not catch that
 *      -- a build that consented AND exited 2 afterwards would pass -- so the
 *      recorded request list is the real assertion.
 *
 * Exit codes are read unpiped, off the child's own status, for the reason
 * `leaf-extras-bin.test.ts` documents.
 *
 * Build prerequisite: the helper rebuilds `dist/` whenever `src/` is newer, so
 * a red-then-green cycle cannot be measuring a stale artifact.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { ensureFreshBuild } from "./helpers/built-cli.js";

interface Recorded {
  method: string;
  url: string;
  /** Lower-cased header names, as the server received them. */
  headers: Record<string, string>;
}

let cliPath: string;
let server: Server;
let baseUrl: string;
let recorded: Recorded[] = [];

beforeAll(async () => {
  cliPath = ensureFreshBuild();
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : String(v ?? "");
      }
      recorded.push({ method: req.method ?? "", url: req.url ?? "", headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "account_list", items: [], cursor: null }));
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

function run(args: string[]): Promise<RunResult> {
  recorded = [];
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
          CURVIATE_API_KEY: "rdc_live_beta_flag_test_stub",
        },
      },
      (_err, stdout, stderr) => {
        resolvePromise({
          status: child.exitCode,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          requests: [...recorded],
        });
      },
    );
    child.stdin?.end();
  });
}

const HEADER = "x-curviate-beta";

describe("built bin — --beta sets the consent header for one invocation", () => {
  it("no flag sends no header, and the call still works", async () => {
    const r = await run(["account", "list", "--json"]);
    expect(r.status).toBe(0);
    expect(r.requests).toHaveLength(1);
    // POSITIVE CONTROL for every absence claim in this file: the request
    // really was made and really did carry headers, so a missing beta header
    // means absent rather than "nothing was recorded".
    expect(r.requests[0]!.headers["authorization"]).toBe(
      "Bearer rdc_live_beta_flag_test_stub",
    );
    expect(r.requests[0]!.headers[HEADER]).toBeUndefined();
  });

  it("--beta sends true", async () => {
    const r = await run(["--beta", "account", "list", "--json"]);
    expect(r.status).toBe(0);
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0]!.headers[HEADER]).toBe("true");
    // The credential survived the header merge.
    expect(r.requests[0]!.headers["authorization"]).toBe(
      "Bearer rdc_live_beta_flag_test_stub",
    );
  });

  it("--beta=true sends true", async () => {
    const r = await run(["account", "list", "--beta=true", "--json"]);
    expect(r.status).toBe(0);
    expect(r.requests[0]!.headers[HEADER]).toBe("true");
  });

  it("--beta=false sends false, which is a real override and not a no-op", async () => {
    const r = await run(["account", "list", "--beta=false", "--json"]);
    expect(r.status).toBe(0);
    expect(r.requests).toHaveLength(1);
    // The distinction the three-state design exists for: absent (test above)
    // sends nothing, false sends "false".
    expect(r.requests[0]!.headers[HEADER]).toBe("false");
  });

  it("works before the command keyword as well as after it", async () => {
    // The dispatcher strips the token before routing, so a flag preceding the
    // command must not stop `account` from being found.
    const before = await run(["--beta", "account", "list", "--json"]);
    const after = await run(["account", "list", "--beta", "--json"]);
    expect(before.status).toBe(0);
    expect(after.status).toBe(0);
    expect(before.requests[0]!.headers[HEADER]).toBe("true");
    expect(after.requests[0]!.headers[HEADER]).toBe("true");
  });

  it("persists nothing: the next invocation sends no header again", async () => {
    // One flag, one invocation. If this ever wrote a profile or config entry,
    // a single `--beta` would silently consent for every later call.
    const first = await run(["--beta", "account", "list", "--json"]);
    expect(first.requests[0]!.headers[HEADER]).toBe("true");
    const second = await run(["account", "list", "--json"]);
    expect(second.requests[0]!.headers[HEADER]).toBeUndefined();
  });
});

describe("built bin — an invalid --beta value refuses without calling the API", () => {
  it.each(["maybe", "2", "yep", ""])("--beta=%s exits 2 and issues no request", async (token) => {
    const r = await run(["account", "list", `--beta=${token}`, "--json"]);
    // THE assertion. citty would have read this as `true`, so a build that
    // consented and then complained would satisfy an exit-code-only check.
    expect(r.requests).toEqual([]);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("--beta must be one of");
    expect(r.status).toBe(2);
  });

  it("--no-beta=<value> exits 2 and issues no request", async () => {
    const r = await run(["account", "list", "--no-beta=true", "--json"]);
    expect(r.requests).toEqual([]);
    expect(r.stderr).toContain("--no-beta takes no value");
    expect(r.status).toBe(2);
  });

  it("--version still works behind --beta", async () => {
    // The fast path is gated on the argument COUNT, and reading the count
    // before the beta strip made `--beta --version` fall through to routing.
    //
    // Spawned WITHOUT the shared helper on purpose: it appends `--base-url`,
    // which changes the very count this case is about. A first attempt used
    // `run()` and failed with exit 2 — the helper's argument, not the CLI's
    // behaviour, which is worth knowing before reading a red here.
    const bare = (args: string[]): Promise<{ status: number | null; stdout: string }> =>
      new Promise((res) => {
        const child = execFile(
          process.execPath,
          [cliPath, ...args],
          { encoding: "utf8", timeout: 15_000 },
          (_e, stdout) => res({ status: child.exitCode, stdout: stdout ?? "" }),
        );
        child.stdin?.end();
      });

    const withFlag = await bare(["--beta", "--version"]);
    expect(withFlag.status).toBe(0);
    expect(withFlag.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    // Control: the plain form agrees, so the assertion is about the flag being
    // transparent rather than about the version printer working at all.
    const plain = await bare(["--version"]);
    expect(plain.stdout.trim()).toBe(withFlag.stdout.trim());
  });

  it("still prints help rather than refusing, when --help is also present", async () => {
    // Help sends no request, so a bad flag value cannot matter there, and
    // refusing would hide the very text that explains the flag's grammar.
    const r = await run(["account", "list", "--beta=maybe", "--help"]);
    expect(r.requests).toEqual([]);
    expect(r.status).toBe(0);
  });

  // NOT ASSERTED HERE: that `--help` NAMES the flag.
  //
  // It does (`curviate account list --help` renders the `--beta` row), but it
  // cannot be checked from a spawned child in this suite: citty's help path
  // exits before its write to stdout is flushed, and under vitest's spawn that
  // race lands deterministically on the losing side. Measured, so the next
  // person does not re-derive it: `account list --help` returns status 0 with
  // stdout AND stderr both EMPTY when spawned from inside a vitest worker, and
  // the same command spawned from a plain node script returns 3493 bytes on
  // stdout. Nothing to do with this flag, and it predates it.
  //
  // The claim is covered in-process instead, where there is no stream to
  // flush: `test/lib/global-flags-invariant.test.ts` pins that every narrowed
  // global-flag set declares `beta`, and citty renders exactly the args a
  // command declares. If the lost-help behaviour is ever worth fixing, it is
  // its own change, and this comment is the reproduction.
});
