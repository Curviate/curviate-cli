/**
 * End-to-end proof, against the built bin, that a resolved leaf refuses an
 * unconsumed positional instead of quietly answering a different question.
 *
 * ## Why the exit code alone is not the assertion
 *
 * The defect was not "the wrong exit code". It was that `profile me relations`
 * PERFORMED A READ, printed the caller's own profile object to stdout, and
 * exited 0 with an empty stderr. An agent reading `.items` on that object
 * found nothing and concluded the account had no connections.
 *
 * So each rejected case asserts all four channels: no request left the
 * machine, stdout is empty, stderr names the correct form, and the status is
 * 2. A test that checked only the status would have been satisfied by a build
 * that still fetched and still printed.
 *
 * ## Exit codes are read unpiped
 *
 * `child.exitCode` in the `execFile` callback is the process's own status.
 * Nothing is piped, so nothing can reset it. A shell pipeline would need
 * `${PIPESTATUS[0]}` read immediately, which any intervening command silently
 * clobbers, and that has already produced one false "exit 0" reading.
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
      recorded.push({ method: req.method ?? "", url: req.url ?? "" });
      res.writeHead(200, { "content-type": "application/json" });
      // A list envelope: shaped like what the correct form returns, so the
      // positive controls below exercise a realistic success path.
      res.end(JSON.stringify({ object: "relation_list", items: [], cursor: null }));
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
          CURVIATE_API_KEY: "rdc_live_leaf_extras_test_stub",
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

describe("built bin — a resolved leaf rejects an unconsumed positional", () => {
  const rejected: Array<[string, string[], string]> = [
    ["profile me relations", ["profile", "me", "relations"], "curviate profile relations"],
    [
      "profile me relations --limit 3 --json",
      ["profile", "me", "relations", "--limit", "3", "--json"],
      "curviate profile relations",
    ],
    ["profile me zzzz-not-a-command", ["profile", "me", "zzzz-not-a-command"], "curviate profile me"],
    [
      "profile me relations extra1 extra2",
      ["profile", "me", "relations", "extra1", "extra2"],
      "curviate profile me",
    ],
    ["account list zzz-extra", ["account", "list", "zzz-extra"], "curviate account list"],
    [
      "account checkpoint solve <id> zzz-extra",
      ["account", "checkpoint", "solve", "acc_1", "zzz-extra"],
      "curviate account checkpoint solve",
    ],
    ["company <id> managed", ["company", "1035", "managed"], "curviate company managed"],
  ];

  it.each(rejected)(
    "`%s` issues no request, prints nothing to stdout, and exits 2",
    async (_label, args, expectedInStderr) => {
      const r = await run(args);
      expect(r.requests).toEqual([]);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain(expectedInStderr);
      expect(r.status).toBe(2);
    },
  );
});

describe("built bin — the correct forms still work", () => {
  const accepted: Array<[string, string[]]> = [
    ["profile relations --limit 3 --json", ["profile", "relations", "--limit", "3", "--json"]],
    ["profile me --json", ["profile", "me", "--json"]],
    ["account list --json", ["account", "list", "--json"]],
    ["company employees 1035 --json", ["company", "employees", "1035", "--json"]],
    ["company 1035 employees --json", ["company", "1035", "employees", "--json"]],
  ];

  it.each(accepted)("`%s` issues exactly one request and exits 0", async (_label, args) => {
    const r = await run(args);
    expect(r.requests).toHaveLength(1);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("unexpected argument");
  });
});
