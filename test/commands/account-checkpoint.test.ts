/**
 * Guided checkpoint follow-through on `account link` and the one-shot
 * `account checkpoint solve|poll|request`, hermetic: a mock client plus injected readline/sleep/clock.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { CurviateError } from "@curviate/sdk";
import { AUTH_NEEDED, EXIT_CODE_MAP } from "../../src/lib/exit-codes.js";
import { CHECKPOINT_POLL_FAST_WINDOW_MS } from "../../src/lib/checkpoint-cadence.js";
import { accountCommand, runAccountCheckpointPoll, runAccountCheckpointRequest, runAccountCheckpointSolve, runAccountLink } from "../../src/commands/account.js";
import { renderSuccess } from "../../src/lib/output.js";
import { exitCode } from "../helpers/exit-code.js";

const client = { auth: { intent: vi.fn(), solveCheckpoint: vi.fn(), pollCheckpoint: vi.fn(), requestCheckpoint: vi.fn() } };
const auth = client.auth as Record<string, Mock>;
let out: { stdout: { write: Mock }; stderr: { write: Mock } };
beforeEach(() => {
  vi.resetAllMocks();
  out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
});
const text = (w: { write: Mock }) => w.write.mock.calls.map((c) => c[0] as string).join("");
const json = () => JSON.parse(text(out.stdout)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const apiErr = (code: string, httpStatus: number, extra: object = {}) =>
  Object.assign(new CurviateError({ code, message: code, httpStatus, userFixable: true, retryLikelyToSucceed: false } as never), extra);
const invalidCode = (n: number) => apiErr("CHECKPOINT_INVALID_CODE", 422, { attempts_remaining: n });
const EXPIRES = "2099-01-01T00:00:00.000Z";
const checkpoint = (account_id: string, challenge_type: string) => ({ object: "checkpoint", status: "checkpoint_required", account_id, challenge_type, expires_at: EXPIRES });
const OTP = checkpoint("acc_pending_1", "otp");
const MOBILE = checkpoint("acc_pending_mobile", "mobile_app_approval");
const ACTIVE = { object: "account", account_id: "acc_final", status: "active" };
const noopSleep = () => Promise.resolve();
const link = { "seat-id": "seat_1", "auth-method": "credentials", country: "US", email: "otp@example.com", password: "test-password", json: true } as never;
const TTY = (readline: Mock, now: () => number = () => 0) => ({ isTTY: true, isOutputTTY: true, readline, sleep: noopSleep, now });
const doLink = (io: object, args: object = link) => runAccountLink(client as never, args as never, out, io as never);

/** sleep advances now() by the requested delay: cadence is driven by the loop's own arithmetic, no real waiting. */
function advancingClock() {
  let t = 0;
  return { now: () => t, sleep: vi.fn((ms: number) => ((t += ms), Promise.resolve())) };
}
const poll = (flags: object, io?: object) => runAccountCheckpointPoll(client as never, { "account-id": "acc_pending_1", json: true, ...flags } as never, out, io as never);
const WAIT_IO = () => ({ isOutputTTY: false, ...advancingClock() });

describe("account link: checkpoint_required, non-interactive", () => {
  it.each([
    ["stdin not a TTY", { isTTY: false, isOutputTTY: true }, {}],
    ["stdout not a TTY (stdin is)", { isTTY: true, isOutputTTY: false }, {}],
    ["--no-interactive under a real TTY", { isTTY: true, isOutputTTY: true }, { "no-interactive": true }],
  ])("%s: prints the 202 envelope and exits 12, never prompts", async (_l, io, extra) => {
    auth["intent"]!.mockResolvedValue(OTP);
    const readline = vi.fn();
    expect(await exitCode(() => doLink({ ...io, readline }, { ...(link as object), ...extra }))).toBe(AUTH_NEEDED);
    expect(readline).not.toHaveBeenCalled();
    expect(auth["solveCheckpoint"]).not.toHaveBeenCalled();
    expect(json()).toMatchObject({ status: "checkpoint_required", challenge_type: "otp" });
  });

  it("a completed link response is unaffected: no exit, rendered", async () => {
    auth["intent"]!.mockResolvedValue({ object: "account", account_id: "acc_new", status: "active" });
    await doLink({ isTTY: false, isOutputTTY: false });
    expect(json()).toMatchObject({ account_id: "acc_new" });
  });

  it("AUTH_NEEDED is 12 and no error code maps to it", () => {
    expect(AUTH_NEEDED).toBe(12);
    expect(Object.values(EXIT_CODE_MAP)).not.toContain(12);
  });
});

