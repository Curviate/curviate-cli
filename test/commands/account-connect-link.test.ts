/**
 * `account connect-session poll` (`auth.getSession`): one-shot and --wait (adaptive cadence 1000 ms, then 1500 ms for
 * 30 s, then 3000 ms), every terminal exit, flag set and registration. Mock client, injected sleep/now/TTY: no real timer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { AUTH_NEEDED } from "../../src/lib/exit-codes.js";
import { accountCommand, runAccountConnectSessionPoll } from "../../src/commands/account.js";
import { exitCode } from "../helpers/exit-code.js";

const client = { auth: { getSession: vi.fn() } };
const getSession = client.auth.getSession as Mock;
let out: { stdout: { write: Mock }; stderr: { write: Mock } };
beforeEach(() => {
  vi.resetAllMocks();
  out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
});
const text = (w: { write: Mock }) => w.write.mock.calls.map((c) => c[0] as string).join("");
const PENDING = { object: "connect_session", session_id: "cs_1", status: "pending", account_id: null, expires_at: "2099-01-01T00:00:00.000Z" };
const RESOLVED = { ...PENDING, status: "resolved", account_id: "acc_final" };
const poll = (flags: object, io?: object) => runAccountConnectSessionPoll(client as never, { session: "cs_1", json: true, ...flags } as never, out, io as never);
function waitIo() {
  let t = 0;
  return { isOutputTTY: false, now: () => t, sleep: vi.fn((ms: number) => ((t += ms), Promise.resolve())) };
}
const MALFORMED = [["null", null], ["a scalar", "not an object"], ["a bare array", [{ status: "resolved" }]]] as const;

describe("one-shot (no --wait)", () => {
  it("calls getSession once with the session_id as a bare string, prints the body, exits 0 whatever the status", async () => {
    getSession.mockResolvedValue(PENDING);
    await poll({});
    expect(getSession).toHaveBeenCalledExactlyOnceWith("cs_1"); // an object arg would interpolate to [object Object] in the path
    expect(JSON.parse(text(out.stdout))).toMatchObject({ status: "pending" });
  });

  it("a missing --session exits 2 before any call and names `account link`; --preview renders the request without a call", async () => {
    expect(await exitCode(() => runAccountConnectSessionPoll(client as never, { json: true } as never, out))).toBe(2);
    expect(text(out.stderr)).toContain("account link");
    expect(text(out.stderr)).not.toContain("connect-link");
    await poll({ preview: true });
    expect(getSession).not.toHaveBeenCalled();
    expect(JSON.parse(text(out.stdout))).toMatchObject({ method: "auth.getSession", args: { session_id: "cs_1" } });
  });

  it.each(MALFORMED)("a malformed body (%s) is a platform fault, exit 7, never a silent 0", async (_l, body) => {
    getSession.mockResolvedValue(body);
    expect(await exitCode(() => poll({}))).toBe(7);
  });
});

describe("--wait", () => {
  it("resolves on the first poll after the initial 1000 ms delay and prints 'Account connected'", async () => {
    getSession.mockResolvedValue(RESOLVED);
    const io = waitIo();
    await poll({ wait: true }, io);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(io.sleep).toHaveBeenNthCalledWith(1, 1000);
    expect(text(out.stderr)).toContain("Account connected: acc_final");
    expect(JSON.parse(text(out.stdout))).toMatchObject({ status: "resolved" });
  });

  it.each(["expired", "failed"])("exits 9 on status %s and points at the live `account link`, not the removed connect-link", async (status) => {
    getSession.mockResolvedValue({ ...PENDING, status });
    expect(await exitCode(() => poll({ wait: true }, waitIo()))).toBe(9);
    expect(text(out.stderr)).toContain("curviate account link --auth-method <m> --country <CC>");
    expect(text(out.stderr)).not.toContain("account connect-link");
  });

  it("--timeout elapsing while pending exits 12; a non-numeric --timeout exits 2 before any call", async () => {
    getSession.mockResolvedValue(PENDING);
    expect(await exitCode(() => poll({ wait: true, timeout: "500" }, waitIo()))).toBe(AUTH_NEEDED);
    expect(getSession).toHaveBeenCalledTimes(1);
    getSession.mockClear();
    expect(await exitCode(() => poll({ wait: true, timeout: "not-a-number" }))).toBe(2);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("a malformed body inside the loop is exit 7, not a crash on `.status`", async () => {
    getSession.mockResolvedValue(null);
    expect(await exitCode(() => poll({ wait: true }, waitIo()))).toBe(7);
  });
});

describe("registration and flag set", () => {
  type Cmd = { subCommands: Record<string, any>; args?: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const account = accountCommand as unknown as Cmd;

  it("connect-session registers only `poll`; the removed hosted-link commands stay gone", () => {
    expect(Object.keys(account.subCommands["connect-session"].subCommands)).toEqual(["poll"]);
    for (const gone of ["connect-link", "reconnect-link", "reconnect"]) expect(account.subCommands).not.toHaveProperty(gone);
  });

  it("poll has --session (required), --wait, --timeout and --fields, no pagination flags, no idempotency-key or dry-run", () => {
    const args = account.subCommands["connect-session"].subCommands["poll"].args;
    for (const f of ["limit", "cursor", "all", "max-pages", "idempotency-key", "dry-run"]) expect(args).not.toHaveProperty(f);
    for (const f of ["fields", "session", "wait", "timeout"]) expect(args).toHaveProperty(f);
    expect(args.session.required).toBe(true);
  });
});
