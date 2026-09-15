/**
 * A hand-edited profile whose field has the wrong JSON type (an array, an
 * object, a number where a string belongs) is a usage error, exit 2, with a
 * message naming the field and never its value. Before, `apiKey` crashed every
 * command (`trim is not a function`, exit 1) and `config list` (`slice is not
 * a function`), and other fields rode silently onto the wire. Through the built bin.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliPath } from "./helpers/built-cli.js";

let xdg: string;
let server: Server;
let baseUrl: string;

const MARK = "ZZSECRETVALUE9876ZZ";

function run(args: string[]): Promise<{ status: number | null; out: string }> {
  return new Promise((resolvePromise, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: xdg, NODE_ENV: "production" };
    delete env["CURVIATE_API_KEY"];
    delete env["CURVIATE_ACCOUNT"];
    delete env["CURVIATE_BASE_URL"];
    const child = spawn(process.execPath, [cliPath, ...args], { env });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (out += c));
    child.stderr.on("data", (c: string) => (out += c));
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, out }));
    child.stdin.end("");
  });
}

function writeConfig(profiles: Record<string, unknown>, active = "default"): void {
  mkdirSync(join(xdg, "curviate"), { recursive: true });
  writeFileSync(join(xdg, "curviate", "config.json"), JSON.stringify({ active, profiles }));
}

beforeAll(async () => {
  xdg = mkdtempSync(join(tmpdir(), "curviate-profile-type-bin-"));
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: [], cursor: null, provider_id: "p" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const KEY = "cvt_test_abcdefghijklmnop";
const good = () => ({ apiKey: KEY, baseUrl, account: "acc_1", timeout: 5000 });

const GARBAGE: Array<[string, unknown]> = [
  ["apiKey", [`cvt_live_${MARK}`]],
  ["apiKey", { k: `cvt_live_${MARK}` }],
  ["apiKey", 12345678901234567],
  ["baseUrl", [`http://${MARK}.example`]],
  ["baseUrl", { u: MARK }],
  ["account", [MARK]],
  ["account", { a: MARK }],
  ["tenant", { t: MARK }],
  ["timeout", `5000${MARK}`],
  ["timeout", [5000]],
];

const COMMANDS: string[][] = [
  ["account", "list", "--json"],
  ["profile", "me", "--json"],
  ["doctor", "--json"],
  ["config", "list"],
  ["config", "list", "--json"],
];

describe("a profile field of the wrong type exits 2 without echoing it", () => {
  it("control: a well-typed profile runs every command, exit 0", async () => {
    writeConfig({ default: good() });
    for (const argv of COMMANDS) {
      const r = await run(argv);
      expect(r.status, `${argv.join(" ")}: ${r.out}`).toBe(0);
    }
  });

  for (const [field, value] of GARBAGE) {
    for (const argv of COMMANDS) {
      it(`${field}=${JSON.stringify(value).slice(0, 14)}: ${argv.join(" ")} exits 2 naming ${field}`, async () => {
        writeConfig({ default: { ...good(), [field]: value } });
        const r = await run(argv);
        expect(r.status, r.out).toBe(2);
        expect(r.out).toContain(field);
        expect(r.out).not.toContain(MARK);
        expect(r.out).not.toMatch(/is not a function/);
      });
    }
  }

  it("a profile that is not an object exits 2", async () => {
    writeConfig({ default: `cvt_live_${MARK}` });
    for (const argv of COMMANDS) {
      const r = await run(argv);
      expect(r.status, `${argv.join(" ")}: ${r.out}`).toBe(2);
      expect(r.out).not.toContain(MARK);
    }
  });

  it("a broken profile that is not selected does not block a command on a good one", async () => {
    writeConfig({ default: good(), other: { apiKey: [MARK] } });
    const r = await run(["account", "list", "--json"]);
    expect(r.status, r.out).toBe(0);
    const bad = await run(["account", "list", "--json", "--profile", "other"]);
    expect(bad.status, bad.out).toBe(2);
  });
});