describe("account link: interactive code challenge", () => {
  beforeEach(() => auth["intent"]!.mockResolvedValue(OTP));

  it("prints the challenge copy once, submits the code, prints success and the resend hint", async () => {
    auth["solveCheckpoint"]!.mockResolvedValue(ACTIVE);
    await doLink(TTY(vi.fn().mockResolvedValue("999999")));
    const err = text(out.stderr);
    expect(err).toContain("Check your email");
    expect(err).toContain("Account linked: acc_final");
    expect(err).toContain("checkpoint request acc_pending_1");
    expect(auth["solveCheckpoint"]).toHaveBeenCalledExactlyOnceWith("acc_pending_1", { code: "999999" });
  });

  it("a 422 re-prompts the same checkpoint with retry copy (challenge copy not re-printed)", async () => {
    auth["solveCheckpoint"]!.mockRejectedValueOnce(invalidCode(4)).mockResolvedValueOnce(ACTIVE);
    await doLink(TTY(vi.fn().mockResolvedValueOnce("000000").mockResolvedValueOnce("999999")));
    expect(auth["solveCheckpoint"]).toHaveBeenNthCalledWith(1, "acc_pending_1", { code: "000000" });
    expect(auth["solveCheckpoint"]).toHaveBeenNthCalledWith(2, "acc_pending_1", { code: "999999" });
    expect(text(out.stderr)).toContain("4 attempt(s) remaining");
    expect(text(out.stderr).split("Check your email")).toHaveLength(2);
  });

  it("CHECKPOINT_MAX_ATTEMPTS after five 422s, and CHECKPOINT_EXPIRED, exit 9", async () => {
    auth["solveCheckpoint"]!.mockRejectedValueOnce(invalidCode(4)).mockRejectedValueOnce(invalidCode(3)).mockRejectedValueOnce(invalidCode(2))
      .mockRejectedValueOnce(invalidCode(1)).mockRejectedValueOnce(invalidCode(0)).mockRejectedValueOnce(apiErr("CHECKPOINT_MAX_ATTEMPTS", 429));
    expect(await exitCode(() => doLink(TTY(vi.fn().mockResolvedValue("000000"))))).toBe(9);
    expect(auth["solveCheckpoint"]).toHaveBeenCalledTimes(6);
    auth["solveCheckpoint"]!.mockReset().mockRejectedValue(apiErr("CHECKPOINT_EXPIRED", 409));
    expect(await exitCode(() => doLink(TTY(vi.fn().mockResolvedValue("999999"))))).toBe(9);
  });

  it("a chained challenge (otp then two_factor_app) is followed; the second has no resend hint", async () => {
    auth["solveCheckpoint"]!.mockResolvedValueOnce(checkpoint("acc_pending_2", "two_factor_app")).mockResolvedValueOnce(ACTIVE);
    await doLink(TTY(vi.fn().mockResolvedValue("999999")));
    expect(auth["solveCheckpoint"]).toHaveBeenNthCalledWith(1, "acc_pending_1", { code: "999999" });
    expect(auth["solveCheckpoint"]).toHaveBeenNthCalledWith(2, "acc_pending_2", { code: "999999" });
    const err = text(out.stderr);
    expect(err).toContain("Enter authenticator code");
    expect(err.slice(err.indexOf("Enter authenticator code"))).not.toContain("checkpoint request");
  });
});

describe("account link: interactive mobile_app_approval (poll sub-loop)", () => {
  beforeEach(() => auth["intent"]!.mockResolvedValue(MOBILE));

  it("polls until active, prints approve copy and the resend hint, never prompts for a code", async () => {
    auth["pollCheckpoint"]!.mockResolvedValueOnce({ object: "checkpoint", status: "pending" }).mockResolvedValueOnce({ ...ACTIVE });
    const readline = vi.fn();
    await doLink(TTY(readline));
    expect(readline).not.toHaveBeenCalled();
    expect(auth["pollCheckpoint"]).toHaveBeenCalledTimes(2);
    expect(auth["pollCheckpoint"]).toHaveBeenCalledWith("acc_pending_mobile");
    const err = text(out.stderr);
    for (const s of ["Approve in LinkedIn app", "checkpoint request acc_pending_mobile", "Account linked: acc_final"]) expect(err).toContain(s);
  });

  it.each([
    ["expired status exits 9", { object: "checkpoint", status: "expired" }, 9],
    ["failed status exits 9", { object: "checkpoint", status: "failed" }, 9],
    ["malformed null body exits 7", null, 7],
  ])("%s", async (_l, body, code) => {
    auth["pollCheckpoint"]!.mockResolvedValue(body);
    expect(await exitCode(() => doLink(TTY(vi.fn())))).toBe(code);
  });

  it("wall-clock timeout while pending exits 12 (not 9) and names `checkpoint poll`", async () => {
    auth["pollCheckpoint"]!.mockResolvedValue({ object: "checkpoint", status: "pending" });
    expect(await exitCode(() => doLink(TTY(vi.fn(), () => new Date("2100-01-01").getTime())))).toBe(AUTH_NEEDED);
    expect(auth["pollCheckpoint"]).toHaveBeenCalledTimes(1);
    expect(text(out.stderr)).toContain("checkpoint poll acc_pending_mobile");
  });
});

