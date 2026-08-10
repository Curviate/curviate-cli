/**
 * The two named acceptance criteria for the consumed-token-blindness fix,
 * proven against a captured OUTBOUND
 * HTTP REQUEST, never against stdout: stdout can look identical for two
 * requests that differ (or differ for two that are identical), so it is not
 * evidence of what actually reached the wire. A local HTTP stub server
 * standing in for the API IS that evidence: it is the one place the actual
 * `authorization` header and request line are observable, and it is exactly
 * what `guardedFetch` (src/lib/client.ts) sends every request through.
 *
 * 1. `curviate --api-key <key> account list` must behave IDENTICALLY to
 *    `curviate account list --api-key <key>`: both invocations captured, the
 *    two requests asserted structurally equal (method, path, authorization).
 * 2. A flag value beginning with "-" is accepted as a value: the captured
 *    `authorization` header carries the dash-prefixed key VERBATIM.
 *
 * MUST be the async `execFile`, never `execFileSync`/`spawnSync` — a sync
 * child_process call blocks this process's event loop until the child exits,
 * and the stub server lives in this same process, so it could never answer a
 * request that is meanwhile blocking the very loop that would service it.
 * See test/readme-examples-execute.test.ts's identical note for the
 * originally-discovered version of this footgun.
 *
 * Mutation proof (why these specific cases, and that they are not vacuous):
 * reverting src/dispatch.ts to its state before this fix (git stash) and re-running
 * the fast companion suite, test/dispatch-token-consumption.test.ts, turns 9
 * of its 15 cases red, covering the same routing decision these two
 * end-to-end cases exercise; run manually before this file was written
 * (see the PR description for the transcript) because a live source-mutation
 * step inside a vitest run has no established pattern in this codebase
 * (existing "mutation-proven" suites, e.g. check-clean-guard.test.ts, mutate
 * FIXTURE data, not dispatch.ts's own unexported internals) and would fight
 * test/global-setup.ts's single shared build.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { cliPath } from "./helpers/built-cli.js";

interface Captured {
  method: string;
  url: string;
  authorization: string | undefined;
}

let server: Server;
let baseUrl: string;
let captured: Captured | undefined;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      captured = { method: req.method ?? "", url: req.url ?? "", authorization: req.headers["authorization"] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: [], cursor: null }));
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, resolvePromise));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
});

/** Run the built CLI against the local stub and return what it captured. */
function runAndCapture(args: string[]): Promise<Captured> {
  captured = undefined;
  return new Promise((resolvePromise, reject) => {
    execFile(
      process.execPath,
      [cliPath, ...args, "--base-url", baseUrl],
      {
        encoding: "utf8",
        timeout: 15_000,
        // CURVIATE_API_KEY pinned to a placeholder, hermetic against a stored
        // ~/.config/curviate/ profile on the machine running this suite: every
        // case here always passes an explicit --api-key, which outranks both,
        // but a REGRESSED build's failure mode should be an honest routing/
        // usage error, not a confusing mismatch against whatever profile
        // happens to be logged in on this host.
        env: { ...process.env, NODE_ENV: "production", CURVIATE_API_KEY: "cvt_test_hermetic_placeholder" },
      },
      (err, stdout, stderr) => {
        if (captured) {
          resolvePromise(captured);
          return;
        }
        // No request ever reached the stub — a routing/usage error, not the
        // network failure this suite exists to distinguish from a real
        // capture. Surface the CLI's own diagnostic so a regression is
        // legible without re-running by hand.
        reject(
          new Error(
            `no request captured for ${JSON.stringify(args)} (exit ${err?.code ?? 0})\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
          ),
        );
      },
    );
  });
}

describe("AC1 — global-flag-before-subcommand is IDENTICAL to flag-after-subcommand, on the wire", () => {
  it("curviate --api-key <key> account list == curviate account list --api-key <key>", async () => {
    const before = await runAndCapture(["--api-key", "cvt_fixture_flag_placement", "account", "list"]);
    const after = await runAndCapture(["account", "list", "--api-key", "cvt_fixture_flag_placement"]);

    expect(before).toEqual(after);
    // Pin the actual shape too, so a change in EITHER invocation that keeps
    // them equal to each other (e.g. both silently losing the key) still
    // fails loudly instead of passing on a degenerate agreement.
    expect(before).toEqual({
      method: "GET",
      url: "/v1/accounts",
      authorization: "Bearer cvt_fixture_flag_placement",
    });
  });

  it("a global flag before a NESTED subcommand (two descent steps) is also identical on the wire", async () => {
    // account checkpoint solve is two levels deep (account -> checkpoint ->
    // solve); the routing scan runs fresh at each level, so a flag placed
    // before the FIRST keyword must survive both descents unchanged, not
    // just the first.
    const before = await runAndCapture([
      "--api-key",
      "cvt_fixture_flag_nested",
      "account",
      "checkpoint",
      "solve",
      "acc_1",
      "--code",
      "123456",
    ]);
    const after = await runAndCapture([
      "account",
      "checkpoint",
      "solve",
      "acc_1",
      "--code",
      "123456",
      "--api-key",
      "cvt_fixture_flag_nested",
    ]);

    expect(before).toEqual(after);
    expect(before.authorization).toBe("Bearer cvt_fixture_flag_nested");
  });
});

describe("AC2 — a flag value beginning with \"-\" is accepted as a value, verbatim on the wire", () => {
  it("--api-key -fixture-dash-value reaches the Authorization header exactly, not decomposed or dropped", async () => {
    const got = await runAndCapture(["account", "list", "--api-key", "-fixture-dash-value"]);
    expect(got.authorization).toBe("Bearer -fixture-dash-value");
  });

  it("combined: a dash-prefixed value on a flag placed BEFORE the subcommand too", async () => {
    const got = await runAndCapture(["--api-key", "-fixture-dash-value", "account", "list"]);
    expect(got.authorization).toBe("Bearer -fixture-dash-value");
  });

  it("--limit -5 (a plausible negative-looking value, not just credentials) reaches the query string verbatim", async () => {
    const got = await runAndCapture(["account", "list", "--api-key", "cvt_fixture_flag_limit", "--limit", "-5"]);
    expect(got.url).toBe("/v1/accounts?limit=-5");
  });
});

describe("polarity — a flag NAME that only coincidentally follows another flag stays its own flag", () => {
  it("--limit --json (json is declared) splits into two flags, never becomes limit's literal value", async () => {
    // No network assertion needed here: if --json were wrongly swallowed as
    // limit's string value, --json would never take effect and the CLI
    // would print its default (non-JSON, human-oriented) rendering instead
    // of a JSON envelope, on an empty result set.
    const got = await runAndCapture(["account", "list", "--api-key", "cvt_fixture_flag_polarity", "--limit", "--json"]);
    expect(got.url).toBe("/v1/accounts"); // --limit got NO value (unchanged pre-existing behavior, out of this fix's scope)
  });
});
