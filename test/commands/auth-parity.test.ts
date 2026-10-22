/**
 * Programmatic auth parity: tenant-wide account_status webhooks, account external_id, connect timezone/products,
 * challenge selection. Each absence assertion sits beside a positive control from the same call.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { Mock } from "vitest";
import { AUTH_NEEDED } from "../../src/lib/exit-codes.js";
import { runWebhookCreate } from "../../src/commands/webhook.js";
import { runAccountCheckpointRequest, runAccountLink, runAccountList } from "../../src/commands/account.js";
import { exitCode } from "../helpers/exit-code.js";

const makeOut = () => ({ stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });
const text = (m: Mock) => m.mock.calls.map((c) => c[0] as string).join("");
afterEach(() => vi.restoreAllMocks());

describe("webhook create, tenant-wide account_status", () => {
  const create = vi.fn();
  const args = { "request-url": "https://example.com/h" };
  const go = (flags: object, out = makeOut()) => runWebhookCreate({ webhooks: { create } } as never, { ...args, ...flags } as never, out);

  it("account_status without --account-ids sends no account_ids key (real and --preview); the source is sent", async () => {
    create.mockResolvedValue({ object: "webhook", id: "wh_1" });
    await go({ source: "account_status", json: true });
    expect(create.mock.calls[0]![0]).toMatchObject({ source: "account_status" });
    expect(create.mock.calls[0]![0]).not.toHaveProperty("account_ids");
    create.mockClear();
    const out = makeOut();
    await go({ source: "account_status", preview: true }, out);
    const body = (JSON.parse(text(out.stdout.write)) as { body: Record<string, unknown> }).body;
    expect(body["source"]).toBe("account_status");
    expect(body).not.toHaveProperty("account_ids");
    expect(create).not.toHaveBeenCalled();
  });

  it.each(["messaging", "user", "post", "motion"])("%s without --account-ids sends no account_ids key: every Account the creator can operate (ADR-072)", async (source) => {
    create.mockResolvedValue({ object: "webhook", id: "wh_1" });
    await go({ source, json: true });
    expect(create.mock.calls[0]![0]).toMatchObject({ source });
    expect(create.mock.calls[0]![0]).not.toHaveProperty("account_ids");
    create.mockClear();
  });

  it("--motion-ids is sent as motion_ids; an empty one is refused, never read as no filter", async () => {
    create.mockResolvedValue({ object: "webhook", id: "wh_1" });
    await go({ source: "motion", "motion-ids": "mot_1, mot_2", json: true });
    expect(create.mock.calls[0]![0]).toMatchObject({ source: "motion", motion_ids: ["mot_1", "mot_2"] });
    create.mockClear();
    const out = makeOut();
    expect(await exitCode(() => go({ source: "motion", "motion-ids": " , " }, out))).toBe(2);
    expect(text(out.stderr.write)).toContain("--motion-ids was given an empty value");
    expect(create).not.toHaveBeenCalled();
  });

  it.each(["", " , "])("an empty --account-ids %j is refused, never read as tenant-wide", async (value) => {
    const out = makeOut();
    expect(await exitCode(() => go({ source: "account_status", "account-ids": value }, out))).toBe(2);
    expect(text(out.stderr.write)).toContain("--account-ids was given an empty value");
    expect(create).not.toHaveBeenCalled();
  });
});

describe("account list --external-id", () => {
  it("forwards external_id as the filter, on every --all page, and the slim view shows it", async () => {
    const list = vi.fn().mockResolvedValueOnce({ object: "account_list", items: [{ account_id: "acc_1", external_id: "usr_42" }], cursor: "c2" }).mockResolvedValueOnce({ object: "account_list", items: [], cursor: null });
    const out = makeOut();
    await runAccountList({ accounts: { list } } as never, { "external-id": "usr_42", json: true } as never, out);
    expect(list).toHaveBeenLastCalledWith({ external_id: "usr_42" });
    expect(JSON.parse(text(out.stdout.write)).items[0]).toMatchObject({ account_id: "acc_1", external_id: "usr_42" });
    list.mockReset().mockResolvedValueOnce({ items: [{ account_id: "acc_1" }], cursor: "c2" }).mockResolvedValueOnce({ items: [], cursor: null });
    await runAccountList({ accounts: { list } } as never, { "external-id": "usr_42", all: true, json: true } as never, makeOut());
    expect(list).toHaveBeenCalledTimes(2);
    for (const call of list.mock.calls) expect(call[0]).toMatchObject({ external_id: "usr_42" });
  });
});

describe("account link intent options", () => {
  const linkArgs = (extra: object) => ({ "seat-id": "seat_1", "auth-method": "cookie", country: "US", "li-at": "AQEDaTest", "user-agent": "Mozilla/5.0", json: true, ...extra }) as never;
  const link = (extra: object, out = makeOut(), intent = vi.fn().mockResolvedValue({ object: "account" })) => ({ intent, run: () => runAccountLink({ auth: { intent } } as never, linkArgs(extra), out, { isTTY: false }) });

  it("forwards external_id, timezone and products (split, trimmed); omits all three when absent; --preview shows them", async () => {
    const a = link({ "external-id": "usr_42", timezone: "Europe/Berlin", products: "sales_navigator, recruiter" });
    await a.run();
    expect(a.intent.mock.calls[0]![0]).toMatchObject({ external_id: "usr_42", timezone: "Europe/Berlin", products: ["sales_navigator", "recruiter"] });
    const b = link({});
    await b.run();
    expect(b.intent.mock.calls[0]![0]).toMatchObject({ auth_method: "cookie" });
    for (const k of ["external_id", "timezone", "products"]) expect(b.intent.mock.calls[0]![0]).not.toHaveProperty(k);
    const out = makeOut();
    const c = link({ preview: true, "external-id": "usr_42", timezone: "Europe/Berlin", products: "recruiter" }, out);
    await c.run();
    expect((JSON.parse(text(out.stdout.write)) as { body: object }).body).toMatchObject({ external_id: "usr_42", timezone: "Europe/Berlin", products: ["recruiter"] });
    expect(c.intent).not.toHaveBeenCalled();
  });

  it.each(["", " , ", "classic", "sales-navigator", "recruiter,both"])("--products %j exits 2 and never calls the API", async (value) => {
    const out = makeOut();
    const l = link({ products: value }, out);
    expect(await exitCode(l.run)).toBe(2);
    expect(text(out.stderr.write)).toContain("--products takes a comma-separated list of: sales_navigator, recruiter");
    expect(l.intent).not.toHaveBeenCalled();
  });

  it("hitting challenge_selection on a TTY: no code prompt, renders the choices, names the next command, exits 12", async () => {
    const selection = { object: "checkpoint", status: "checkpoint_required", account_id: "acc_p", challenge_type: "challenge_selection", challenges: [{ id: "email", label: "Email", description: "j***@example.com" }, { id: "sms", label: "Text message", description: "+49 *** 12" }] };
    const solveCheckpoint = vi.fn();
    const readline = vi.fn();
    const out = makeOut();
    const intent = vi.fn().mockResolvedValue(selection);
    expect(await exitCode(() => runAccountLink({ auth: { intent, solveCheckpoint } } as never, linkArgs({}), out, { isTTY: true, isOutputTTY: true, readline }))).toBe(AUTH_NEEDED);
    expect([readline, solveCheckpoint].map((f) => f.mock.calls.length)).toEqual([0, 0]);
    expect(JSON.parse(text(out.stdout.write))).toMatchObject({ challenge_type: "challenge_selection" });
    expect(text(out.stderr.write)).toContain("curviate account checkpoint request acc_p --challenge <id>");
  });
});

describe("account checkpoint request --challenge", () => {
  const go = (requestCheckpoint: Mock, flags: object, out = makeOut()) => runAccountCheckpointRequest({ auth: { requestCheckpoint } } as never, { "account-id": "acc_p", ...flags } as never, out);

  it("sends the challenge, renders the next checkpoint and exits 12; without it the plain re-send exits 0; --preview renders the body with no call", async () => {
    const out = makeOut();
    const req = vi.fn().mockResolvedValue({ object: "checkpoint", status: "checkpoint_required", account_id: "acc_p", challenge_type: "two_factor_sms" });
    expect(await exitCode(() => go(req, { challenge: "sms", json: true }, out))).toBe(AUTH_NEEDED);
    expect(req).toHaveBeenCalledWith("acc_p", { challenge: "sms" });
    expect(JSON.parse(text(out.stdout.write))).toMatchObject({ challenge_type: "two_factor_sms" });
    const plain = vi.fn().mockResolvedValue({ object: "checkpoint", account_id: "acc_p", resent: true });
    expect(await exitCode(() => go(plain, { json: true }))).toBeUndefined();
    expect(plain).toHaveBeenCalledWith("acc_p");
    const none = vi.fn();
    const pv = makeOut();
    await go(none, { challenge: "email", preview: true }, pv);
    expect(JSON.parse(text(pv.stdout.write))).toMatchObject({ body: { challenge: "email" } });
    expect(none).not.toHaveBeenCalled();
  });
});