const MALFORMED = [["null", null], ["a scalar", "not an object"], ["a bare array", [{ status: "active" }]]] as const;

describe("account checkpoint solve", () => {
  const solve = () => runAccountCheckpointSolve(client as never, { "account-id": "acc_pending_1", code: "999999", json: true } as never, out);

  it("a completed result renders; a chained checkpoint_required prints the new envelope and exits 12", async () => {
    auth["solveCheckpoint"]!.mockResolvedValue(ACTIVE);
    await solve();
    expect(json()).toMatchObject({ status: "active" });
    out.stdout.write.mockClear();
    auth["solveCheckpoint"]!.mockResolvedValue(checkpoint("acc_pending_2", "two_factor_sms"));
    expect(await exitCode(solve)).toBe(AUTH_NEEDED);
    expect(json()).toMatchObject({ status: "checkpoint_required", account_id: "acc_pending_2" });
  });

  it.each(MALFORMED)("a malformed body (%s) is exit 7 with a PLATFORM_ERROR envelope, never render-then-crash", async (_l, body) => {
    auth["solveCheckpoint"]!.mockResolvedValue(body);
    expect(await exitCode(solve)).toBe(7);
    expect(json()).toMatchObject({ error: { code: "PLATFORM_ERROR" } });
  });
});

describe("account checkpoint poll", () => {
  const pending = { object: "checkpoint", status: "pending", expires_at: EXPIRES };

  it("without --wait it polls once", async () => {
    auth["pollCheckpoint"]!.mockResolvedValue(pending);
    await poll({});
    expect(auth["pollCheckpoint"]).toHaveBeenCalledTimes(1);
  });

  it.each(MALFORMED)("without --wait a malformed body (%s) is exit 7", async (_l, body) => {
    auth["pollCheckpoint"]!.mockResolvedValue(body);
    expect(await exitCode(() => poll({}))).toBe(7);
  });

  it("--wait resolves active after the initial 1000 ms delay, prints 'Account linked' and the resend hint once", async () => {
    auth["pollCheckpoint"]!.mockResolvedValue({ ...ACTIVE });
    const io = WAIT_IO();
    await poll({ wait: true }, io);
    expect(auth["pollCheckpoint"]).toHaveBeenCalledExactlyOnceWith("acc_pending_1");
    expect(io.sleep).toHaveBeenNthCalledWith(1, 1000);
    expect(text(out.stderr)).toContain("Account linked: acc_final");
    expect(text(out.stderr).match(/checkpoint request acc_pending_1/g)).toHaveLength(1);
    expect(json()).toMatchObject({ status: "active" });
  });

  it.each(["expired", "failed"])("--wait exits 9 on status %s and offers a new connect, not `account reconnect`", async (status) => {
    auth["pollCheckpoint"]!.mockResolvedValue({ object: "checkpoint", status });
    expect(await exitCode(() => poll({ wait: true }, WAIT_IO()))).toBe(9);
    expect(text(out.stderr)).toContain("curviate account link --auth-method <m> --country <CC>");
    expect(text(out.stderr)).not.toContain("account reconnect");
    expect(json()).toMatchObject({ status });
  });

  it("--timeout elapsing while pending, or the checkpoint's own expires_at by default, exits 12", async () => {
    auth["pollCheckpoint"]!.mockResolvedValue(pending);
    expect(await exitCode(() => poll({ wait: true, timeout: "500" }, WAIT_IO()))).toBe(AUTH_NEEDED);
    expect(auth["pollCheckpoint"]).toHaveBeenCalledTimes(1);
    auth["pollCheckpoint"]!.mockReset().mockResolvedValue({ ...pending, expires_at: new Date(1500).toISOString() });
    expect(await exitCode(() => poll({ wait: true }, WAIT_IO()))).toBe(AUTH_NEEDED);
    expect(auth["pollCheckpoint"]).toHaveBeenCalledTimes(2);
  });

  it("a non-numeric --timeout exits 2 before any poll", async () => {
    expect(await exitCode(() => poll({ wait: true, timeout: "not-a-number" }))).toBe(2);
    expect(auth["pollCheckpoint"]).not.toHaveBeenCalled();
  });

  it("the cadence switches from 1500 ms to 3000 ms at the 30 s fast window", async () => {
    const io = WAIT_IO();
    auth["pollCheckpoint"]!.mockImplementation(async () => (io.now() >= CHECKPOINT_POLL_FAST_WINDOW_MS + 5000 ? { ...ACTIVE } : pending));
    await poll({ wait: true }, io);
    const delays = io.sleep.mock.calls.map((c) => c[0] as number);
    expect(delays[0]).toBe(1000);
    let elapsed = 0;
    for (const d of delays) {
      if (d === 3000) {
        expect(elapsed).toBeGreaterThanOrEqual(CHECKPOINT_POLL_FAST_WINDOW_MS);
        break;
      }
      expect(d).toBe(elapsed === 0 ? 1000 : 1500);
      elapsed += d;
    }
    expect(delays).toContain(3000);
  });

  it("the 'Waiting for approval' ticker prints on a TTY, and stays silent under --json", async () => {
    auth["pollCheckpoint"]!.mockResolvedValueOnce(pending).mockResolvedValueOnce({ ...ACTIVE });
    await poll({ wait: true, json: false }, { ...advancingClock(), isOutputTTY: true });
    expect(text(out.stderr)).toMatch(/Waiting for approval[\s\S]*remaining|remaining[\s\S]*Waiting for approval/);
    out.stderr.write.mockClear();
    auth["pollCheckpoint"]!.mockResolvedValueOnce(pending).mockResolvedValueOnce({ ...ACTIVE });
    await poll({ wait: true }, { ...advancingClock(), isOutputTTY: true });
    expect(text(out.stderr)).not.toContain("Waiting for approval");
  });

  it("--wait routes a thrown error through the exit table (expired -> 9) and a malformed body to 7", async () => {
    auth["pollCheckpoint"]!.mockResolvedValueOnce(pending).mockRejectedValueOnce(apiErr("CHECKPOINT_EXPIRED", 409));
    expect(await exitCode(() => poll({ wait: true }, WAIT_IO()))).toBe(9);
    auth["pollCheckpoint"]!.mockReset().mockResolvedValue(null);
    expect(await exitCode(() => poll({ wait: true }, WAIT_IO()))).toBe(7);
  });
});

