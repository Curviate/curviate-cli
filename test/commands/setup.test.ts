/**
 * `curviate setup`: the flow, its ordering, retries and refusals (everything impure injected: terminal, transport,
 * browser, verifying call, session material), then the leak grep through the CLI entry point with a positive control.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CurviateError } from "@curviate/sdk";
import { mkdtempSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runSetup, resolveSetupIO, resumeStatePath, normaliseCode, authorizeUrl, browserAvailable, generateSessionMaterial, unsealApiKey,
  type SetupIO, type SessionMaterial,
} from "../../src/commands/setup.js";
import { seal } from "../helpers/f2-seal.js";
import { useSink } from "../helpers/sink.js";

const API_KEY = "rdc_live_SETUPFIXTUREKEY0001";
const TENANT = "Fixture Workspace";
const CODE = "WDJB-MJHT";
const BASE_URL = "http://127.0.0.1:9/api";

type Body = { session_id: string; verification_code: string };
type Responder = (body: Body, material: SessionMaterial) => { status: number; json: unknown } | "network-failure";
const acceptAll: Responder = (_b, m) => ({ status: 200, json: { sealed_key: seal(API_KEY, m.publicKey), tenant_name: TENANT, account_id: "acc_fixture_1" } });
const reject = (code: string, message = "no", status = 400): Responder => () => ({ status, json: { code, message } });
/** Rejects the first `n` submissions with a wrong code, then accepts. */
const rejectFirst = (n: number): Responder => {
  let seen = 0;
  return (b, m) => (seen++ < n ? reject("CLI_SETUP_INVALID_CODE")(b, m) : acceptAll(b, m));
};

interface Opts { answers?: string[]; respond?: Responder; isTTY?: boolean; isOutputTTY?: boolean; env?: NodeJS.ProcessEnv; platform?: string; stdin?: string; verifyError?: unknown; openThrows?: boolean }
function harness(opts: Opts = {}) {
  const material = generateSessionMaterial();
  const answers = [...(opts.answers ?? [])];
  const h = { stdout: [] as string[], stderr: [] as string[], prompts: [] as string[], opened: [] as string[], requests: [] as Body[], stdinReads: 0, transcript: [] as string[], material, io: undefined as unknown as SetupIO };
  h.io = {
    stdout: { write: (s: string) => (h.stdout.push(s), h.transcript.push(`stdout:${s}`)) },
    stderr: { write: (s: string) => (h.stderr.push(s), h.transcript.push(`stderr:${s}`)) },
    isTTY: opts.isTTY ?? true,
    isOutputTTY: opts.isOutputTTY ?? true,
    env: opts.env ?? {},
    platform: opts.platform ?? "darwin",
    prompt: async (p: string) => (h.prompts.push(p), h.transcript.push(`prompt:${p}`), answers.shift() ?? ""),
    readStdin: async () => (h.stdinReads++, opts.stdin ?? ""),
    open: async (url: string) => {
      h.opened.push(url);
      h.transcript.push(`open:${url}`);
      if (opts.openThrows) throw new Error("no browser");
    },
    fetch: (async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Body;
      h.requests.push(body);
      const o = (opts.respond ?? acceptAll)(body, material);
      if (o === "network-failure") throw new TypeError("fetch failed");
      return { ok: o.status < 300, status: o.status, json: async () => o.json } as unknown as Response;
    }) as unknown as typeof fetch,
    verify: async () => {
      if (opts.verifyError !== undefined) throw opts.verifyError;
    },
    generate: () => material,
  };
  return h;
}
const run = (h: ReturnType<typeof harness>, flags: object = {}) => runSetup({ "base-url": BASE_URL, ...flags } as never, h.io);

let xdg: string;
let configPath: string;
beforeEach(() => {
  xdg = mkdtempSync(join(tmpdir(), "curviate-setup-"));
  process.env["XDG_CONFIG_HOME"] = xdg;
  configPath = join(xdg, "curviate", "config.json");
  delete process.env["CURVIATE_API_KEY"];
  delete process.env["CURVIATE_BASE_URL"];
});
afterEach(() => {
  delete process.env["XDG_CONFIG_HOME"];
  rmSync(xdg, { recursive: true, force: true });
});
const stored = (name = "default") => (JSON.parse(readFileSync(configPath, "utf8")) as { profiles: Record<string, { apiKey?: string; account?: string; tenant?: string }> }).profiles[name];

