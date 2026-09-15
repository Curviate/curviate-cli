/**
 * A malformed config file (hand-edited: a field of the wrong JSON type, a
 * profile that is not an object, a `null` root, a non-string `active`, a
 * non-object `profiles`) is a usage error, exit 2, naming the file, profile
 * and field plus the repair, never the value. Types are checked after
 * precedence and only for what the command takes from the profile, so a flag
 * or env var bypasses a broken field; `null` means unset. `config list` never
 * refuses: it renders a broken field as `<invalid>` and emits known fields
 * only. Through the built bin.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliPath } from "./helpers/built-cli.js";

let xdg: string;
let cfgPath: string;
let server: Server;
let baseUrl: string;

const MARK = "ZZSECRETVALUE9876ZZ";

function run(args: string[], env: Record<string, string> = {}): Promise<{ status: number | null; out: string; stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    const e: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: xdg, NODE_ENV: "production" };
    delete e["CURVIATE_API_KEY"];
    delete e["CURVIATE_ACCOUNT"];
    delete e["CURVIATE_BASE_URL"];
    const child = spawn(process.execPath, [cliPath, ...args], { env: { ...e, ...env } });
    let out = "";
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => ((out += c), (stdout += c)));
    child.stderr.on("data", (c: string) => (out += c));
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, out, stdout }));
    child.stdin.end("");
  });
}

function writeRaw(root: unknown): void {
  mkdirSync(join(xdg, "curviate"), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify(root));
}
const writeConfig = (profiles: Record<string, unknown>, active = "default") => writeRaw({ active, profiles });

beforeAll(async () => {
  xdg = mkdtempSync(join(tmpdir(), "curviate-profile-type-bin-"));
  cfgPath = join(xdg, "curviate", "config.json");
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
const good = () => ({ apiKey: KEY, baseUrl, account: "acc_1", timeout: 5000, tenant: "Acme" });

/** Refused: exit 2, names file, profile, field and repair, never the value. */
function expectRefused(r: { status: number | null; out: string }, field: string, profile = "default"): void {
  expect(r.status, r.out).toBe(2);
  expect(r.out).toContain(cfgPath);
  expect(r.out).toContain(field);
  expect(r.out).toContain(`config reset --profile ${profile}`);
  expect(r.out).not.toContain(MARK);
  expect(r.out).not.toMatch(/is not a function|Cannot read|Internal error/);
}

const WRONG: Record<string, unknown[]> = {
  apiKey: [[`cvt_live_${MARK}`], { k: `cvt_live_${MARK}` }, 12345678901234567, true],
  baseUrl: [[`http://${MARK}.example`], { u: MARK }, 7],
  account: [[MARK], { a: MARK }, 1],
  tenant: [{ t: MARK }, [MARK]],
  timeout: [`5000${MARK}`, [5000], { t: MARK }],
};

/** Which fields each command takes from the profile. */
const TAKES: Array<[string[], string[]]> = [
  [["account", "list", "--json"], ["apiKey", "baseUrl", "timeout"]],
  [["profile", "me", "--json"], ["apiKey", "baseUrl", "timeout", "account"]],
  [["doctor", "--json"], ["apiKey", "baseUrl", "timeout", "tenant"]],
];

