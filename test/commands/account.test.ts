/**
 * `account` command group (root-scoped): list / get / seats / link / update /
 * disconnect / checkpoint solve|poll. Mock client; account_id positionals pass through verbatim.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import type { paths } from "@curviate/sdk";
import { CurviateError } from "@curviate/sdk";
import { accountCommand, runAccountCheckpointPoll, runAccountCheckpointSolve, runAccountDisconnect, runAccountGet, runAccountLink, runAccountList, runAccountSeats, runAccountUpdate } from "../../src/commands/account.js";
import { exitCode } from "../helpers/exit-code.js";

// The generated OpenAPI type is the contract: `satisfies` makes a fixture field the server never emits a compile error.
type AccountListItem = NonNullable<paths["/v1/accounts"]["get"]["responses"][200]["content"]["application/json"]["items"]>[number];

const client = {
  accounts: { list: vi.fn(), get: vi.fn(), listSeats: vi.fn(), update: vi.fn(), disconnect: vi.fn() },
  auth: { intent: vi.fn(), solveCheckpoint: vi.fn(), pollCheckpoint: vi.fn() },
};
let out: { stdout: { write: Mock }; stderr: { write: Mock } };
beforeEach(() => {
  vi.resetAllMocks();
  out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
});
afterEach(() => vi.restoreAllMocks());
const text = (w: { write: Mock }) => w.write.mock.calls.map((c) => c[0] as string).join("");
const json = () => JSON.parse(text(out.stdout)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
const ndjson = () => text(out.stdout).split("\n").filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l) as any); // eslint-disable-line @typescript-eslint/no-explicit-any
const c = client as never;
const run = (fn: (...a: never[]) => Promise<unknown>, flags: object) => fn(c, flags as never, out as never);

const ENRICHED = {
  account_id: "acc_1", status: "active", auth_method: "credentials", full_name: "Ada Lovelace", headline: "Engineer",
  seat_id: "seat_1", connected_at: "2026-06-01T09:00:00Z", external_id: null, substrate_created_at: "2020-01-01T00:00:00Z",
} satisfies AccountListItem;
const LOCATION = { country: "NL", current_country: "FR", mode: "auto", strict: false };
const SLIM_LIST_KEYS = ["account_id", "status", "auth_method", "full_name", "headline", "seat_id", "connected_at", "external_id", "connection_location"].sort();

describe("account list / get", () => {
  it("list: no params by default; limit and cursor are forwarded; --all streams NDJSON over two pages", async () => {
    client.accounts.list.mockResolvedValue({ items: [{ account_id: "acc_1" }], cursor: null });
    await run(runAccountList, { json: true });
    expect(client.accounts.list).toHaveBeenLastCalledWith({});
    await run(runAccountList, { json: true, limit: "5", cursor: "tok_abc" });
    expect(client.accounts.list).toHaveBeenLastCalledWith({ limit: 5, cursor: "tok_abc" });
    out.stdout.write.mockClear();
    client.accounts.list.mockReset().mockResolvedValueOnce({ items: [{ account_id: "acc_1" }, { account_id: "acc_2" }], cursor: "c1" }).mockResolvedValueOnce({ items: [{ account_id: "acc_3" }], cursor: null });
    await run(runAccountList, { all: true, verbose: true });
    expect(ndjson()).toEqual([{ account_id: "acc_1" }, { account_id: "acc_2" }, { account_id: "acc_3" }]);
  });

  it("get passes the account_id verbatim", async () => {
    client.accounts.get.mockResolvedValue({ object: "account", account_id: "acc_42" });
    await run(runAccountGet, { "account-id": "acc_42", json: true });
    expect(client.accounts.get).toHaveBeenCalledWith("acc_42");
  });

  it("list: slim has exactly the slim keys, --verbose adds the enrichment field, a never-enriched item shows explicit null; --all projects per item", async () => {
    const located = { ...ENRICHED, connection_location: LOCATION };
    client.accounts.list.mockResolvedValue({ object: "account_list", items: [located], cursor: null });
    await run(runAccountList, { json: true });
    expect(Object.keys(json().items[0]).sort()).toEqual(SLIM_LIST_KEYS);
    expect(json().items[0].connection_location).toEqual(LOCATION);
    out.stdout.write.mockClear();
    await run(runAccountList, { json: true, verbose: true });
    expect(json().items[0].substrate_created_at).toBe("2020-01-01T00:00:00Z");
    out.stdout.write.mockClear();
    client.accounts.list.mockResolvedValue({ items: [{ ...ENRICHED, substrate_created_at: null }], cursor: null });
    await run(runAccountList, { json: true, verbose: true });
    expect(json().items[0]).toHaveProperty("substrate_created_at", null);
    out.stdout.write.mockClear();
    client.accounts.list.mockResolvedValue({ items: [located], cursor: null });
    await run(runAccountList, { all: true });
    expect(Object.keys(ndjson()[0]).sort()).toEqual(SLIM_LIST_KEYS);
    out.stdout.write.mockClear();
    client.accounts.list.mockResolvedValue({ items: [located], cursor: null });
    await run(runAccountList, { all: true, verbose: true });
    expect(ndjson()[0].substrate_created_at).toBe("2020-01-01T00:00:00Z");
  });

  it("get: slim keys (incl. connection_location and a null seat_id for a seatless account), --verbose is a superset", async () => {
    const full = { ...ENRICHED, connection_location: LOCATION, last_checked_at: "2026-06-08T09:00:00Z", quotas: [], account_states: [] };
    client.accounts.get.mockResolvedValue(full);
    await run(runAccountGet, { "account-id": "acc_1", json: true });
    const slim = json();
    expect(Object.keys(slim).sort()).toEqual([...SLIM_LIST_KEYS, "last_checked_at", "quotas", "account_states"].sort());
    expect(slim.connection_location).toEqual(LOCATION);
    out.stdout.write.mockClear();
    await run(runAccountGet, { "account-id": "acc_1", json: true, verbose: true });
    for (const k of Object.keys(slim)) expect(json()[k]).toEqual(slim[k]);
    expect(json().substrate_created_at).toBe("2020-01-01T00:00:00Z");
    out.stdout.write.mockClear();
    client.accounts.get.mockResolvedValue({ ...full, seat_id: null });
    await run(runAccountGet, { "account-id": "acc_1", json: true });
    expect(json().seat_id).toBeNull();
  });

  it("get takes no pagination flags but keeps --fields; list takes them all", () => {
    const subs = (accountCommand as unknown as { subCommands: Record<string, { args: object }> }).subCommands;
    for (const f of ["limit", "cursor", "all", "max-pages"]) {
      expect(subs["get"]!.args).not.toHaveProperty(f);
      expect(subs["list"]!.args).toHaveProperty(f);
    }
    expect(subs["get"]!.args).toHaveProperty("fields");
  });
});

describe("account seats", () => {
  const originalIsTTY = process.stdout.isTTY;
  afterEach(() => {
    process.stdout.isTTY = originalIsTTY;
  });

  it("calls listSeats with no params; human mode shows free/bound, the safety_warning, and '(no seats)'", async () => {
    client.accounts.listSeats.mockResolvedValue({ object: "seat_list", items: [] });
    await run(runAccountSeats, { json: true });
    expect(client.accounts.listSeats).toHaveBeenCalledWith();
    process.stdout.isTTY = true;
    client.accounts.listSeats.mockResolvedValue({
      object: "seat_list",
      items: [{ seat_id: "seat_free", occupied: false, account_id: null }, { seat_id: "seat_bound", occupied: true, account_id: "acc_1" }],
      safety_warning: { row: "invites" },
    });
    out.stdout.write.mockClear();
    await run(runAccountSeats, { json: false });
    const t = text(out.stdout);
    expect(t).toContain("seat_free: free");
    expect(t).toContain("seat_bound: bound (acc_1)");
    expect(t).not.toMatch(/seat_free: free \(/);
    expect(t).toContain('safety_warning: {"row":"invites"}');
    client.accounts.listSeats.mockResolvedValue({ object: "seat_list", items: [] });
    out.stdout.write.mockClear();
    await run(runAccountSeats, { json: false });
    expect(text(out.stdout)).toContain("(no seats)");
  });

  it("a non-page answer (no items array) exits 7", async () => {
    client.accounts.listSeats.mockResolvedValue({ object: "seat_list" });
    expect(await exitCode(() => run(runAccountSeats, { json: true }))).toBe(7);
  });
});

describe("account link", () => {
  const CRED = { "seat-id": "seat_1", "auth-method": "credentials", country: "US", email: "user@example.com", password: "secret", json: true };
  const COOKIE = { "auth-method": "cookie", "li-at": "val", "user-agent": "UA/1", country: "US", json: true };
  beforeEach(() => client.auth.intent.mockResolvedValue({ object: "account", account_id: "acc_new" }));

  it("builds the intent body for credentials and cookie auth; account_id only when --account-id is given", async () => {
    await run(runAccountLink, CRED);
    expect(client.auth.intent).toHaveBeenLastCalledWith(expect.objectContaining({ seat_id: "seat_1", auth_method: "credentials", credentials: { email: "user@example.com", password: "secret" } }));
    expect(client.auth.intent.mock.calls[0]![0]).not.toHaveProperty("account_id");
    await run(runAccountLink, { ...CRED, "account-id": "acc_x" });
    expect(client.auth.intent).toHaveBeenLastCalledWith(expect.objectContaining({ account_id: "acc_x" }));
    await run(runAccountLink, { ...COOKIE, "seat-id": "seat_1", "user-agent": "Mozilla/5.0" });
    expect(client.auth.intent).toHaveBeenLastCalledWith(expect.objectContaining({ auth_method: "cookie", user_agent: "Mozilla/5.0", cookie: expect.objectContaining({ li_at: "val" }) }));
  });

  it("--preview renders auth.intent with account_id only when given, and calls nothing", async () => {
    await run(runAccountLink, { ...CRED, json: false, preview: true, "account-id": "acc_x" });
    expect(json()).toMatchObject({ method: "auth.intent", body: { account_id: "acc_x" } });
    out.stdout.write.mockClear();
    await run(runAccountLink, { ...CRED, json: false, preview: true });
    expect(json().body).not.toHaveProperty("account_id");
    expect(client.auth.intent).not.toHaveBeenCalled();
  });

  it.each([
    ["cookie without --user-agent (names a browser)", { "seat-id": "seat_1", "auth-method": "cookie", country: "US", "li-at": "v" }],
    ["no --auth-method", { "seat-id": "seat_1" }],
    ["--seat-id '' (a value, not an omission)", { ...COOKIE, "seat-id": "" }],
    ["--seat-id blank", { ...COOKIE, "seat-id": "   " }],
    ["--preview without --seat-id (no lookup to fill it)", { ...COOKIE, preview: true }],
    ["--account-id (reconnect) without --seat-id", { ...COOKIE, "account-id": "acc_x" }],
  ])("%s exits 2 with no connect and no seats read", async (_l, flags) => {
    expect(await exitCode(() => run(runAccountLink, flags))).toBe(2);
    expect(client.auth.intent).not.toHaveBeenCalled();
    expect(client.accounts.listSeats).not.toHaveBeenCalled();
  });

  describe("sole free seat resolution (--seat-id omitted)", () => {
    const seat = (id: string, occupied = false) => ({ seat_id: id, occupied, account_id: occupied ? "acc_old" : null });
    it("one free seat is bound and the pick stated; an explicit --seat-id costs no read", async () => {
      client.accounts.listSeats.mockResolvedValue({ object: "seat_list", items: [seat("seat_taken", true), seat("seat_free")] });
      await run(runAccountLink, COOKIE);
      expect(client.auth.intent).toHaveBeenCalledWith(expect.objectContaining({ seat_id: "seat_free" }));
      expect(text(out.stderr)).toContain("seat_free");
      client.accounts.listSeats.mockClear();
      await run(runAccountLink, { ...COOKIE, "seat-id": "seat_x" });
      expect(client.accounts.listSeats).not.toHaveBeenCalled();
      expect(client.auth.intent).toHaveBeenLastCalledWith(expect.objectContaining({ seat_id: "seat_x" }));
    });

    it.each([
      ["none free", [seat("seat_taken", true)], "curviate account seats"],
      ["several free", [seat("seat_a"), seat("seat_b")], "seat_b"],
      ["an unreadable row beside a free seat", [seat("seat_free"), { occupied: false, account_id: null }], ""],
      ["a null row", [null, seat("seat_free")], "could not read"],
    ])("%s: exit 2, nothing connected", async (_l, items, hint) => {
      client.accounts.listSeats.mockResolvedValue({ object: "seat_list", items });
      expect(await exitCode(() => run(runAccountLink, COOKIE))).toBe(2);
      expect(text(out.stderr)).toContain(hint);
      expect(client.auth.intent).not.toHaveBeenCalled();
    });

    it("the seats read failing is reported as itself (UNAUTHORIZED -> 3)", async () => {
      client.accounts.listSeats.mockRejectedValue(new CurviateError({ code: "UNAUTHORIZED", message: "bad key", userFixable: true, retryLikelyToSucceed: false } as never));
      expect(await exitCode(() => run(runAccountLink, COOKIE))).toBe(3);
      expect(client.auth.intent).not.toHaveBeenCalled();
    });
  });
});

describe("account update / disconnect / checkpoint", () => {
  it("update: --metadata is forwarded as an object; --clear-proxy --country sends proxy:null; a non-object metadata exits 2 first", async () => {
    client.accounts.update.mockResolvedValue({ object: "account", account_id: "acc_1" });
    await run(runAccountUpdate, { "account-id": "acc_1", metadata: '{"team":"growth"}', json: true });
    expect(client.accounts.update).toHaveBeenLastCalledWith("acc_1", { metadata: { team: "growth" } });
    await run(runAccountUpdate, { "account-id": "acc_1", "clear-proxy": true, country: "de", json: true });
    expect(client.accounts.update).toHaveBeenLastCalledWith("acc_1", { proxy: null, country: "DE" });
    client.accounts.update.mockClear();
    expect(await exitCode(() => run(runAccountUpdate, { "account-id": "acc_1", metadata: "not-json", json: true }))).toBe(2);
    expect(client.accounts.update).not.toHaveBeenCalled();
  });

  it("disconnect passes the id verbatim", async () => {
    client.accounts.disconnect.mockResolvedValue({ object: "account_disconnected", account_id: "acc_1" });
    await run(runAccountDisconnect, { "account-id": "acc_1", json: true });
    expect(client.accounts.disconnect).toHaveBeenCalledWith("acc_1");
  });

  it.each([
    ["update", runAccountUpdate, client.accounts.update, "accounts.update", { metadata: '{"team":"ops"}' }],
    ["disconnect", runAccountDisconnect, client.accounts.disconnect, "accounts.disconnect", {}],
    ["checkpoint solve", runAccountCheckpointSolve, client.auth.solveCheckpoint, "auth.solveCheckpoint", { code: "654321" }],
    ["checkpoint poll", runAccountCheckpointPoll, client.auth.pollCheckpoint, "auth.pollCheckpoint", {}],
  ])("%s --preview renders the request without calling the SDK", async (_l, fn, sdk, method, extra) => {
    await run(fn as never, { "account-id": "acc_pending_1", preview: true, ...extra });
    expect(sdk).not.toHaveBeenCalled();
    expect(json()).toMatchObject({ method, args: { accountId: "acc_pending_1" } });
  });

  it("solve: account_id is the path arg and the body only the code, which --preview masks", async () => {
    client.auth.solveCheckpoint.mockResolvedValue({ object: "account", status: "active" });
    await run(runAccountCheckpointSolve, { "account-id": "acc_pending_1", code: "123456", json: true });
    expect(client.auth.solveCheckpoint).toHaveBeenCalledWith("acc_pending_1", { code: "123456" });
    out.stdout.write.mockClear();
    await run(runAccountCheckpointSolve, { "account-id": "acc_pending_1", code: "654321", preview: true });
    expect(json().body).toHaveProperty("code", "••••");
    expect(text(out.stdout)).not.toContain("654321");
  });

  it("poll passes the id as a string; solve and poll exit 2 on a missing id, solve also on a missing --code", async () => {
    client.auth.pollCheckpoint.mockResolvedValue({ object: "checkpoint", status: "pending" });
    await run(runAccountCheckpointPoll, { "account-id": "acc_pending_1", json: true });
    expect(client.auth.pollCheckpoint).toHaveBeenCalledWith("acc_pending_1");
    for (const [fn, flags] of [[runAccountCheckpointPoll, {}], [runAccountCheckpointSolve, { code: "123456" }], [runAccountCheckpointSolve, { "account-id": "acc_1" }]] as const) {
      expect(await exitCode(() => run(fn as never, flags))).toBe(2);
    }
    expect(client.auth.solveCheckpoint).not.toHaveBeenCalled();
    expect(client.auth.pollCheckpoint).toHaveBeenCalledTimes(1);
  });
});