describe("pure helpers", () => {
  it("normaliseCode uppercases, drops the hyphen and everything outside the alphabet (incl. a bracketed paste)", () => {
    for (const raw of ["WDJB-MJHT", "wdjb-mjht", "wdjbmjht", "  WDJB-MJHT  \n", "\x1b[200~wdjb-mjht\x1b[201~", "WDJB-MJHTAEIOU0159"]) expect(normaliseCode(raw)).toBe("WDJBMJHT");
  });

  it("session material: 144-bit id, raw uncompressed P-256 point, never repeated", () => {
    const a = generateSessionMaterial();
    const b = generateSessionMaterial();
    expect(Buffer.from(a.sessionId, "base64url").length * 8).toBe(144);
    const raw = Buffer.from(a.publicKey, "base64url");
    expect([raw.length, raw[0]]).toEqual([65, 0x04]);
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.publicKey).not.toBe(b.publicKey);
  });

  it.each([
    ["https://example.test/api", "https://example.test/cli?sid=S&pk=P"],
    ["https://example.test", "https://example.test/cli?sid=S&pk=P"],
    ["https://api.curviate.com", "https://app.curviate.com/cli?sid=S&pk=P"], // the page is the app host, not the api host
    ["https://api.staging.curviate.com", "https://app.staging.curviate.com/cli?sid=S&pk=P"],
    ["http://localhost:3000", "http://localhost:3000/cli?sid=S&pk=P"],
    ["http://127.0.0.1:8080/api", "http://127.0.0.1:8080/cli?sid=S&pk=P"],
    ["http://api:3000", "http://api:3000/cli?sid=S&pk=P"], // bare "api" is a hostname, not a label to swap
  ])("authorizeUrl(%s) -> %s", (base, expected) => {
    expect(authorizeUrl(base, "S", "P")).toBe(expected);
  });

  it("an explicit override wins, and keeps its path; the command honours it", async () => {
    expect(authorizeUrl("https://api.curviate.com", "S", "P", "https://example.test/console/")).toBe("https://example.test/console/cli?sid=S&pk=P");
    const h = harness({ answers: [CODE], env: { CI: "1", CURVIATE_APP_URL: "https://dash.example.test" } });
    await run(h, { "base-url": "https://api.curviate.com" });
    expect(h.stdout.join("")).toContain("https://dash.example.test/cli?sid=");
  });

  it("unsealing recovers the plaintext from an independently built ciphertext, and refuses another key's", () => {
    const m = generateSessionMaterial();
    expect(unsealApiKey(seal(API_KEY, m.publicKey), m.privateKey)).toBe(API_KEY);
    expect(() => unsealApiKey(seal(API_KEY, generateSessionMaterial().publicKey), m.privateKey)).toThrow();
  });

  it("browser detection reads the environment: CI, a remote shell and a displayless session are browserless", () => {
    for (const [env, platform] of [[{ CI: "1" }, "darwin"], [{ SSH_CONNECTION: "1 2 3 4" }, "darwin"], [{ SSH_TTY: "/dev/pts/0" }, "darwin"], [{ SSH_CLIENT: "1.2.3.4" }, "darwin"], [{ DISPLAY: "" }, "linux"], [{}, "linux"]] as const) {
      expect(browserAvailable(env, platform)).toBe(false);
    }
    expect(browserAvailable({}, "darwin")).toBe(true);
    expect(browserAvailable({ DISPLAY: ":0" }, "linux")).toBe(true);
  });
});

