/**
 * LinkedIn-account credential input safety on `account link` / `account update`: env fallbacks, `--*-stdin`,
 * the stdin/flag conflict matrix, the masked TTY prompt and non-TTY fail-fast, TTY single-line stdin, --preview masking,
 * and the invariant that a resolved secret reaches only the SDK request body (never stdout/stderr/--preview).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { accountCommand, runAccountLink, runAccountUpdate } from "../../src/commands/account.js";
import { exitCode } from "../helpers/exit-code.js";

const client = { accounts: { update: vi.fn() }, auth: { intent: vi.fn() } };
let out: { stdout: { write: Mock }; stderr: { write: Mock } };
const ENV = ["CURVIATE_LINKEDIN_PASSWORD", "CURVIATE_LINKEDIN_LI_AT", "CURVIATE_LINKEDIN_LI_A", "CURVIATE_PROXY_PASSWORD"];
beforeEach(() => {
  vi.resetAllMocks();
  client.auth.intent.mockResolvedValue({ object: "account", account_id: "acc_1" });
  client.accounts.update.mockResolvedValue({ object: "account" });
  out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
  for (const k of ENV) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
});
const text = (w: { write: Mock }) => w.write.mock.calls.map((c) => c[0] as string).join("");
const both = () => text(out.stdout) + text(out.stderr);
const CRED = { "seat-id": "seat_1", "auth-method": "credentials", country: "US", email: "a@b.c", json: true };
const COOKIE = { "seat-id": "seat_1", "auth-method": "cookie", country: "US", "user-agent": "UA", json: true };
const link = (flags: object, io?: object) => runAccountLink(client as never, flags as never, out, io as never);
const intentBody = () => client.auth.intent.mock.calls[0]![0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const MASK = "••••";

describe("env-var precedence (flag > env > omitted)", () => {
  it("password: flag beats env; env used with no flag; an empty flag falls through to env", async () => {
    process.env["CURVIATE_LINKEDIN_PASSWORD"] = "FROM_ENV";
    await link({ ...CRED, password: "FROM_FLAG" });
    expect(intentBody().credentials).toEqual({ email: "a@b.c", password: "FROM_FLAG" });
    for (const flags of [CRED, { ...CRED, password: "" }]) {
      client.auth.intent.mockClear();
      await link(flags);
      expect(intentBody().credentials).toEqual({ email: "a@b.c", password: "FROM_ENV" });
    }
  });

  it("li_a: flag wins over env, and the key is omitted entirely when neither is set", async () => {
    process.env["CURVIATE_LINKEDIN_LI_A"] = "ENV_LIA";
    await link({ ...COOKIE, "li-at": "AT", "li-a": "FLAG_LIA" });
    expect(intentBody().cookie).toEqual({ li_at: "AT", li_a: "FLAG_LIA" });
    delete process.env["CURVIATE_LINKEDIN_LI_A"];
    client.auth.intent.mockClear();
    await link({ ...COOKIE, "li-at": "AT" });
    expect(intentBody().cookie).toEqual({ li_at: "AT" });
  });

  it("proxy password on update: env used, omitted when unset", async () => {
    process.env["CURVIATE_PROXY_PASSWORD"] = "ENV_PROXY";
    const update = () => runAccountUpdate(client as never, { "account-id": "acc_1", "proxy-host": "proxy.example.com", json: true } as never, out);
    await update();
    expect(client.accounts.update).toHaveBeenLastCalledWith("acc_1", expect.objectContaining({ proxy: expect.objectContaining({ password: "ENV_PROXY" }) }));
    delete process.env["CURVIATE_PROXY_PASSWORD"];
    await update();
    expect(client.accounts.update.mock.calls[1]![1].proxy).not.toHaveProperty("password");
  });
});

describe("--password-stdin / --li-at-stdin", () => {
  it.each(["PWD_S\n", "PWD_S\r\n"])("--password-stdin resolves the piped secret and trims %j; the secret is never in the flags", async (piped) => {
    const flags = { ...CRED, "password-stdin": true };
    await link(flags, { readStdin: async () => piped });
    expect(intentBody().credentials).toEqual({ email: "a@b.c", password: "PWD_S" });
    expect(JSON.stringify(flags)).not.toContain("PWD_S");
  });

  it("--li-at-stdin resolves the piped cookie", async () => {
    await link({ ...COOKIE, "li-at-stdin": true }, { readStdin: async () => "LIAT_S\n" });
    expect(intentBody().cookie).toEqual({ li_at: "LIAT_S" });
  });

  it.each([
    ["--password + --password-stdin", { password: "x", "password-stdin": true, ...CRED }],
    ["--li-at + --li-at-stdin", { "li-at": "x", "li-at-stdin": true, ...COOKIE }],
    ["--password-stdin + --li-at-stdin", { "password-stdin": true, "li-at-stdin": true, ...CRED }],
    ["--li-at-stdin with --auth-method credentials", { "li-at-stdin": true, ...CRED }],
    ["--password-stdin with --auth-method cookie", { "password-stdin": true, ...COOKIE }],
  ])("conflict %s exits 2 with no connect", async (_l, flags) => {
    expect(await exitCode(() => link(flags))).toBe(2);
    expect(client.auth.intent).not.toHaveBeenCalled();
  });
});

describe("no source for a required secret", () => {
  it("TTY: the masked prompt resolves the password and never echoes it", async () => {
    await link(CRED, { isTTY: true, readline: async () => "PROMPTED" });
    expect(intentBody().credentials.password).toBe("PROMPTED");
    expect(text(out.stderr)).not.toContain("PROMPTED");
  });

  it("non-TTY: exit 2 naming password, and stdin is never read (no hang)", async () => {
    const readStdin = vi.fn(async () => "SHOULD_NOT_READ");
    expect(await exitCode(() => link(CRED, { isTTY: false, readStdin }))).toBe(2);
    expect(readStdin).not.toHaveBeenCalled();
    expect(text(out.stderr)).toContain("password");
    expect(client.auth.intent).not.toHaveBeenCalled();
  });

  it.each([true, false])("cookie with no li_at source exits 2 naming li_at (isTTY=%s: no cookie prompt by design)", async (isTTY) => {
    expect(await exitCode(() => link(COOKIE, { isTTY }))).toBe(2);
    expect(text(out.stderr)).toContain("li_at");
  });

  it("--preview never prompts and never fails fast: credentials render without the password, cookie renders too", async () => {
    await link({ ...CRED, preview: true }, { isTTY: false });
    expect(JSON.parse(text(out.stdout)).body.credentials).toEqual({ email: "a@b.c" });
    await link({ ...COOKIE, preview: true }, { isTTY: false });
    expect(client.auth.intent).not.toHaveBeenCalled();
  });
});

describe("TTY-mode stdin: one line, no EOF wait, no echo", () => {
  const STDIN = { ...CRED, "password-stdin": true };

  it("password and li_at: the typed value resolves; stderr shows the cue, never the secret", async () => {
    const readSingleLine = vi.fn(async () => "TTY_PWD");
    await link(STDIN, { isTTY: true, readSingleLine });
    expect(intentBody().credentials.password).toBe("TTY_PWD");
    expect(text(out.stderr)).toMatch(/paste/i);
    expect(text(out.stderr)).not.toContain("TTY_PWD");
    client.auth.intent.mockClear();
    out.stderr.write.mockClear();
    await link({ ...COOKIE, "li-at-stdin": true }, { isTTY: true, readSingleLine: vi.fn(async () => "TTY_LIAT") });
    expect(intentBody().cookie).toEqual({ li_at: "TTY_LIAT" });
    expect(text(out.stderr)).not.toContain("TTY_LIAT");
  });

  it("the read is gated by --preview only, not by --email", async () => {
    const readSingleLine = vi.fn(async () => "NO_EMAIL_PWD");
    await link({ "seat-id": "seat_1", "auth-method": "credentials", country: "US", "password-stdin": true, json: true }, { isTTY: true, readSingleLine });
    expect(readSingleLine).toHaveBeenCalledTimes(1);
    expect(intentBody().credentials).toEqual({ password: "NO_EMAIL_PWD" });
  });

  it("piped (non-TTY) and env paths never touch the single-line reader or the prompt", async () => {
    const readSingleLine = vi.fn(async () => "NO");
    await link(STDIN, { readStdin: async () => "PIPED_PW\n", readSingleLine });
    expect(intentBody().credentials.password).toBe("PIPED_PW");
    process.env["CURVIATE_LINKEDIN_PASSWORD"] = "envpw";
    client.auth.intent.mockClear();
    const readline = vi.fn(async () => "NO");
    const readStdin = vi.fn(async () => "NO");
    await link(CRED, { isTTY: true, readSingleLine, readline, readStdin });
    expect(intentBody().credentials.password).toBe("envpw");
    for (const f of [readSingleLine, readline, readStdin]) expect(f).not.toHaveBeenCalled();
  });

  it("an empty TTY line falls through the precedence order: env, else the masked prompt; li_at has no prompt tier (exit 2)", async () => {
    const readSingleLine = vi.fn(async () => "");
    const readline = vi.fn(async () => "PROMPTED_AFTER_EMPTY_LINE");
    await link(STDIN, { isTTY: true, readSingleLine, readline });
    expect(intentBody().credentials.password).toBe("PROMPTED_AFTER_EMPTY_LINE");
    process.env["CURVIATE_LINKEDIN_PASSWORD"] = "envpw";
    client.auth.intent.mockClear();
    readline.mockClear();
    await link(STDIN, { isTTY: true, readSingleLine, readline });
    expect(intentBody().credentials.password).toBe("envpw");
    expect(readline).not.toHaveBeenCalled();
    client.auth.intent.mockClear();
    expect(await exitCode(() => link({ ...COOKIE, "li-at-stdin": true }, { isTTY: true, readSingleLine: async () => "" }))).toBe(2);
    expect(client.auth.intent).not.toHaveBeenCalled();
    expect(text(out.stderr)).toContain("li_at");
  });

  it("--preview suppresses the TTY read (no reader call, no cue); piped --preview still reads and masks", async () => {
    const readSingleLine = vi.fn(async () => "SHOULD_NOT_BE_CALLED");
    await link({ ...STDIN, preview: true }, { isTTY: true, readSingleLine });
    await link({ ...COOKIE, "li-at-stdin": true, preview: true }, { isTTY: true, readSingleLine });
    expect(readSingleLine).not.toHaveBeenCalled();
    expect(out.stderr.write).not.toHaveBeenCalled();
    out.stdout.write.mockClear();
    await link({ ...STDIN, preview: true }, { isTTY: false, readStdin: async () => "PIPED_PREVIEW_PW\n" });
    expect(text(out.stdout)).toContain(MASK);
    expect(text(out.stdout)).not.toContain("PIPED_PREVIEW_PW");
    expect(client.auth.intent).not.toHaveBeenCalled();
  });
});

describe("a secret never reaches stdout/stderr", () => {
  const SENTINEL = "LI_SENTINEL_MUST_NOT_LEAK";

  it.each([
    ["flag", { ...CRED, password: SENTINEL }, {}],
    ["stdin", { ...CRED, "password-stdin": true }, { readStdin: async () => SENTINEL }],
    ["env", CRED, {}],
  ])("the %s-sourced sentinel is sent in the body and appears in no output", async (src, flags, io) => {
    if (src === "env") process.env["CURVIATE_LINKEDIN_PASSWORD"] = SENTINEL;
    await link(flags, io);
    expect(intentBody().credentials.password).toBe(SENTINEL);
    expect(both()).not.toContain(SENTINEL);
  });

  it.each([
    ["password", () => link({ ...CRED, password: SENTINEL, preview: true })],
    ["cookie li_at and li_a", () => link({ ...COOKIE, "li-at": SENTINEL, "li-a": `${SENTINEL}_A`, preview: true })],
    ["proxy.password (update)", () => runAccountUpdate(client as never, { "account-id": "acc_1", "proxy-host": "p.example.com", "proxy-password": SENTINEL, preview: true } as never, out)],
  ])("--preview masks the %s", async (_l, go) => {
    await go();
    expect(text(out.stdout)).not.toContain(SENTINEL);
    expect(text(out.stdout)).toContain(MASK);
  });

  it("masking runs on a copy: a later non-preview call with the same flags still sends the real secret", async () => {
    const flags = { ...CRED, password: SENTINEL };
    await link({ ...flags, preview: true });
    await link(flags);
    expect(intentBody().credentials).toEqual({ email: "a@b.c", password: SENTINEL });
  });
});

describe("secret value flags warn about ps / shell history and name their alternative", () => {
  type Args = Record<string, { description?: string }>;
  const argsOf = (cmd: string) => (accountCommand as unknown as { subCommands: Record<string, { args: Args }> }).subCommands[cmd]!.args;
  it("link: --password/--li-at/--li-a/--proxy-password warn; the -stdin flags do not; update warns only on --proxy-password", () => {
    const link = argsOf("link");
    for (const [flag, env] of [["password", "CURVIATE_LINKEDIN_PASSWORD"], ["li-at", "CURVIATE_LINKEDIN_LI_AT"], ["li-a", "CURVIATE_LINKEDIN_LI_A"], ["proxy-password", "CURVIATE_PROXY_PASSWORD"]] as const) {
      expect(link[flag]?.description).toMatch(/ps|shell history/i);
      expect(link[flag]?.description).toContain(env);
    }
    for (const f of ["password-stdin", "li-at-stdin"]) expect(link[f]?.description).not.toMatch(/ps|shell history/i);
    const update = argsOf("update");
    expect(update["proxy-password"]?.description).toMatch(/ps|shell history/i);
    expect(update).not.toHaveProperty("password");
    expect(update).not.toHaveProperty("li-at");
  });
});
