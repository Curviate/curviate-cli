/**
 * Programmatic auth parity: tenant-wide account-status webhooks, account
 * external_id, connect timezone/products, and challenge selection.
 *
 * Every absence assertion sits beside a positive control from the same
 * captured call, so "no key" means absent, not "nothing captured".
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { Mock } from "vitest";
import { AUTH_NEEDED } from "../../src/lib/exit-codes.js";

function makeOut() {
  return { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
}
const text = (m: Mock) => m.mock.calls.map((c) => c[0] as string).join("");

function exitSpy() {
  return vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new Error(`process.exit(${code})`);
  });
}

async function expectExit(code: number, fn: () => Promise<unknown>) {
  const spy = exitSpy();
  try {
    await fn();
    expect.fail("should have exited");
  } catch (e) {
    expect((e as Error).message).toBe(`process.exit(${code})`);
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// webhook create: --account-ids optional for account_status
// ---------------------------------------------------------------------------

describe("webhook create, tenant-wide account_status", () => {
  const client = () => ({ webhooks: { create: vi.fn().mockResolvedValue({ object: "webhook", id: "wh_1" }) } });

  it("account_status without --account-ids sends no account_ids key", async () => {
    const { runWebhookCreate } = await import("../../src/commands/webhook.js");
    const c = client();
    await runWebhookCreate(c as never, { source: "account_status", "request-url": "https://example.com/h", json: true } as never, makeOut());
    const body = (c.webhooks.create as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body["source"]).toBe("account_status");
    expect(body).not.toHaveProperty("account_ids");
  });

  it.each(["messaging", "user"])("%s without --account-ids exits 2 naming the rule", async (source) => {
    const { runWebhookCreate } = await import("../../src/commands/webhook.js");
    const c = client();
    const out = makeOut();
    await expectExit(2, () => runWebhookCreate(c as never, { source, "request-url": "https://example.com/h" } as never, out));
    expect(text(out.stderr.write)).toContain("--account-ids is required for --source messaging and user");
    expect(c.webhooks.create).not.toHaveBeenCalled();
  });

  it.each(["", " , "])("an empty --account-ids %o is refused, never read as tenant-wide", async (value) => {
    const { runWebhookCreate } = await import("../../src/commands/webhook.js");
    const c = client();
    const out = makeOut();
    await expectExit(2, () =>
      runWebhookCreate(c as never, { source: "account_status", "request-url": "https://example.com/h", "account-ids": value } as never, out),
    );
    expect(text(out.stderr.write)).toContain("--account-ids was given an empty value");
    expect(c.webhooks.create).not.toHaveBeenCalled();
  });

  it("--preview renders the tenant-wide body", async () => {
    const { runWebhookCreate } = await import("../../src/commands/webhook.js");
    const c = client();
    const out = makeOut();
    await runWebhookCreate(c as never, { source: "account_status", "request-url": "https://example.com/h", preview: true } as never, out);
    const preview = JSON.parse(text(out.stdout.write)) as { body: Record<string, unknown> };
    expect(preview.body["source"]).toBe("account_status");
    expect(preview.body).not.toHaveProperty("account_ids");
    expect(c.webhooks.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// account list --external-id
// ---------------------------------------------------------------------------

describe("account list --external-id", () => {
  it("forwards external_id as the list filter", async () => {
    const { runAccountList } = await import("../../src/commands/account.js");
    const list = vi.fn().mockResolvedValue({ object: "account_list", items: [], cursor: null });
    await runAccountList({ accounts: { list } } as never, { "external-id": "usr_42", json: true } as never, makeOut());
    expect(list).toHaveBeenCalledWith({ external_id: "usr_42" });
  });

  it("the default (slim) view shows the external_id it filtered on", async () => {
    const { runAccountList } = await import("../../src/commands/account.js");
    const list = vi.fn().mockResolvedValue({ object: "account_list", items: [{ account_id: "acc_1", external_id: "usr_42" }], cursor: null });
    const out = makeOut();
    await runAccountList({ accounts: { list } } as never, { "external-id": "usr_42", json: true } as never, out);
    expect(JSON.parse(text(out.stdout.write)).items[0]).toMatchObject({ account_id: "acc_1", external_id: "usr_42" });
  });

  it("carries the filter through every --all page", async () => {
    const { runAccountList } = await import("../../src/commands/account.js");
    const list = vi
      .fn()
      .mockResolvedValueOnce({ object: "account_list", items: [{ account_id: "acc_1" }], cursor: "c2" })
      .mockResolvedValueOnce({ object: "account_list", items: [], cursor: null });
    await runAccountList({ accounts: { list } } as never, { "external-id": "usr_42", all: true, json: true } as never, makeOut());
    expect(list).toHaveBeenCalledTimes(2);
    for (const call of list.mock.calls) expect(call[0]).toMatchObject({ external_id: "usr_42" });
  });
});

// ---------------------------------------------------------------------------
// account link --external-id --timezone --products
// ---------------------------------------------------------------------------

function linkArgs(extra: Record<string, unknown>) {
  return { "seat-id": "seat_1", "auth-method": "cookie", "li-at": "AQEDaTest", "user-agent": "Mozilla/5.0", json: true, ...extra } as never;
}

describe("account link intent options", () => {
  it("forwards external_id, timezone and products", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const intent = vi.fn().mockResolvedValue({ object: "account" });
    await runAccountLink(
      { auth: { intent } } as never,
      linkArgs({ "external-id": "usr_42", timezone: "Europe/Berlin", products: "sales_navigator, recruiter" }),
      makeOut(),
      { isTTY: false },
    );
    expect(intent.mock.calls[0]![0]).toMatchObject({
      external_id: "usr_42",
      timezone: "Europe/Berlin",
      products: ["sales_navigator", "recruiter"],
    });
  });

  it("omits all three when the flags are absent", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const intent = vi.fn().mockResolvedValue({ object: "account" });
    await runAccountLink({ auth: { intent } } as never, linkArgs({}), makeOut(), { isTTY: false });
    const body = intent.mock.calls[0]![0] as Record<string, unknown>;
    expect(body["auth_method"]).toBe("cookie");
    for (const k of ["external_id", "timezone", "products"]) expect(body).not.toHaveProperty(k);
  });

  it.each(["", " , ", "classic", "sales-navigator", "recruiter,both"])("--products %o exits 2 and never calls the API", async (value) => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const intent = vi.fn();
    const out = makeOut();
    await expectExit(2, () => runAccountLink({ auth: { intent } } as never, linkArgs({ products: value }), out, { isTTY: false }));
    expect(text(out.stderr.write)).toContain("--products takes a comma-separated list of: sales_navigator, recruiter");
    expect(intent).not.toHaveBeenCalled();
  });

  it("--preview shows the new fields in the rendered body", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const intent = vi.fn();
    const out = makeOut();
    await runAccountLink(
      { auth: { intent } } as never,
      linkArgs({ preview: true, "external-id": "usr_42", timezone: "Europe/Berlin", products: "recruiter" }),
      out,
      { isTTY: false },
    );
    const preview = JSON.parse(text(out.stdout.write)) as { body: Record<string, unknown> };
    expect(preview.body).toMatchObject({ external_id: "usr_42", timezone: "Europe/Berlin", products: ["recruiter"] });
    expect(intent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// challenge selection
// ---------------------------------------------------------------------------

const SELECTION = {
  object: "checkpoint",
  status: "checkpoint_required",
  account_id: "acc_p",
  challenge_type: "challenge_selection",
  challenges: [
    { id: "email", label: "Email", description: "j***@example.com" },
    { id: "sms", label: "Text message", description: "+49 *** 12" },
  ],
};

describe("account checkpoint request --challenge", () => {
  it("sends the challenge, renders the next checkpoint and exits 12", async () => {
    const { runAccountCheckpointRequest } = await import("../../src/commands/account.js");
    const next = { object: "checkpoint", status: "checkpoint_required", account_id: "acc_p", challenge_type: "two_factor_sms" };
    const requestCheckpoint = vi.fn().mockResolvedValue(next);
    const out = makeOut();
    await expectExit(AUTH_NEEDED, () =>
      runAccountCheckpointRequest({ auth: { requestCheckpoint } } as never, { "account-id": "acc_p", challenge: "sms", json: true } as never, out),
    );
    expect(requestCheckpoint).toHaveBeenCalledWith("acc_p", { challenge: "sms" });
    expect(JSON.parse(text(out.stdout.write))).toMatchObject({ challenge_type: "two_factor_sms" });
  });

  it("without --challenge keeps the plain re-send call and exits 0", async () => {
    const { runAccountCheckpointRequest } = await import("../../src/commands/account.js");
    const requestCheckpoint = vi.fn().mockResolvedValue({ object: "checkpoint", account_id: "acc_p", resent: true });
    const spy = exitSpy();
    await runAccountCheckpointRequest({ auth: { requestCheckpoint } } as never, { "account-id": "acc_p", json: true } as never, makeOut());
    expect(requestCheckpoint).toHaveBeenCalledWith("acc_p");
    expect(spy).not.toHaveBeenCalled();
  });

  it("--preview renders the challenge in the body without a call", async () => {
    const { runAccountCheckpointRequest } = await import("../../src/commands/account.js");
    const requestCheckpoint = vi.fn();
    const out = makeOut();
    await runAccountCheckpointRequest({ auth: { requestCheckpoint } } as never, { "account-id": "acc_p", challenge: "email", preview: true } as never, out);
    expect(JSON.parse(text(out.stdout.write))).toMatchObject({ body: { challenge: "email" } });
    expect(requestCheckpoint).not.toHaveBeenCalled();
  });
});

describe("account link hitting challenge_selection on a TTY", () => {
  it("does not prompt for a code; renders the choices, names the next command, exits 12", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const intent = vi.fn().mockResolvedValue(SELECTION);
    const solveCheckpoint = vi.fn();
    const readline = vi.fn();
    const out = makeOut();
    await expectExit(AUTH_NEEDED, () =>
      runAccountLink({ auth: { intent, solveCheckpoint } } as never, linkArgs({}), out, { isTTY: true, isOutputTTY: true, readline }),
    );
    expect(readline).not.toHaveBeenCalled();
    expect(solveCheckpoint).not.toHaveBeenCalled();
    expect(JSON.parse(text(out.stdout.write))).toMatchObject({ challenge_type: "challenge_selection" });
    expect(text(out.stderr.write)).toContain("curviate account checkpoint request acc_p --challenge <id>");
  });
});
