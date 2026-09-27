/**
 * `--cursor`/`--limit` are declared only where the served endpoint accepts
 * them. Every command below is verified against the pinned SDK's generated
 * OpenAPI types (`node_modules/@curviate/sdk/dist/index.d.ts`, the same
 * "served document" `test/fixtures/openapi.json` mirrors) to take neither a
 * `cursor` nor a `limit` query parameter (`parameters: { query?: never }`,
 * or, for `recruiter search parameters`, a `limit`/`offset` pair with no
 * `cursor` at all) — yet the CLI used to spread `NON_STREAM_FLAGS`
 * (`--cursor` + `--limit`, no `--all`) into their args, advertising a flag
 * the wire cannot honour.
 *
 * `recruiter applicants` is the one entry NOT named in the issue that filed
 * this ticket (curviate-cli#66's derivation missed it): its backing endpoint
 * (`POST .../talent-pool/applicants`) is `query?: never` exactly like the
 * other 11, confirmed the same way, independently of that hand list.
 *
 * `recruiter search parameters` is the one asymmetric case: its endpoint
 * takes `limit` (1-100) and `offset` (unused by the CLI), just not `cursor`.
 * `--limit` stays; only `--cursor` is refused.
 *
 * A DIFFERENT defect from `cursor-empty-refused-bin.test.ts` (that file
 * covers "the endpoint takes a cursor and the CLI drops it"); this is "the
 * endpoint takes no cursor and the CLI offers one anyway."
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliPath } from "./helpers/built-cli.js";

let server: Server;
let baseUrl: string;
let requests = 0;
const xdg = mkdtempSync(join(tmpdir(), "curviate-cursorless-"));

function run(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: xdg, NODE_ENV: "production" };
    delete env["CURVIATE_API_KEY"];
    delete env["CURVIATE_ACCOUNT"];
    delete env["CURVIATE_BASE_URL"];
    const child = spawn(process.execPath, [cliPath, ...args], { env });
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

const common = () => ["--json", "--beta", "--api-key", "cvt_test_x", "--account", "acc_1", "--base-url", baseUrl];

/** Argv for each command's own required flags, minus --cursor/--limit. */
const DROPS_BOTH: string[][] = [
  ["company", "1"],
  ["company", "chat", "1", "c1"],
  ["company", "message", "1", "c1", "m1"],
  ["post", "get", "p1"],
  ["profile", "endorse", "x1", "--endorsement-id", "e1"],
  ["recruiter", "applicants", "x1", "--channel-id", "c1"],
  ["webhook", "get", "w1"],
  ["webhook", "delete", "w1"],
  ["webhook", "update", "w1"],
  ["webhook", "create", "--source", "messaging", "--request-url", "https://h.test/x", "--account-ids", "acc_1"],
  ["webhook", "events"],
];

describe("--cursor/--limit are refused where the endpoint takes neither", () => {
  it("the exact set under test cannot drift silently", () => {
    expect(DROPS_BOTH.length).toBe(11);
  });

  for (const argv of DROPS_BOTH) {
    it(`${argv.slice(0, 3).join(" ")}: --cursor and --limit are unknown flags (exit 2, zero requests); the command itself still works`, async () => {
      for (const flag of [["--cursor", "c_1"], ["--limit", "5"]]) {
        requests = 0;
        const r = await run([...argv, ...flag, ...common()]);
        expect(r.status, r.stdout + r.stderr).toBe(2);
        expect(r.stderr).toContain(`unknown flag \`${flag[0]}\``);
        expect(requests).toBe(0);
      }
      // Same-path positive control: the command still runs without them.
      requests = 0;
      const control = await run([...argv, ...common()]);
      expect(control.status, control.stdout + control.stderr).toBe(0);
      expect(requests).toBeGreaterThan(0);
    });
  }

  it("recruiter search parameters: --cursor is an unknown flag, --limit still works", async () => {
    const base = ["recruiter", "search", "parameters", "--source", "SEARCH", "--type", "LOCATION"];

    requests = 0;
    const bad = await run([...base, "--cursor", "c_1", ...common()]);
    expect(bad.status, bad.stdout + bad.stderr).toBe(2);
    expect(bad.stderr).toContain("unknown flag `--cursor`");
    expect(requests).toBe(0);

    // Same-path positive control: --limit is a real, honoured flag here.
    requests = 0;
    const good = await run([...base, "--limit", "5", ...common()]);
    expect(good.status, good.stdout + good.stderr).toBe(0);
    expect(requests).toBeGreaterThan(0);
  });
});