describe("the happy path", () => {
  it("writes the key at 0600 under the named profile, verifies, names the workspace, submits only the normalised code, and clears the parked material", async () => {
    const h = harness({ answers: ["  wdjbmjht \n"] });
    expect(await run(h, { profile: "work" })).toBe(0);
    expect(stored("work")).toMatchObject({ apiKey: API_KEY, account: "acc_fixture_1", tenant: TENANT });
    expect(stored("default")).toBeUndefined();
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(h.stderr.join("")).toContain(TENANT);
    expect(h.requests).toEqual([{ session_id: h.material.sessionId, verification_code: "WDJBMJHT" }]);
    expect(existsSync(resumeStatePath())).toBe(false);
  });

  it("prints the authorize URL to a stream before the first prompt and before the browser open; still prints it with no terminal (exit 2)", async () => {
    const h = harness({ answers: [CODE] });
    await run(h);
    const at = (pred: (l: string) => boolean) => h.transcript.findIndex(pred);
    const urlAt = at((l) => l.startsWith("stdout:") && l.includes("/cli?sid="));
    expect(urlAt).toBeGreaterThanOrEqual(0);
    expect(at((l) => l.startsWith("prompt:"))).toBeGreaterThan(urlAt);
    expect(at((l) => l.startsWith("open:"))).toBeGreaterThan(urlAt);
    const noTty = harness({ isTTY: false });
    expect(await run(noTty)).toBe(2);
    expect(noTty.stdout.join("")).toContain("/cli?sid=");
  });
});

describe("retries and the distinct failures", () => {
  it("offers exactly two labelled retries, succeeding on the third; gives up after the third wrong code (exit 3, no profile written)", async () => {
    const ok = harness({ answers: ["ZZZZZZZZ", "XXXXXXXX", CODE], respond: rejectFirst(2) });
    expect(await run(ok)).toBe(0);
    expect(ok.prompts).toEqual(["Paste the code: ", "Retry (1/2): ", "Retry (2/2): "]);
    const bad = harness({ answers: ["ZZZZZZZZ", "XXXXXXXX", "VVVVVVVV"], respond: rejectFirst(99) });
    expect(await run(bad)).toBe(3);
    expect(bad.requests).toHaveLength(3);
  });

  it("a wrong code, an expired code and an unreachable API read differently (exits 3, 3, 7); expired is not retried", async () => {
    const msg = (h: ReturnType<typeof harness>) => h.stderr.filter((l) => l.startsWith("error:")).join("");
    const wrong = harness({ answers: ["ZZZZZZZZ", "XXXXXXXX", "VVVVVVVV"], respond: rejectFirst(99) });
    const expired = harness({ answers: [CODE, CODE, CODE], respond: reject("CLI_SETUP_EXPIRED", "gone") });
    const down = harness({ answers: [CODE], respond: () => "network-failure" });
    expect([await run(wrong), await run(expired), await run(down)]).toEqual([3, 3, 7]);
    const msgs = [wrong, expired, down].map(msg);
    for (const m of msgs) expect(m.length).toBeGreaterThan(20);
    expect(new Set(msgs).size).toBe(3);
    expect(expired.requests).toHaveLength(1);
  });

  it("a revoked key surfaces the server's own message (exit 3); the endpoint cap exits 6", async () => {
    const named = "This workspace has no API key. Create one in the dashboard.";
    const h = harness({ answers: [CODE], respond: reject("CLI_SETUP_NO_API_KEY", named, 409) });
    expect(await run(h)).toBe(3);
    expect(h.stderr.join("")).toContain(named);
    expect(await run(harness({ answers: [CODE], respond: reject("PLATFORM_RATE_LIMIT", "slow", 429) }))).toBe(6);
  });
});

