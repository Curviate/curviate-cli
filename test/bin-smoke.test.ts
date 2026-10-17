/**
 * The ONE test of the built artifact: `dist/cli.js` starts, finds its own
 * package.json (version), sends an authenticated request to the configured base
 * URL, renders it, and maps a failure to its exit code. Everything else runs
 * in-process through the same entry point (helpers/run-inproc.ts); this only
 * proves the bundle and the shebang entry wire up. Rebuilt when src/ is newer.
 */
import { describe, it, expect } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { configHome } from "./helpers/run-inproc.js";
import { pkgRoot } from "./helpers/pkg.js";
import { useSink } from "./helpers/sink.js";

const cli = resolve(pkgRoot, "dist", "cli.js");
const newest = (d: string): number => Math.max(0, ...readdirSync(d, { withFileTypes: true }).map((e) => (e.isDirectory() ? newest(join(d, e.name)) : statSync(join(d, e.name)).mtimeMs)));
const sink = useSink({ body: { object: "account_list", items: [{ account_id: "acc_1" }], cursor: null } });

function bin(args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { PATH: process.env["PATH"] ?? "", NODE_ENV: "production", XDG_CONFIG_HOME: configHome(), ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c));
    child.stderr.on("data", (c: Buffer) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => done({ status, stdout, stderr }));
    child.stdin.end();
  });
}

describe("built binary", () => {
  it("prints its version, calls the API with the key, renders the answer, and exits with the mapped code", { timeout: 120_000 }, async () => {
    if (!existsSync(cli) || statSync(cli).mtimeMs < newest(resolve(pkgRoot, "src"))) execFileSync(resolve(pkgRoot, "node_modules/.bin/tsup"), { cwd: pkgRoot, stdio: "ignore" });
    const version = (JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf8")) as { version: string }).version;
    expect((await bin(["--version"], {})).stdout.trim()).toBe(version);

    const env = { CURVIATE_API_KEY: "cvt_test_smoke", CURVIATE_BASE_URL: sink.url };
    const ok = await bin(["account", "list", "--json"], env);
    expect([ok.status, (JSON.parse(ok.stdout.trim()) as { items: Array<{ account_id: string }> }).items[0]!.account_id]).toEqual([0, "acc_1"]);
    expect(sink.hits.map((q) => [q.method, q.url, q.headers.authorization])).toEqual([["GET", "/v1/accounts", "Bearer cvt_test_smoke"]]);

    sink.reply = { status: 401, body: { code: "UNAUTHORIZED", message: "bad key", user_fixable: true, retry_likely_to_succeed: false } };
    expect((await bin(["account", "list", "--json"], env)).status).toBe(3);
    expect((await bin(["no-such-command"], env)).status).toBe(2);
  });
});