describe("a profile field of the wrong type", () => {
  it("control: a well-typed profile runs every command, exit 0", async () => {
    writeConfig({ default: good() });
    for (const [argv] of TAKES) {
      const r = await run(argv);
      expect(r.status, `${argv.join(" ")}: ${r.out}`).toBe(0);
    }
  });

  for (const [field, values] of Object.entries(WRONG)) {
    for (const value of values) {
      for (const [argv, takes] of TAKES) {
        const label = `${field}=${JSON.stringify(value).slice(0, 12)}: ${argv.join(" ")}`;
        if (takes.includes(field)) {
          it(`${label} exits 2, naming file, profile, field and repair`, async () => {
            writeConfig({ default: { ...good(), [field]: value } });
            expectRefused(await run(argv), field);
          });
        } else {
          it(`${label} does not take ${field}: exit 0`, async () => {
            writeConfig({ default: { ...good(), [field]: value } });
            const r = await run(argv);
            expect(r.status, r.out).toBe(0);
            expect(r.out).not.toContain(MARK);
          });
        }
      }
    }
  }

  const BYPASS: Array<[string, string[], Record<string, string>]> = [
    ["apiKey", ["--api-key", KEY], {}],
    ["apiKey", [], { CURVIATE_API_KEY: KEY }],
    ["baseUrl", ["--base-url", "BASE"], {}],
    ["baseUrl", [], { CURVIATE_BASE_URL: "BASE" }],
    ["timeout", ["--timeout", "5000"], {}],
    ["account", ["--account", "acc_1"], {}],
    ["account", [], { CURVIATE_ACCOUNT: "acc_1" }],
  ];
  for (const [field, flags, env] of BYPASS) {
    it(`a broken ${field} is bypassed by ${flags[0] ?? Object.keys(env)[0]}: profile me exits 0`, async () => {
      writeConfig({ default: { ...good(), [field]: { x: MARK } } });
      const fill = (v: string) => (v === "BASE" ? baseUrl : v);
      const r = await run(
        ["profile", "me", "--json", ...flags.map(fill)],
        Object.fromEntries(Object.entries(env).map(([k, v]) => [k, fill(v)])),
      );
      expect(r.status, r.out).toBe(0);
      expect(r.out).not.toContain(MARK);
    });
  }

  it("a broken tenant is not taken when the key comes from a flag: doctor exits 0", async () => {
    writeConfig({ default: { ...good(), tenant: { t: MARK } } });
    const r = await run(["doctor", "--json", "--api-key", KEY]);
    expect(r.status, r.out).toBe(0);
  });

  it("null on a field means unset: doctor falls back to the default base URL and reports no key", async () => {
    writeConfig({ default: { apiKey: null, baseUrl: null, account: null, timeout: null, tenant: null } });
    const r = await run(["doctor", "--json"]);
    expect(r.status, r.out).toBe(3);
    expect((JSON.parse(r.stdout.trim()) as { base_url: string }).base_url).toBe("https://api.curviate.com");
  });

  it("a profile that is not an object exits 2 on a command", async () => {
    for (const value of [`cvt_live_${MARK}`, [MARK], 5, true]) {
      writeConfig({ default: value });
      const r = await run(["account", "list", "--json"]);
      expect(r.status, r.out).toBe(2);
      expect(r.out).toContain(cfgPath);
      expect(r.out).toContain("config reset --profile default");
      expect(r.out).not.toContain(MARK);
    }
  });

  it("a broken profile that is not selected does not block a command on a good one", async () => {
    writeConfig({ default: good(), other: { apiKey: [MARK] } });
    const r = await run(["account", "list", "--json"]);
    expect(r.status, r.out).toBe(0);
    expectRefused(await run(["account", "list", "--json", "--profile", "other"]), "apiKey", "other");
  });

  it("config reset --profile repairs it", async () => {
    writeConfig({ default: good(), other: { apiKey: [MARK] } });
    const reset = await run(["config", "reset", "--profile", "other", "--yes"]);
    expect(reset.status, reset.out).toBe(0);
    const list = await run(["config", "list", "--json"]);
    expect(list.status, list.out).toBe(0);
    expect(Object.keys((JSON.parse(list.stdout) as { profiles: object }).profiles)).toEqual(["default"]);
  });
});