describe("headless environments", () => {
  it.each([
    ["CI", { CI: "true" }, "darwin"],
    ["a remote shell", { SSH_CONNECTION: "1.2.3.4 1 5.6.7.8 22" }, "darwin"],
    ["a displayless session", { DISPLAY: "" }, "linux"],
  ])("%s: no open attempted, URL printed, paste works", async (_l, env, platform) => {
    const h = harness({ answers: [CODE], env, platform });
    expect(await run(h)).toBe(0);
    expect(h.opened).toEqual([]);
    expect(h.stdout.join("")).toContain("/cli?sid=");
  });

  it("--no-browser says so where a browser exists, nothing where none does; a browser that refuses to open is no error", async () => {
    const withBrowser = harness({ answers: [CODE] });
    await run(withBrowser, { "no-browser": true });
    expect([withBrowser.opened, withBrowser.stderr.join("")]).toEqual([[], expect.stringMatching(/--no-browser/)]);
    const headless = harness({ answers: [CODE], env: { CI: "1" } });
    await run(headless, { "no-browser": true });
    expect(headless.stderr.join("")).not.toMatch(/--no-browser/);
    expect(await run(harness({ answers: [CODE], openThrows: true }))).toBe(0);
  });

  it("a non-terminal invocation names both remedies, exits 2 and never reads stdin", async () => {
    const h = harness({ isTTY: false, stdin: "WDJBMJHT" });
    expect(await run(h)).toBe(2);
    expect(h.stderr.join("")).toContain("CURVIATE_API_KEY");
    expect(h.stderr.join("")).toContain("curviate login --api-key -");
    expect([h.stdinReads, h.prompts]).toEqual([0, []]);
  });

  it("fully piped (both streams) is the agent path: exit 0 with the agent object; a terminal output with no stdin still fails fast", async () => {
    const piped = harness({ isTTY: false, isOutputTTY: false, stdin: CODE });
    expect(await run(piped)).toBe(0);
    expect(JSON.parse(piped.stdout.join("")).next_step).toBe("curviate setup --code -");
    expect([piped.stdinReads, piped.stderr.join("")]).toEqual([0, expect.not.stringContaining("CURVIATE_API_KEY")]);
    const human = harness({ isTTY: false, isOutputTTY: true });
    expect(await run(human)).toBe(2);
    expect(human.stderr.join("")).toContain("CURVIATE_API_KEY");
  });
});

describe("setup --json (agent path) and setup --code - (resume)", () => {
  it("emits one object with the URL and a runnable next step, prompts/opens/calls nothing, parks the material at 0600", async () => {
    const h = harness();
    expect(await run(h, { json: true })).toBe(0);
    expect(h.stdout).toHaveLength(1);
    const emitted = JSON.parse(h.stdout[0]!) as Record<string, unknown>;
    expect(emitted["authorize_url"]).toContain("/cli?sid=");
    expect(emitted["next_step"]).toBe("curviate setup --code -");
    expect(Object.keys(emitted).sort()).toEqual(["authorize_url", "instructions", "next_step"]);
    expect(h.stdout.join("")).not.toContain(h.material.privateKey);
    expect(h.stderr.join("")).not.toContain(h.material.sessionId);
    expect([h.prompts, h.opened, h.requests]).toEqual([[], [], []]);
    expect(statSync(resumeStatePath()).mode & 0o777).toBe(0o600);
  });

  const resume = async (second: Opts, flags: object) => {
    const first = harness();
    await run(first, { json: true });
    const h = harness({ ...second, respond: () => ({ status: 200, json: { sealed_key: seal(API_KEY, first.material.publicKey), tenant_name: TENANT } }) });
    return { first, h, exit: await runSetup(flags as never, h.io) };
  };

  it("--code - reads the code from stdin, redeems the parked session with the parked key, and clears the parked state (no replay)", async () => {
    const { first, h, exit } = await resume({ stdin: "wdjb-mjht" }, { code: "-", json: true });
    expect(exit).toBe(0);
    expect([h.stdinReads, h.requests]).toEqual([1, [{ session_id: first.material.sessionId, verification_code: "WDJBMJHT" }]]);
    expect(stored()?.apiKey).toBe(API_KEY);
    expect(existsSync(resumeStatePath())).toBe(false);
    expect(h.stderr.join("")).not.toMatch(/shell history/);
    const replay = harness({ stdin: CODE });
    expect(await runSetup({ code: "-", json: true } as never, replay.io)).toBe(2);
    expect(replay.requests).toEqual([]);
  });

  it("with no flow in progress it says so; a code given as a flag VALUE earns the ps/shell-history warning and reads no stdin", async () => {
    const none = harness({ stdin: CODE });
    expect(await runSetup({ code: "-", json: true } as never, none.io)).toBe(2);
    expect(none.stderr.join("")).toContain("no setup is in progress");
    const { h, exit } = await resume({}, { code: CODE, json: true });
    expect(exit).toBe(0);
    expect(h.stderr.join("")).toMatch(/shell history/);
    expect(h.stdinReads).toBe(0);
  });
});

