/**
 * A hand-edited config file (a field of the wrong JSON type, a profile that is
 * not an object, a null root, invalid JSON, a BOM) is a usage error, exit 2,
 * naming the file, profile and field plus the repair, never the value. Types
 * are checked after precedence and only for what the command takes from the
 * profile, so a flag or env var bypasses a broken field; `null` means unset.
 * `config list` never refuses. Writers repair what they overwrite.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configHome, runCli } from "./helpers/run-inproc.js";
import { useSink } from "./helpers/sink.js";

const sink = useSink({ body: { items: [], cursor: null, provider_id: "p" } });
const MARK = "ZZSECRETVALUE9876ZZ";
const KEY = "cvt_test_abcdefghijklmnop";
let xdg: string;
let cfgPath: string;
beforeEach(() => {
  xdg = configHome();
  cfgPath = join(xdg, "curviate", "config.json");
});

async function run(args: string[], env: Record<string, string> = {}) {
  const r = await runCli(args, { xdg, env });
  return { ...r, out: r.stdout + r.stderr };
}
const writeText = (text: string) => {
  mkdirSync(join(xdg, "curviate"), { recursive: true });
  writeFileSync(cfgPath, text);
};
const writeRaw = (root: unknown) => writeText(JSON.stringify(root));
const writeConfig = (profiles: Record<string, unknown>, active = "default") => writeRaw({ active, profiles });
const readBack = () => JSON.parse(readFileSync(cfgPath, "utf8")) as { active?: string; profiles: Record<string, Record<string, unknown>> };
const good = () => ({ apiKey: KEY, baseUrl: sink.url, account: "acc_1", timeout: 5000, tenant: "Acme" });
const noCrash = (out: string) => expect(out).not.toMatch(/is not a function|Cannot read|Internal error/);

function expectRefused(r: { status: number; out: string }, field: string, profile = "default") {
  expect(r.status, r.out).toBe(2);
  for (const s of [cfgPath, field, `config reset --profile ${profile}`]) expect(r.out).toContain(s);
  expect(r.out).not.toContain(MARK);
  noCrash(r.out);
}

describe("a profile field of the wrong type", () => {
  const WRONG: Record<string, unknown[]> = {
    apiKey: [[`cvt_live_${MARK}`], { k: `cvt_live_${MARK}` }, 12345678901234567, true],
    baseUrl: [[`http://${MARK}.example`], { u: MARK }, 7],
    account: [[MARK], { a: MARK }, 1],
    tenant: [{ t: MARK }, [MARK]],
    timeout: [`5000${MARK}`, [5000], { t: MARK }],
  };
  const TAKES: Array<[string[], string[]]> = [
    [["account", "list", "--json"], ["apiKey", "baseUrl", "timeout"]],
    [["profile", "me", "--json"], ["apiKey", "baseUrl", "timeout", "account"]],
    [["doctor", "--json"], ["apiKey", "baseUrl", "timeout", "tenant"]],
  ];

  it("control: a well-typed profile runs every command, exit 0", async () => {
    writeConfig({ default: good() });
    for (const [argv] of TAKES) expect((await run(argv)).status, argv.join(" ")).toBe(0);
  });

  it("each field exits 2 naming file, profile, field and repair on the commands that take it, and is ignored by the ones that do not", async () => {
    for (const [field, values] of Object.entries(WRONG)) {
      for (const value of values) {
        for (const [argv, takes] of TAKES) {
          writeConfig({ default: { ...good(), [field]: value } });
          const r = await run(argv);
          if (takes.includes(field)) expectRefused(r, field);
          else {
            expect([r.status, r.out.includes(MARK)], `${field} on ${argv.join(" ")}`).toEqual([0, false]);
          }
        }
      }
    }
  });

  it.each([
    ["apiKey", ["--api-key", KEY], {}],
    ["apiKey", [], { CURVIATE_API_KEY: KEY }],
    ["baseUrl", ["--base-url", "BASE"], {}],
    ["baseUrl", [], { CURVIATE_BASE_URL: "BASE" }],
    ["timeout", ["--timeout", "5000"], {}],
    ["account", ["--account", "acc_1"], {}],
    ["account", [], { CURVIATE_ACCOUNT: "acc_1" }],
  ])("a broken %s is bypassed by %j %j: profile me exits 0", async (field, flags, env) => {
    writeConfig({ default: { ...good(), [field]: { x: MARK } } });
    const fill = (v: string) => (v === "BASE" ? sink.url : v);
    const r = await run(["profile", "me", "--json", ...flags.map(fill)], Object.fromEntries(Object.entries(env).map(([k, v]) => [k, fill(v)])));
    expect([r.status, r.out.includes(MARK)], r.out).toEqual([0, false]);
  });

  it("a broken tenant is not taken when the key comes from a flag", async () => {
    writeConfig({ default: { ...good(), tenant: { t: MARK } } });
    expect((await run(["doctor", "--json", "--api-key", KEY])).status).toBe(0);
  });

  it("null on a field means unset: doctor falls back to the default base URL and reports no key", async () => {
    writeConfig({ default: { apiKey: null, baseUrl: null, account: null, timeout: null, tenant: null } });
    const r = await run(["doctor", "--json"]);
    expect([r.status, (JSON.parse(r.stdout.trim()) as { base_url: string }).base_url], r.out).toEqual([3, "https://api.curviate.com"]);
  });

  it("a profile that is not an object exits 2 on a command", async () => {
    for (const value of [`cvt_live_${MARK}`, [MARK], 5, true]) {
      writeConfig({ default: value });
      const r = await run(["account", "list", "--json"]);
      expect(r.status, r.out).toBe(2);
      expect(r.out).toContain("config reset --profile default");
      expect(r.out).not.toContain(MARK);
    }
  });

  it("a broken profile that is not selected does not block a good one; config reset --profile repairs it", async () => {
    writeConfig({ default: good(), other: { apiKey: [MARK] } });
    expect((await run(["account", "list", "--json"])).status).toBe(0);
    expectRefused(await run(["account", "list", "--json", "--profile", "other"]), "apiKey", "other");
    expect((await run(["config", "reset", "--profile", "other", "--yes"])).status).toBe(0);
    expect(Object.keys(JSON.parse((await run(["config", "list", "--json"])).stdout).profiles)).toEqual(["default"]);
  });
});

describe("a malformed config file structure", () => {
  const STRUCTURE: Array<[string, unknown]> = [
    ["null root", null], ["array root", [MARK]], ["string root", MARK],
    ["numeric active", { active: 7, profiles: { default: {} } }], ["array active", { active: [MARK], profiles: { default: {} } }], ["object active", { active: { a: MARK }, profiles: { default: {} } }],
    ["array profiles", { active: "default", profiles: [MARK] }], ["string profiles", { active: "default", profiles: MARK }], ["numeric profiles", { active: "default", profiles: 7 }],
  ];

  it.each(STRUCTURE)("%s: commands and writers exit 2 without echoing or crashing; config list exits 0 as <invalid>", async (_l, root) => {
    for (const argv of [["account", "list", "--json"], ["profile", "me", "--json"], ["doctor", "--json"]]) {
      writeRaw(root);
      const r = await run(argv);
      expect(r.status, `${argv.join(" ")}: ${r.out}`).toBe(2);
      expect(r.out).toContain(cfgPath);
      expect(r.out).not.toContain(MARK);
      noCrash(r.out);
    }
    for (const argv of [["config", "set-account", "acc_2"], ["login", "--api-key", KEY]]) {
      writeRaw(root);
      const r = await run(argv);
      expect([r.status, r.out.includes(MARK)], `${argv.join(" ")}: ${r.out}`).toEqual([2, false]);
      noCrash(r.out);
    }
    for (const argv of [["config", "list"], ["config", "list", "--json"]]) {
      writeRaw(root);
      const r = await run(argv);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain("<invalid>");
      expect(r.out).not.toContain(MARK);
    }
  });

  it("a broken active is not taken when --profile names one; nothing is taken from a broken file when every value is a flag", async () => {
    writeRaw({ active: [MARK], profiles: { default: good() } });
    expect((await run(["account", "list", "--json", "--profile", "default"])).status).toBe(0);
    writeRaw({ active: "default", profiles: [MARK] });
    expect((await run(["account", "list", "--json", "--api-key", KEY, "--base-url", sink.url, "--timeout", "5000"])).status).toBe(0);
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
      default: { apiKey: "••••mnop", account: "acc_1", baseUrl: sink.url, timeout: 5000, tenant: "Acme", active: true },
      broken: { apiKey: "<invalid>", account: "<invalid>", baseUrl: "<invalid>", timeout: "<invalid>", tenant: "<invalid>" },
      scalar: "<invalid>",
      nulls: { apiKey: "<unset>" },
    });
    const text = await run(["config", "list"]);
    expect([text.status, text.out.includes(MARK), text.out.includes("password")], text.out).toEqual([0, false, false]);
    expect(text.out).toMatch(/broken\n {2}apiKey: <invalid>\n {2}account: <invalid>\n {2}baseUrl: <invalid>\n {2}timeout: <invalid>/);
    expect(text.out).toMatch(/scalar\n {2}<invalid>/);
  });
});

describe("a writer repairs a non-object profile", () => {
  it.each([[[MARK]], [`cvt_live_${MARK}`], [42], [true], [false]])("profile %j is replaced by a fresh object on every writer", async (value) => {
    const WRITES: Array<[string[], Record<string, unknown>]> = [
      [["config", "set-account", "acc_9"], { account: "acc_9" }],
      [["config", "set-base-url", "https://custom.test"], { baseUrl: "https://custom.test" }],
      [["config", "set-base-url", "--reset"], {}],
      [["login", "--api-key", KEY], { apiKey: KEY }],
    ];
    for (const [argv, written] of WRITES) {
      writeConfig({ default: value, other: good() });
      const r = await run(argv);
      expect([r.status, r.out.includes(MARK)], r.out).toEqual([0, false]);
      const cfg = readBack();
      expect([cfg.profiles["default"], cfg.profiles["other"], cfg.active], argv.join(" ")).toEqual([written, good(), "default"]);
    }
  });

  it("--profile targets the named non-object profile; a missing profile is refused and nothing is written", async () => {
    writeConfig({ default: good(), other: [MARK] });
    expect((await run(["config", "set-account", "acc_9", "--profile", "other"])).status).toBe(0);
    expect([readBack().profiles["other"], readBack().profiles["default"]]).toEqual([{ account: "acc_9" }, good()]);
    writeConfig({ default: good() });
    const before = readFileSync(cfgPath, "utf8");
    expect((await run(["config", "set-account", "acc_9", "--profile", "ghost"])).status).toBe(2);
    expect(readFileSync(cfgPath, "utf8")).toBe(before);
  });
});

describe("a config file that is not valid JSON", () => {
  const BROKEN = [["garbage", `{not json ${MARK}`], ["empty file", ""], ["truncated", `{"active":"default","profiles":{"default":{"apiKey":"cvt_live_${MARK}`]];
  const COMMANDS = [
    ["account", "list", "--json"], ["profile", "me", "--json"], ["doctor", "--json"], ["config", "list"], ["config", "list", "--json"],
    ["login", "--api-key", KEY], ["config", "set-account", "acc_9"], ["config", "set-base-url", "https://custom.test"], ["config", "set-base-url", "--reset"],
    ["config", "use", "default"], ["config", "rename", "default", "other"], ["config", "reset", "--profile", "default", "--yes"],
  ];

  it.each(BROKEN)("%s: every command exits 2 with the reset hint, no parser text, file untouched; flag/env-only readers bypass it", async (_l, text) => {
    for (const argv of COMMANDS) {
      writeText(text);
      const r = await run(argv);
      expect(r.status, `${argv.join(" ")}: ${r.out}`).toBe(2);
      for (const s of [cfgPath, "config reset", "not valid JSON"]) expect(r.out).toContain(s);
      expect(r.out).not.toMatch(/SyntaxError|Unexpected|JSON at position|end of JSON|is not valid JSON:/);
      expect(r.out).not.toContain(MARK);
      expect(readFileSync(cfgPath, "utf8")).toBe(text);
    }
    writeText(text);
    const flags = ["--api-key", KEY, "--base-url", sink.url, "--timeout", "5000"];
    const env = { CURVIATE_API_KEY: KEY, CURVIATE_BASE_URL: sink.url, CURVIATE_ACCOUNT: "acc_1" };
    for (const [argv, e] of [
      [["account", "list", "--json", ...flags], {}], [["profile", "me", "--json", "--account", "acc_1", ...flags], {}], [["doctor", "--json", ...flags], {}],
      [["profile", "me", "--json", "--timeout", "5000"], env],
    ] as Array<[string[], Record<string, string>]>) {
      const r = await run(argv, e);
      expect(r.status, `${argv.join(" ")}: ${r.out}`).toBe(0);
    }
  });

  it("config reset removes it (the repair works)", async () => {
    writeText("{not json");
    expect((await run(["config", "reset", "--yes"])).status).toBe(0);
    expect((await run(["config", "list", "--json"])).out).toMatch(/No config file/);
  });
});

describe("an active that is null or absent means default, for writers too", () => {
  it.each([["null active", (p: object) => ({ active: null, profiles: p })], ["absent active", (p: object) => ({ profiles: p })]])("%s", async (_l, root) => {
    const WRITES: Array<[string[], (p: Record<string, unknown>) => void]> = [
      [["config", "set-account", "acc_9"], (p) => expect(p["account"]).toBe("acc_9")],
      [["config", "set-base-url", "https://custom.test"], (p) => expect(p["baseUrl"]).toBe("https://custom.test")],
      [["config", "set-base-url", "--reset"], (p) => expect(p["baseUrl"]).toBeUndefined()],
    ];
    for (const [argv, check] of WRITES) {
      writeRaw(root({ default: { apiKey: KEY, baseUrl: "https://old.test" }, other: good() }));
      const r = await run(argv);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('profile "default"');
      expect(r.out).not.toMatch(/"null"|"undefined"/);
      check(readBack().profiles["default"]!);
      expect([readBack().profiles["default"]!["apiKey"], readBack().profiles["other"]]).toEqual([KEY, good()]);
    }
    writeRaw(root({ default: { apiKey: KEY } }));
    expect((await run(["config", "rename", "default", "team"])).status).toBe(0);
    expect(readBack().active).toBe("team");
    expect((await run(["account", "list", "--json", "--base-url", sink.url])).status).toBe(0);
    writeRaw(root({ default: { apiKey: KEY, baseUrl: sink.url } }));
    expect((await run(["account", "list", "--json"])).status).toBe(0);
  });
});

describe("env-only CI: key and base URL from the environment, timeout falls back to its default", () => {
  it.each([
    ["invalid JSON", () => writeText(`{not json ${MARK}`)],
    ["non-object profile", () => writeConfig({ default: [MARK] })],
    ["null root", () => writeRaw(null)],
    ["array profiles", () => writeRaw({ active: "default", profiles: [MARK] })],
    ["wrong-typed timeout", () => writeConfig({ default: { timeout: `x${MARK}` } })],
  ])("%s: account list and profile me run with only env set", async (_l, setup) => {
    setup();
    const env = { CURVIATE_API_KEY: KEY, CURVIATE_BASE_URL: sink.url };
    const list = await run(["account", "list", "--json"], env);
    const me = await run(["profile", "me", "--json"], { ...env, CURVIATE_ACCOUNT: "acc_1" });
    expect([list.status, me.status], list.out + me.out).toEqual([0, 0]);
    expect(list.out + me.out).not.toContain(MARK);
  });

  it("controls: a broken timeout still refuses when the base URL is the profile's; the same broken file refuses when the key comes from it", async () => {
    writeConfig({ default: { baseUrl: sink.url, timeout: `x${MARK}` } });
    const r = await run(["account", "list", "--json"], { CURVIATE_API_KEY: KEY });
    expect([r.status, r.out.includes("timeout")]).toEqual([2, true]);
    writeConfig({ default: [MARK] });
    expect((await run(["account", "list", "--json"], { CURVIATE_BASE_URL: sink.url })).status).toBe(2);
  });
});

describe("a leading UTF-8 byte order mark is ignored", () => {
  it("readers, config list and writers read the file; a BOM anywhere but the start is still invalid JSON", async () => {
    writeText("﻿" + JSON.stringify({ active: "default", profiles: { default: { apiKey: KEY, baseUrl: sink.url } } }));
    expect(readFileSync(cfgPath)[0]).toBe(0xef);
    expect((await run(["account", "list", "--json"])).status).toBe(0);
    expect(JSON.parse((await run(["config", "list", "--json"])).stdout).profiles.default.baseUrl).toBe(sink.url);
    expect((await run(["config", "set-account", "acc_9"])).status).toBe(0);
    expect(JSON.parse(readFileSync(cfgPath, "utf8").replace(/^﻿/, "")).profiles.default.account).toBe("acc_9");
    writeText(" ﻿{}");
    expect((await run(["account", "list", "--json"])).status).toBe(2);
  });
});