describe("a malformed config file structure", () => {
  const STRUCTURE: Array<[string, unknown]> = [
    ["null root", null],
    ["array root", [MARK]],
    ["string root", MARK],
    ["numeric active", { active: 7, profiles: { default: good() } }],
    ["array active", { active: [MARK], profiles: { default: good() } }],
    ["object active", { active: { a: MARK }, profiles: { default: good() } }],
    ["array profiles", { active: "default", profiles: [MARK] }],
    ["string profiles", { active: "default", profiles: MARK }],
    ["numeric profiles", { active: "default", profiles: 7 }],
  ];

  for (const [label, root] of STRUCTURE) {
    it(`${label}: a command exits 2 naming the file, without echoing`, async () => {
      writeRaw(root);
      for (const argv of [["account", "list", "--json"], ["profile", "me", "--json"], ["doctor", "--json"]]) {
        const r = await run(argv);
        expect(r.status, `${argv.join(" ")}: ${r.out}`).toBe(2);
        expect(r.out).toContain(cfgPath);
        expect(r.out).not.toContain(MARK);
        expect(r.out).not.toMatch(/is not a function|Cannot read|Internal error/);
      }
    });

    it(`${label}: a config writer exits 2 without crashing`, async () => {
      writeRaw(root);
      for (const argv of [["config", "set-account", "acc_2"], ["login", "--api-key", KEY]]) {
        const r = await run(argv);
        expect(r.status, `${argv.join(" ")}: ${r.out}`).toBe(2);
        expect(r.out).not.toContain(MARK);
        expect(r.out).not.toMatch(/is not a function|Cannot read|Internal error/);
      }
    });

    it(`${label}: config list exits 0 without echoing`, async () => {
      writeRaw(root);
      for (const argv of [["config", "list"], ["config", "list", "--json"]]) {
        const r = await run(argv);
        expect(r.status, `${argv.join(" ")}: ${r.out}`).toBe(0);
        expect(r.out).toContain("<invalid>");
        expect(r.out).not.toContain(MARK);
      }
    });
  }

  it("a broken active is not taken when --profile names one: exit 0", async () => {
    writeRaw({ active: [MARK], profiles: { default: good() } });
    const r = await run(["account", "list", "--json", "--profile", "default"]);
    expect(r.status, r.out).toBe(0);
  });

  it("nothing is taken from a broken file when every value comes from a flag: exit 0", async () => {
    writeRaw({ active: "default", profiles: [MARK] });
    const r = await run(["account", "list", "--json", "--api-key", KEY, "--base-url", baseUrl, "--timeout", "5000"]);
    expect(r.status, r.out).toBe(0);
  });
});

describe("config list never refuses", () => {
  it("lists every profile, renders a broken field as <invalid>, emits known fields only", async () => {
    writeConfig({
      default: { ...good(), password: MARK, extra: { x: MARK } },
      broken: { apiKey: [MARK], account: { a: MARK }, baseUrl: 7, timeout: `x${MARK}`, tenant: [MARK] },
      scalar: MARK,
      nulls: { apiKey: null, account: null },
    });
    const json = await run(["config", "list", "--json"]);
    expect(json.status, json.out).toBe(0);
    expect(json.out).not.toContain(MARK);
    const parsed = JSON.parse(json.stdout) as { active: string; profiles: Record<string, unknown> };
    expect(parsed.active).toBe("default");
    expect(parsed.profiles).toEqual({
      default: { apiKey: "••••mnop", account: "acc_1", baseUrl, timeout: 5000, tenant: "Acme", active: true },
      broken: { apiKey: "<invalid>", account: "<invalid>", baseUrl: "<invalid>", timeout: "<invalid>", tenant: "<invalid>" },
      scalar: "<invalid>",
      nulls: { apiKey: "<unset>" },
    });

    const text = await run(["config", "list"]);
    expect(text.status, text.out).toBe(0);
    expect(text.out).not.toContain(MARK);
    expect(text.out).not.toContain("password");
    expect(text.out).toMatch(/broken\n {2}apiKey: <invalid>\n {2}account: <invalid>\n {2}baseUrl: <invalid>\n {2}timeout: <invalid>/);
    expect(text.out).toMatch(/scalar\n {2}<invalid>/);
  });
});
