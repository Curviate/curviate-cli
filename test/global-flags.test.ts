/**
 * Global flags and credential flags through the CLI entry point: the `--beta`
 * header, malformed or repeated secret flags (refused, never echoed), --timeout,
 * secrets masked in --preview, and the flags local commands refuse. A secret is
 * asserted absent from BOTH streams, next to a control that proves it could show.
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderUsage, type CommandDef } from "citty";
import { SECRET_FLAGS } from "../src/dispatch.js";
import { loginCommand } from "../src/commands/login.js";
import { configHome } from "./helpers/run-inproc.js";
import { allNodes } from "./helpers/tree.js";
import { useSink } from "./helpers/sink.js";

const sink = useSink({ body: { object: "account_list", items: [], cursor: null } });
const K = "SENTINELkey7Q3Z9";
const cfg = (xdg: string) => join(xdg, "curviate", "config.json");

describe("--beta", () => {
  const HEADER = "x-curviate-beta";
  const beta = async (args: string[]) => (await sink.run([...args, "--json"])).requests.map((q) => q.headers[HEADER]);

  it("no flag sends no header; --beta and --beta=true send true; --beta=false sends false; before or after the command; persists nothing", async () => {
    const ok = await sink.run(["account", "list", "--json"]);
    expect([ok.status, ok.requests[0]!.headers["authorization"], ok.requests[0]!.headers[HEADER]]).toEqual([0, "Bearer cvt_test_sink", undefined]);
    expect(await beta(["--beta", "account", "list"])).toEqual(["true"]);
    expect(await beta(["account", "list", "--beta"])).toEqual(["true"]);
    expect(await beta(["account", "list", "--beta=true"])).toEqual(["true"]);
    expect(await beta(["account", "list", "--beta=false"])).toEqual(["false"]);
    expect(await beta(["account", "list"])).toEqual([undefined]);
  });

  it.each([["--beta=maybe", "--beta must be one of"], ["--beta=2", "--beta must be one of"], ["--beta=yep", "--beta must be one of"], ["--beta=", "--beta must be one of"], ["--no-beta=true", "--no-beta takes no value"]])(
    "%s exits 2 and issues no request",
    async (flag, message) => {
      const r = await sink.run(["account", "list", flag, "--json"]);
      expect([r.status, r.requests, r.stdout]).toEqual([2, [], ""]);
      expect(r.stderr).toContain(message);
    },
  );

  it("--version still works behind --beta; --help wins over an invalid --beta", async () => {
    const withFlag = await sink.run(["--beta", "--version"]);
    expect(withFlag.status).toBe(0);
    expect(withFlag.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect((await sink.run(["--version"])).stdout).toBe(withFlag.stdout);
    const help = await sink.run(["account", "list", "--beta=maybe", "--help"]);
    expect([help.status, help.requests]).toEqual([0, []]);
  });
});

describe("credential flags", () => {
  const refused = async (args: string[], xdg = configHome()) => {
    const r = await sink.run(args, { xdg });
    expect(r.status, `${args.join(" ")}\n${r.stdout}${r.stderr}`).toBe(2);
    expect(r.stdout + r.stderr).not.toContain(K);
    return r;
  };

  it("control: login --api-key K and --api-key=K save the key and never print it", async () => {
    for (const args of [["login", "--api-key", K], ["login", `--api-key=${K}`], ["login", "--api-key", K, "--no-json"]]) {
      const xdg = configHome();
      const r = await sink.run(args, { xdg });
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(readFileSync(cfg(xdg), "utf8"))).toMatchObject({ profiles: { default: { apiKey: K } } });
      expect(r.stdout + r.stderr).not.toContain(K);
    }
  });

  it("a repeated secret flag is a usage error naming the flag, not a crash", async () => {
    for (const args of [["login", `--api-key=${K}`, `--api-key=${K}`], ["profile", "me", "--api-key", K, "--api-key", K, "--account", "acc_1"]]) {
      expect((await refused(args)).stderr).toMatch(/--api-key.*more than once/);
    }
  });

  it.each([
    [["login", "--api-key=", K], /unexpected argument/],
    [["--api-key=", K, "account", "list"], /./],
    [["login", `--api-key-${K}`], /unknown flag at argument 1/],
    [["login", `---api-key=${K}`], /unknown flag `---api-key`/],
    [["login", `-api-key=${K}`], /./],
    [["login", `--no-api-key=${K}`], /unknown flag `--no-api-key`/],
    [["webhook", "verify", "--secret=", K], /./],
    [["setup", `--code-${K}`], /./],
    [["login", "--", `--api-key=${K}`], /unexpected argument 2 after `curviate login`/],
    [["--api-key=", K, "--json", "account", "list"], /argument 2/],
    ...SECRET_FLAGS.flatMap((f): Array<[string[], RegExp]> => [
      [["login", `--${f}=`, "--json", K], /./],
      [["login", `---${f}=${K}`], new RegExp(`unknown flag \`---${f}\``)],
    ]),
  ])("%j is refused and the stray value is never echoed", async (args, message) => {
    const xdg = configHome();
    expect((await refused(args, xdg)).stderr).toMatch(message);
    if (args[1]?.startsWith("---api-key")) expect(existsSync(cfg(xdg))).toBe(false);
  });

  it("config list masks a short key entirely and a long key but for its last 4", async () => {
    const shown = async (apiKey: string) => {
      const xdg = configHome();
      mkdirSync(join(xdg, "curviate"), { recursive: true });
      writeFileSync(cfg(xdg), JSON.stringify({ active: "default", profiles: { default: { apiKey } } }), { mode: 0o600 });
      const r = await sink.run(["config", "list", "--json"], { xdg });
      expect(r.status, r.stderr).toBe(0);
      return (JSON.parse(r.stdout) as { profiles: { default: { apiKey: string } } }).profiles.default.apiKey;
    };
    expect(await shown("cvt_live_abcd")).not.toMatch(/[a-z0-9_]/i);
    expect((await shown("rdc_live_ABCDEFGHIJ1234")).replace(/[^\x21-\x7e]/g, "")).toBe("1234");
  });

  it.each(["abc", "10abc", "0", "-5", "1.5", "0x10", "1e3", " 5", "2147483648", "05"])("--timeout=%j exits 2 naming --timeout", async (bad) => {
    expect((await refused(["profile", "me", "--api-key", K, "--account", "acc_1", `--timeout=${bad}`])).stderr).toMatch(/timeout/i);
  });

  it("--timeout accepts the upper bound and a small value", async () => {
    for (const t of ["2147483647", "50"]) {
      const r = await sink.run(["profile", "me", "--api-key", K, "--account", "acc_1", "--timeout", t]);
      expect([r.status, r.requests.length]).toEqual([0, 1]);
    }
  });

  it.each([
    ["config", "list", "--json", "--no-json"],
    ["config", "list", "--no-json", "--no-json"],
    ["profile", "me", "--account", "acc_1", "--verbose", "--no-verbose"],
    ["account", "list", "--all", "--no-all"],
    ["webhook", "create", "--enabled", "--no-enabled"],
    ["--beta", "--beta", "config", "list"],
    ["config", "list", "--beta", "--no-beta"],
  ])("%j: a negated or --beta repeat is a repeat", async (...args) => {
    expect((await refused(args)).stderr).toMatch(/was given more than once/);
  });

  it("login --base-url is validated before anything is saved", async () => {
    const xdg = configHome();
    const r = await refused(["login", "--api-key", K, "--base-url", "not a url"], xdg);
    expect(r.stderr).toMatch(/base URL/i);
    expect(existsSync(cfg(xdg))).toBe(false);
  });
});

describe("--preview masks every secret flag's value", () => {
  const MARK = "ZZSECRET4242ZZ";
  const common = ["--preview", "--api-key", `cvt_test_${MARK}abcdef`];
  const CASES: Record<string, Array<{ argv: string[]; shows: string[] }>> = {
    "account checkpoint solve": [
      { argv: ["account", "checkpoint", "solve", "acc_1", "--code", MARK], shows: ["acc_1"] },
      { argv: ["account", "checkpoint", "solve", "acc_1", `--code=${MARK}`], shows: ["acc_1"] },
    ],
    "account link": [
      { argv: ["account", "link", "--seat-id", "seat_1", "--auth-method", "credentials", "--email", "e@x.test", "--password", MARK, "--proxy-host", "proxy.test", "--proxy-password", MARK], shows: ["seat_1", "e@x.test", "proxy.test"] },
      { argv: ["account", "link", "--seat-id", "seat_1", "--auth-method", "cookie", "--country", "US", "--li-at", MARK, "--li-a", MARK, "--user-agent", "UA/1"], shows: ["seat_1", "UA/1"] },
    ],
    "account update": [{ argv: ["account", "update", "acc_1", "--proxy-host", "proxy.test", "--proxy-password", MARK], shows: ["acc_1", "proxy.test"] }],
  };

  it("the commands taking --preview and a secret flag are exactly the swept ones", async () => {
    const found = (await allNodes(true))
      .filter((n) => n.run && "preview" in n.defs && SECRET_FLAGS.some((f) => f !== "api-key" && f in n.defs))
      .map((n) => n.path.join(" "));
    expect(found.sort()).toEqual(Object.keys(CASES).sort());
  });

  it.each(Object.entries(CASES).flatMap(([path, cs]) => cs.map((c) => [path, c] as const)))("%s: secrets are masked, everything else shown", async (_path, { argv, shows }) => {
    const r = await sink.run([...argv, ...common]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect((JSON.parse(r.stdout.trim()) as { method: string }).method).toBeTruthy();
    expect(r.stdout).toContain("••••");
    for (const v of shows) expect(r.stdout).toContain(v);
    expect(r.stdout + r.stderr).not.toContain(MARK);
  });

  it("--signature is message content, not a secret: shown", async () => {
    const r = await sink.run(["recruiter", "message", "new", "--to", "ACoAAB", "--subject", "Hello", "--signature", "Best, Sam", "hi there", "--beta", "--account", "acc_1", ...common]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("Best, Sam");
    expect(SECRET_FLAGS).not.toContain("signature");
  });
});

describe("local commands (no API request) declare and accept only the flags they act on", () => {
  const INERT = [["--limit", "5"], ["--cursor", "abc"], ["--all"], ["--max-pages", "2"], ["--page-delay", "0"], ["--fields", "id"], ["--preview"], ["--verbose"], ["--timeout", "1000"]];
  const run = async (args: string[], xdg: string) => sink.run(args, { xdg });
  const unknown = (r: { status: number; stderr: string; stdout: string }, flag: string) => {
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`unknown flag \`${flag}\``);
  };

  it("login: every flag it acts on is accepted and saved; the inert ones are refused; --help names none of them", async () => {
    const xdg = configHome();
    const ok = await run(["login", "--api-key", "cvt_test_key", "--profile", "p2", "--account", "acc_1", "--base-url", "https://api.example.test", "--json"], xdg);
    expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(readFileSync(cfg(xdg), "utf8")).profiles.p2).toMatchObject({ apiKey: "cvt_test_key", account: "acc_1", baseUrl: "https://api.example.test" });
    for (const flag of INERT) unknown(await run(["login", "--api-key", "cvt_test_key", "--profile", "p3", ...flag], xdg), flag[0]!);
    const help = await renderUsage(loginCommand as CommandDef);
    expect(help).toContain("--api-key");
    for (const [flag] of INERT) expect(help).not.toContain(flag);
  });

  it.each([
    [["config", "list", "--json"]],
    [["config", "set-account", "acc_9", "--profile", "p1", "--json"]],
    [["config", "set-base-url", "https://api.example.test", "--profile", "p1", "--json"]],
    [["config", "reset", "--profile", "nonexistent-profile", "--yes", "--json"]],
  ])("%j: its own flags are accepted; the inert ones and --api-key / --base-url are refused", async (ok) => {
    const xdg = configHome({ apiKey: "cvt_test_x" });
    mkdirSync(join(xdg, "curviate"), { recursive: true });
    writeFileSync(cfg(xdg), JSON.stringify({ active: "p1", profiles: { p1: { apiKey: "cvt_test_x" } } }));
    const good = await run(ok, xdg);
    expect(good.status, good.stderr).toBe(0);
    for (const flag of [...INERT, ["--api-key", "cvt_x"], ["--base-url", "https://x.test"]]) unknown(await run([...ok, ...flag], xdg), flag[0]!);
  });

  it("webhook verify (offline): its flags reach verification; the inert and API-bound ones are refused before it", async () => {
    const base = ["webhook", "verify", "--secret", "whsec_x", "--header", "t=1,v1=00", "--body", "{}", "--json"];
    const xdg = configHome();
    const ok = await run([...base, "--max-age-secs", "300"], xdg);
    expect(ok.stderr).not.toContain("unknown flag");
    expect(ok.stderr).toContain("webhook verification failed");
    for (const flag of [...INERT, ["--api-key", "cvt_x"], ["--base-url", "https://x.test"], ["--account", "acc_1"], ["--profile", "p1"]]) {
      const r = await run([...base, ...flag], xdg);
      unknown(r, flag[0]!);
      expect(r.stderr).not.toContain("webhook verification failed");
    }
  });

  it.each([
    [["config", "list", "--api-key=SECRETVAL"], "--api-key"],
    [["config", "list", "--api-key", "SECRETVAL"], "--api-key"],
    [["login", "--api-key", "cvt_test_key", "--timeout=SECRETVAL"], "--timeout"],
    [["webhook", "verify", "--secret", "s", "--header", "t=1,v1=0", "--body", "{}", "--api-key=SECRETVAL"], "--api-key"],
    [["profile", "me", "--no-such-flag=SECRETVAL"], "--no-such-flag"],
  ])("an unknown flag's value is never echoed: %j", async (args, flag) => {
    const r = await run(args, configHome());
    unknown(r, flag);
    expect(r.stdout + r.stderr).not.toContain("SECRETVAL");
  });
});