describe("the credential is proven, not assumed", () => {
  it("a failing verifying call exits 3; one with no readable answer exits 7 (platform fault)", async () => {
    const failed = harness({ answers: [CODE], verifyError: new Error("rejected") });
    expect(await run(failed)).toBe(3);
    expect(failed.stderr.join("")).toMatch(/verifying call/);
    const unreadable = harness({ answers: [CODE], verifyError: new CurviateError({ code: "PLATFORM_ERROR", message: "x", httpStatus: 502, userFixable: false, retryLikelyToSucceed: true } as never) });
    expect(await run(unreadable)).toBe(7);
  });

  describe("the default verifying call requires a real account page", () => {
    const sink = useSink();
    it.each(["", "null", "{}", '{"items":null}', '{"items":"x"}', "[]"])("%j is PLATFORM_ERROR; a real page verifies", async (unreadable) => {
      sink.reply = { type: "application/json", body: unreadable };
      await expect(resolveSetupIO({}).verify("cvt_test_x", sink.url)).rejects.toMatchObject({ code: "PLATFORM_ERROR" });
      sink.reply = { body: { object: "list", items: [], cursor: null } };
      await expect(resolveSetupIO({}).verify("cvt_test_x", sink.url)).resolves.toBeUndefined();
    });
  });
});

describe("nothing leaks: a full two-leg setup through the CLI entry point", () => {
  const LEAK_KEY = "rdc_live_LEAKPROBE_9f3a1c7e5b2d";
  const sink = useSink();

  it("neither stream carries the key, the code (either spelling), the private key, or the session id outside the authorize URL; the profile does hold the key (positive control)", async () => {
    let exchanges = 0;
    const state = {} as { parked: { sessionId: string; publicKey: string; privateKey: string } };
    sink.reply = (hit) => {
      if (!hit.url.startsWith("/api/auth/cli/exchange")) return { body: { items: [], cursor: null } };
      exchanges++;
      const b = JSON.parse(hit.body) as Body;
      if (b.session_id !== state.parked.sessionId || b.verification_code !== "WDJBMJHT") return { status: 400, body: { code: "CLI_SETUP_INVALID_CODE", message: "no" } };
      return { body: { sealed_key: seal(LEAK_KEY, state.parked.publicKey), tenant_name: "Leak Probe Workspace", account_id: "acc_leak_probe" } };
    };
    const home = join(xdg, "leg");
    const first = await sink.run(["setup", "--json", "--base-url", sink.url], { xdg: home, env: { CURVIATE_API_KEY: undefined } });
    const statePath = join(home, "curviate", "setup-session.json");
    state.parked = JSON.parse(readFileSync(statePath, "utf8"));
    const url = (JSON.parse(first.stdout.trim()) as { authorize_url: string }).authorize_url;
    const second = await sink.run(["setup", "--code", "-", "--base-url", sink.url], { xdg: home, stdin: "wdjb-mjht", env: { CURVIATE_API_KEY: undefined } });

    expect([first.status, second.status, exchanges], first.stderr + second.stderr).toEqual([0, 0, 1]);
    const profile = readFileSync(join(home, "curviate", "config.json"), "utf8");
    expect(profile.split(LEAK_KEY)).toHaveLength(2);
    expect(profile).toContain("Leak Probe Workspace");
    expect(statSync(join(home, "curviate", "config.json")).mode & 0o777).toBe(0o600);
    const streams = [first.stdout, first.stderr, second.stdout, second.stderr].join("\n");
    expect(second.stdout + second.stderr).toContain("Leak Probe Workspace");
    const rest = streams.split(url).join("<authorize-url>");
    for (const secret of [LEAK_KEY, "wdjb-mjht", "WDJBMJHT", state.parked.sessionId]) expect(rest).not.toContain(secret);
    expect(streams).not.toContain(state.parked.privateKey);
    expect(existsSync(statePath)).toBe(false);
  });
});