describe("account checkpoint request", () => {
  const request = (flags: object = {}) => runAccountCheckpointRequest(client as never, { "account-id": "acc_pending_1", json: true, ...flags } as never, out);

  it.each([true, false])("resent:%s is a plain 200 (never an error), calling requestCheckpoint with the path id", async (resent) => {
    auth["requestCheckpoint"]!.mockResolvedValue({ object: "checkpoint", account_id: "acc_pending_1", resent });
    await request();
    expect(auth["requestCheckpoint"]).toHaveBeenCalledExactlyOnceWith("acc_pending_1");
    expect(json()).toMatchObject({ resent });
    expect(json()["error"]).toBeUndefined();
    expect(text(out.stderr)).not.toMatch(/error/i);
  });

  it("the human render shows `resent: false` as an honest key line", () => {
    renderSuccess({ object: "checkpoint", account_id: "acc_pending_1", resent: false }, { json: false, isTTY: true }, out);
    expect(text(out.stdout)).toContain("resent: false");
  });

  it("a missing account_id exits 2 with no call; --preview renders the request with no call", async () => {
    expect(await exitCode(() => runAccountCheckpointRequest(client as never, { json: true } as never, out))).toBe(2);
    await request({ preview: true });
    expect(auth["requestCheckpoint"]).not.toHaveBeenCalled();
    expect(json()).toMatchObject({ method: "auth.requestCheckpoint", args: { accountId: "acc_pending_1" } });
  });

  it.each([
    ["CHECKPOINT_NOT_FOUND", 404, 9],
    ["CHECKPOINT_EXPIRED", 409, 9],
    ["PLATFORM_NOT_IMPLEMENTED", 501, 1],
  ])("%s exits %i->%i", async (code, status, exit) => {
    auth["requestCheckpoint"]!.mockRejectedValue(apiErr(code, status));
    expect(await exitCode(() => request())).toBe(exit);
  });
});

it("account checkpoint registers solve, poll and request", () => {
  const sub = (accountCommand as unknown as { subCommands: { checkpoint: { subCommands: object } } }).subCommands.checkpoint.subCommands;
  expect(Object.keys(sub).sort()).toEqual(["poll", "request", "solve"]);
});
