/**
 * Connecting an account: connect requests, `link --cookies-file`, and the guided checkpoint copy. Over the wire where
 * the request is the property (sink), against a mock client where the prompt loop is.
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAccountLink } from "../../src/commands/account.js";
import { exitCode } from "../helpers/exit-code.js";
import { useSink, line, type Hit } from "../helpers/sink.js";

const REQ = { object: "connect_request", id: "creq_1", kind: "connect", status: "pending", account_id: null, error_code: null, url: "https://app.example.test/accounts/connect/creq_1", expires_at: "2026-10-08T10:15:00Z", created_at: "2026-10-08T10:00:00Z", completed_at: null };
const ERR = (code: string, status: number) => ({ status, body: { code, message: `${code} message`, user_fixable: true, retry_likely_to_succeed: false } });
const sink = useSink((h: Hit) => {
  if (h.url.startsWith("/v1/auth/connect-requests/creq_used")) return ERR(h.url.endsWith("/cancel") ? "CONNECT_REQUEST_NOT_PENDING" : "CONNECT_REQUEST_IN_USE", 409);
  if (h.url.startsWith("/v1/auth/connect-requests")) return { status: h.method === "POST" && !h.url.endsWith("/cancel") ? 201 : 200, body: REQ };
  return { status: 201, body: { object: "account", account_id: "acc_1", status: "active" } };
});

describe("account connect-request", () => {
  it.each([
    [["create"], "POST /v1/auth/connect-requests", {}],
    [["create", "--reconnect", "acc_x"], "POST /v1/auth/connect-requests", { account_id: "acc_x" }],
    [["get", "creq_1"], "GET /v1/auth/connect-requests/creq_1", undefined],
    [["cancel", "creq_1"], "POST /v1/auth/connect-requests/creq_1/cancel", undefined],
  ])("%j sends %s", async (args, request, body) => {
    const r = await sink.run(["account", "connect-request", ...args, "--json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(line(r.requests[0]!)).toBe(request);
    if (body !== undefined) expect(JSON.parse(r.requests[0]!.body || "{}")).toEqual(body);
    expect(JSON.parse(r.stdout)).toMatchObject({ id: "creq_1", status: "pending" }); // the request, verbatim
  });

  it("human create prints the link, the expiry and the instruction", async () => {
    const r = await sink.run(["account", "connect-request", "create"]);
    const text = r.stdout + r.stderr;
    expect(r.stdout).toContain(REQ.url);
    expect(r.stdout).toContain(REQ.expires_at);
    expect(text).toMatch(/Never ask them for their LinkedIn password/);
  });

  it.each([["cancel", "CONNECT_REQUEST_NOT_PENDING"], ["get", "CONNECT_REQUEST_IN_USE"]])("%s of a request the API refuses exits 8", async (verb) => {
    expect((await sink.run(["account", "connect-request", verb, "creq_used", "--json"])).status).toBe(8);
  });
});

describe("account link --cookies-file", () => {
  const FUTURE = Math.floor(Date.now() / 1000) + 86_400;
  const cookie = (name: string, value: string, extra: object = {}) => ({ name, value, domain: ".linkedin.com", expirationDate: FUTURE, ...extra });
  const EXPORT = JSON.stringify([cookie("li_at", "AT_VALUE"), cookie("li_a", "A_VALUE"), cookie("JSESSIONID", '"ajax:1"'), { name: "tz", value: "Europe/Berlin", domain: "www.linkedin.com" }]);
  const base = ["account", "link", "--cookies-file", "-", "--user-agent", "UA/1", "--seat-id", "seat_1", "--country", "US", "--json"];

  it("sends li_at, li_a and user_agent from a piped export; no timezone, and the env li_at is not the one sent", async () => {
    const r = await sink.run(base, { stdin: EXPORT, env: { CURVIATE_LINKEDIN_LI_AT: "ENV_AT" } });
    expect(r.status, r.stderr).toBe(0);
    expect(line(r.requests[0]!)).toBe("POST /v1/auth/intent");
    const body = JSON.parse(r.requests[0]!.body) as Record<string, unknown>;
    expect(body).toMatchObject({ auth_method: "cookie", cookie: { li_at: "AT_VALUE", li_a: "A_VALUE" }, user_agent: "UA/1" });
    expect(body).not.toHaveProperty("timezone");
    expect(r.stdout + r.stderr).not.toContain("AT_VALUE");
  });

  it("reads a path, and a missing path exits 2 naming it with no request", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "cookies-")), "export.json");
    writeFileSync(file, EXPORT);
    const ok = await sink.run(["account", "link", "--cookies-file", file, "--user-agent", "UA/1", "--seat-id", "seat_1", "--country", "US", "--json"]);
    expect(JSON.parse(ok.requests[0]!.body)).toMatchObject({ cookie: { li_at: "AT_VALUE" } });
    const missing = await sink.run(["account", "link", "--cookies-file", `${file}.nope`, "--user-agent", "UA/1", "--seat-id", "seat_1", "--country", "US"]);
    expect([missing.status, missing.requests.length]).toEqual([2, 0]);
    expect(missing.stderr).toContain(`${file}.nope`);
  });

  it.each([
    [["--li-at", "X"], "--li-at"],
    [["--li-at-stdin"], "--li-at-stdin"],
    [["--li-a", "X"], "--li-a"],
    [["--email", "a@b.c"], "--email"],
    [["--password", "p"], "--password"],
    [["--password-stdin"], "--password-stdin"],
    [["--auth-method", "credentials"], "--auth-method credentials"],
  ])("combined with %j exits 2 naming both flags, with no request", async (extra, named) => {
    const r = await sink.run([...base, ...extra], { stdin: EXPORT });
    expect([r.status, r.requests.length]).toEqual([2, 0]);
    expect(r.stderr).toContain("--cookies-file");
    expect(r.stderr).toContain(named);
  });

  it("without --user-agent exits 2 with no request", async () => {
    const r = await sink.run(["account", "link", "--cookies-file", "-", "--seat-id", "seat_1", "--country", "US"], { stdin: EXPORT });
    expect([r.status, r.requests.length]).toEqual([2, 0]);
    expect(r.stderr).toContain("navigator.userAgent");
  });

  it.each([
    ["", "Paste the export from Cookie-Editor."],
    ["not json at all", "This isn't a JSON export."],
    ['{"a":1}', "This JSON isn't a Cookie-Editor export."],
    ["# Netscape HTTP Cookie File\n.linkedin.com\tTRUE\t/\tTRUE\t0\tli_at\tX", "This is the Netscape export."],
    ["li_at=X; JSESSIONID=Y", "This is the Header String export."],
    [JSON.stringify([{ name: "a", value: "b", domain: ".example.com" }]), "These cookies are from another website."],
    [JSON.stringify([cookie("JSESSIONID", "x")]), "No LinkedIn session cookie (li_at) found."],
    [JSON.stringify([cookie("li_at", "X", { expirationDate: 1_700_000_000 })]), "expired on 2023-11-14."],
    [JSON.stringify([cookie("li_at", "X"), cookie("JSESSIONID", "x".repeat(1_100_000))]), "This export is too large."],
  ])("an export the parser refuses (%#) exits 2 with its message, no request, and never quotes the input", async (input, message) => {
    const r = await sink.run(base, { stdin: input });
    expect([r.status, r.requests.length]).toEqual([2, 0]);
    expect(r.stderr).toContain(message);
    expect(r.stderr).not.toContain("li_at=X");
  });

  it("li_a expired: connects without it and says so; the newest unexpired li_at wins", async () => {
    const input = JSON.stringify([cookie("li_at", "OLD", { expirationDate: FUTURE }), cookie("li_at", "NEW", { expirationDate: FUTURE + 100 }), cookie("li_a", "GONE", { expirationDate: 1_700_000_000 })]);
    const r = await sink.run(base, { stdin: input });
    expect(JSON.parse(r.requests[0]!.body).cookie).toEqual({ li_at: "NEW" });
    expect(r.stderr).toContain("Sales Navigator or Recruiter session in this export has expired");
  });

  it("--preview masks the cookies and sends nothing", async () => {
    const r = await sink.run([...base, "--preview"], { stdin: EXPORT });
    expect(r.requests).toHaveLength(0);
    expect(r.stdout).not.toContain("AT_VALUE");
    expect(JSON.parse(r.stdout).body.cookie).toEqual({ li_at: "••••", li_a: "••••" });
  });

  it("help carries the live-session warning and points agents at connect-request", async () => {
    const r = await sink.run(["account", "link", "--help"]);
    expect(r.stdout).toMatch(/live LinkedIn session/);
    expect(r.stdout).toContain("account connect-request create");
  });
});

describe("guided checkpoint", () => {
  const out = () => ({ stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });
  const text = (m: Mock) => m.mock.calls.map((c) => c[0] as string).join("");
  const LINK = { "seat-id": "seat_1", "auth-method": "credentials", country: "US", email: "a@b.c", password: "p", json: true };
  const cp = (challenge_type: string, extra: object = {}) => ({ object: "checkpoint", status: "checkpoint_required", account_id: "acc_p", challenge_type, expires_at: "2099-01-01T00:00:00Z", ...extra });
  const io = (answers: string[]) => ({ isTTY: true, isOutputTTY: true, readline: vi.fn(async () => answers.shift() ?? ""), sleep: async () => {}, now: () => 0 });

  async function run(first: object, client: object, answers: string[] = []) {
    const o = out();
    const intent = vi.fn().mockResolvedValue(first);
    const code = await exitCode(() => runAccountLink({ auth: { intent, ...client } } as never, LINK as never, o, io(answers) as never));
    return { code, err: text(o.stderr.write) };
  }
  const ACTIVE = { object: "account", account_id: "acc_p", status: "active" };

  it.each([
    ["email", "Check your email"],
    ["sms", "Check your text messages"],
    ["whatsapp", "Check WhatsApp"],
    [null, "Enter the verification code"],
  ])("an otp checkpoint on channel %s reads %j", async (channel, title) => {
    const solve = vi.fn().mockResolvedValue(ACTIVE);
    const r = await run(cp("otp", { channel }), { solveCheckpoint: solve }, ["123456"]);
    expect(r.err).toContain(title);
    if (channel === null) expect(r.err).not.toMatch(/email|text message|WhatsApp/i);
    expect(r.err).toContain("TRY_ANOTHER_WAY"); // the footer, beside Re-send
    expect(solve).toHaveBeenCalledWith("acc_p", { code: "123456" });
  });

  it("a phone step takes the number as (+CC)number, re-asks on a bare one, and never prints it", async () => {
    const solve = vi.fn().mockResolvedValue(cp("otp", { channel: "sms" }));
    solve.mockResolvedValueOnce(cp("otp", { channel: "sms" })).mockResolvedValue(ACTIVE);
    const r = await run(cp("phone_register"), { solveCheckpoint: solve }, ["+4915112345678", "(+49) 151-12345678", "123456"]);
    expect(solve.mock.calls.map((c) => c[1])).toEqual([{ code: "(+49)15112345678" }, { code: "123456" }]);
    expect(r.err).not.toContain("15112345678");
  });

  it("a checking wait polls with no prompt and carries on to the next checkpoint", async () => {
    const poll = vi.fn().mockResolvedValueOnce({ status: "pending" }).mockResolvedValueOnce(cp("two_factor_app"));
    const solve = vi.fn().mockResolvedValue(ACTIVE);
    const r = await run(cp("checking"), { pollCheckpoint: poll, solveCheckpoint: solve }, ["654321"]);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(solve).toHaveBeenCalledWith("acc_p", { code: "654321" });
    expect(r.err).toContain("LinkedIn is checking this sign-in");
  });

  it("a poll answering 409 CHECKPOINT_EXPIRED ends the wait with exit 9 and a restart line", async () => {
    const { CurviateError } = await import("@curviate/sdk");
    const expired = new CurviateError({ code: "CHECKPOINT_EXPIRED", message: "expired", status: 409, userFixable: true, retryLikelyToSucceed: false } as never);
    const r = await run(cp("mobile_app_approval"), { pollCheckpoint: vi.fn().mockRejectedValue(expired) });
    expect(r.code).toBe(9);
    expect(r.err).toContain("timed out");
    // control: the same wait that answers active exits 0
    expect((await run(cp("mobile_app_approval"), { pollCheckpoint: vi.fn().mockResolvedValue(ACTIVE) })).code).toBeUndefined();
  });

  it("a connected answer with contract_selected:false says the contract was not selected", async () => {
    const r = await run({ ...ACTIVE, contract_selected: false }, {});
    expect(r.err).toBe(""); // an immediate 201 is rendered, not walked through the loop
    const r2 = await run(cp("otp", { channel: "email" }), { solveCheckpoint: vi.fn().mockResolvedValue({ ...ACTIVE, contract_selected: false }) }, ["123456"]);
    expect(r2.err).toContain("Recruiter contract you named was not selected");
  });
});

describe("warm-up and zone", () => {
  const UA = ["--user-agent", "UA/1", "--seat-id", "seat_1", "--country", "US", "--json"];
  it("link --no-warm-up sends warm_up:false; omitted sends no key; --timezone is accepted and sends no zone; refused with --account-id", async () => {
    const off = await sink.run(["account", "link", "--auth-method", "cookie", "--li-at", "AT", "--no-warm-up", "--timezone", "Europe/Berlin", ...UA]);
    const body = JSON.parse(off.requests[0]!.body) as Record<string, unknown>;
    expect(body["warm_up"]).toBe(false);
    expect(body).not.toHaveProperty("timezone");
    const dflt = await sink.run(["account", "link", "--auth-method", "cookie", "--li-at", "AT", ...UA]);
    expect(JSON.parse(dflt.requests[0]!.body)).not.toHaveProperty("warm_up");
    const re = await sink.run(["account", "link", "--auth-method", "cookie", "--li-at", "AT", "--no-warm-up", "--account-id", "acc_1", ...UA]);
    expect([re.status, re.requests.length]).toEqual([2, 0]);
  });

  it("connect-request create --no-warm-up sends warm_up:false; with --reconnect it exits 2", async () => {
    const r = await sink.run(["account", "connect-request", "create", "--no-warm-up", "--json"]);
    expect(JSON.parse(r.requests[0]!.body)).toEqual({ warm_up: false });
    const re = await sink.run(["account", "connect-request", "create", "--no-warm-up", "--reconnect", "acc_1"]);
    expect([re.status, re.requests.length]).toEqual([2, 0]);
  });

  it("account get shows the warm-up, the zone with its state and the location flags", async () => {
    const acc = { object: "account", account_id: "acc_1", status: "active", warm_up: { enabled: true, state: "ramping", factor: 0.15, week: 1 }, activity_window: { effective_timezone: "Europe/Berlin", source: "country", zone_state: "known", fallback_timezones: [] }, connection_location: { country: "DE", detected_country: "FR", checked_at: "2026-10-28T00:00:00Z", flags: ["country_mismatch"] }, quotas: [] };
    sink.reply = { body: acc };
    const r = await sink.run(["account", "get", "acc_1", "--json"]);
    expect(JSON.parse(r.stdout)).toMatchObject({ warm_up: acc.warm_up, activity_window: acc.activity_window, connection_location: acc.connection_location });
  });
});
