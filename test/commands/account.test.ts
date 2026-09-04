/**
 * Tests for the `account` command group (root-scoped).
 *
 * Covers:
 *   account list           — accounts.list() + --all pagination
 *   account get            — accounts.get()
 *   account link           — auth.intent() body-flag + required flags + --preview
 *   account update         — accounts.update() (metadata/proxy) + --preview
 *   account disconnect     — accounts.disconnect() + --preview
 *   account checkpoint solve — accounts.solveCheckpoint() path-addressed + --preview
 *   account checkpoint poll  — accounts.pollCheckpoint() path-addressed + --preview
 *
 * All methods are root-scoped: the client exposes `client.accounts.*` directly
 * (no `client.account(id)` wrapper for these). account_id positionals pass
 * through verbatim (no resolveIdentifier).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

// ---------------------------------------------------------------------------
// Client mock factory
// ---------------------------------------------------------------------------

function makeClient() {
  return {
    accounts: {
      list: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
      disconnect: vi.fn(),
    },
    auth: {
      intent: vi.fn(),
      solveCheckpoint: vi.fn(),
      pollCheckpoint: vi.fn(),
      requestCheckpoint: vi.fn(),
      getSession: vi.fn(),
    },
  };
}

type Client = ReturnType<typeof makeClient>;

type AccountFlags = {
  "account-id"?: string;
  "seat-id"?: string;
  "auth-method"?: string;
  email?: string;
  password?: string;
  "li-at"?: string;
  "li-a"?: string;
  country?: string;
  ip?: string;
  "proxy-protocol"?: string;
  "proxy-host"?: string;
  "proxy-port"?: string;
  "proxy-username"?: string;
  "proxy-password"?: string;
  "user-agent"?: string;
  "recruiter-contract-id"?: string;
  purpose?: string;
  "expires-in-seconds"?: string;
  "redirect-url"?: string;
  checkpoint?: string;
  code?: string;
  name?: string;
  "request-url"?: string;
  "account-ids"?: string;
  enabled?: boolean;
  events?: string;
  format?: string;
  json?: boolean;
  all?: boolean;
  "max-pages"?: string;
  limit?: string;
  cursor?: string;
  fields?: string;
  preview?: boolean;
  verbose?: boolean;
  "api-key"?: string;
  "base-url"?: string;
  timeout?: string;
  profile?: string;
};

function makeOut() {
  return {
    stdout: { write: vi.fn() },
    stderr: { write: vi.fn() },
  };
}

// ---------------------------------------------------------------------------
// account list
// ---------------------------------------------------------------------------

describe("account list", () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
    (client.accounts.list as Mock).mockResolvedValue({ items: [{ account_id: "acc_1" }], cursor: null });
  });

  afterEach(() => vi.restoreAllMocks());

  it("calls accounts.list() with no params by default", async () => {
    const { runAccountList } = await import("../../src/commands/account.js");
    const out = makeOut();
    await runAccountList(client as never, { json: true } as AccountFlags, out);
    expect(client.accounts.list).toHaveBeenCalledWith({});
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    expect(JSON.parse(written)).toHaveProperty("items");
  });

  it("passes limit and cursor", async () => {
    const { runAccountList } = await import("../../src/commands/account.js");
    const out = makeOut();
    await runAccountList(client as never, { json: true, limit: "5", cursor: "tok_abc" } as AccountFlags, out);
    expect(client.accounts.list).toHaveBeenCalledWith({ limit: 5, cursor: "tok_abc" });
  });

  it("--all streams NDJSON over two pages (--verbose to isolate pagination mechanics from slim projection — see the dedicated slim/verbose describe block below)", async () => {
    const { runAccountList } = await import("../../src/commands/account.js");
    const out = makeOut();
    (client.accounts.list as Mock)
      .mockResolvedValueOnce({ items: [{ account_id: "acc_1" }, { account_id: "acc_2" }], cursor: "c1" })
      .mockResolvedValueOnce({ items: [{ account_id: "acc_3" }], cursor: null });

    await runAccountList(client as never, { all: true, verbose: true } as AccountFlags, out);

    const lines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string);
    const ndjson = lines.filter((l) => l.trim().startsWith("{"));
    expect(ndjson).toHaveLength(3);
    expect(JSON.parse(ndjson[0]!)).toEqual({ account_id: "acc_1" });
    expect(JSON.parse(ndjson[2]!)).toEqual({ account_id: "acc_3" });
  });

  it("--preview on a read command exits 2", async () => {
    const { runAccountList } = await import("../../src/commands/account.js");
    const out = makeOut();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runAccountList(client as never, { preview: true } as AccountFlags, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// account get
// ---------------------------------------------------------------------------

describe("account get", () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
    (client.accounts.get as Mock).mockResolvedValue({ object: "account", account_id: "acc_42" });
  });

  afterEach(() => vi.restoreAllMocks());

  it("calls accounts.get with verbatim account_id", async () => {
    const { runAccountGet } = await import("../../src/commands/account.js");
    const out = makeOut();
    await runAccountGet(client as never, { "account-id": "acc_42", json: true } as AccountFlags, out);
    expect(client.accounts.get).toHaveBeenCalledWith("acc_42");
  });

  it("account_id is NOT URL-resolved (pass through verbatim)", async () => {
    const { runAccountGet } = await import("../../src/commands/account.js");
    const out = makeOut();
    // Weird value — should pass through unchanged, not normalized
    await runAccountGet(client as never, { "account-id": "acc_abc123", json: true } as AccountFlags, out);
    expect(client.accounts.get).toHaveBeenCalledWith("acc_abc123");
  });

  it("--preview on a read command exits 2", async () => {
    const { runAccountGet } = await import("../../src/commands/account.js");
    const out = makeOut();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runAccountGet(client as never, { "account-id": "acc_1", preview: true } as AccountFlags, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// account list / account get — slim/verbose split
// ---------------------------------------------------------------------------

const ENRICHED_ITEM = {
  account_id: "acc_1",
  status: "active",
  auth_method: "credentials",
  full_name: "Ada Lovelace",
  headline: "Engineer",
  seat_id: "seat_1",
  connected_at: "2026-06-01T09:00:00Z",
  username: "ada.lovelace",
  premium_id: "prem_1",
  public_identifier: "ada-lovelace",
  substrate_created_at: "2020-01-01T00:00:00Z",
  signatures: [{ title: "Default", content: "Best, Ada" }],
  groups: ["Alumni Network"],
};

const NEVER_ENRICHED_ITEM = {
  account_id: "acc_2",
  status: "active",
  auth_method: "credentials",
  full_name: "Bob Babbage",
  headline: null,
  seat_id: "seat_2",
  connected_at: "2026-06-02T09:00:00Z",
  username: null,
  premium_id: null,
  public_identifier: null,
  substrate_created_at: null,
  signatures: [],
  groups: [],
};

const SLIM_LIST_KEYS = ["account_id", "status", "auth_method", "full_name", "headline", "seat_id", "connected_at"];
const ENRICHMENT_KEYS = ["username", "premium_id", "public_identifier", "substrate_created_at", "signatures", "groups"];

describe("account list — slim/verbose split", () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
    (client.accounts.list as Mock).mockResolvedValue({
      object: "account_list",
      items: [ENRICHED_ITEM],
      cursor: null,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("slim mode: item has exactly the 7 slim keys, no enrichment fields", async () => {
    const { runAccountList } = await import("../../src/commands/account.js");
    const out = makeOut();
    await runAccountList(client as never, { json: true } as AccountFlags, out);
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(Object.keys(parsed.items[0]).sort()).toEqual([...SLIM_LIST_KEYS].sort());
    for (const key of ENRICHMENT_KEYS) {
      expect(parsed.items[0]).not.toHaveProperty(key);
    }
  });

  it("--verbose: item additionally has all six enrichment fields matching the fixture", async () => {
    const { runAccountList } = await import("../../src/commands/account.js");
    const out = makeOut();
    await runAccountList(client as never, { json: true, verbose: true } as AccountFlags, out);
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.items[0]).toMatchObject({
      username: "ada.lovelace",
      premium_id: "prem_1",
      public_identifier: "ada-lovelace",
      substrate_created_at: "2020-01-01T00:00:00Z",
      signatures: [{ title: "Default", content: "Best, Ada" }],
      groups: ["Alumni Network"],
    });
  });

  it("--verbose on a never-enriched item shows explicit null/[] — not undefined, not a missing key", async () => {
    (client.accounts.list as Mock).mockResolvedValue({
      object: "account_list",
      items: [NEVER_ENRICHED_ITEM],
      cursor: null,
    });
    const { runAccountList } = await import("../../src/commands/account.js");
    const out = makeOut();
    await runAccountList(client as never, { json: true, verbose: true } as AccountFlags, out);
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    const item = parsed.items[0];
    for (const key of ["username", "premium_id", "public_identifier", "substrate_created_at"]) {
      expect(item).toHaveProperty(key);
      expect(item[key]).toBeNull();
    }
    expect(item.signatures).toEqual([]);
    expect(item.groups).toEqual([]);
  });

  it("--all NDJSON stream applies slim projection per item unless --verbose", async () => {
    (client.accounts.list as Mock)
      .mockResolvedValueOnce({ items: [ENRICHED_ITEM], cursor: null });
    const { runAccountList } = await import("../../src/commands/account.js");
    const out = makeOut();
    await runAccountList(client as never, { all: true } as AccountFlags, out);
    const lines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).filter((l) => l.trim().startsWith("{"));
    const item = JSON.parse(lines[0]!);
    expect(Object.keys(item).sort()).toEqual([...SLIM_LIST_KEYS].sort());
  });

  it("--all --verbose NDJSON stream emits the full item verbatim", async () => {
    (client.accounts.list as Mock)
      .mockResolvedValueOnce({ items: [ENRICHED_ITEM], cursor: null });
    const { runAccountList } = await import("../../src/commands/account.js");
    const out = makeOut();
    await runAccountList(client as never, { all: true, verbose: true } as AccountFlags, out);
    const lines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).filter((l) => l.trim().startsWith("{"));
    const item = JSON.parse(lines[0]!);
    expect(item.username).toBe("ada.lovelace");
  });
});

describe("account get — slim/verbose split (first-ever on this command)", () => {
  let client: Client;

  const GET_FIXTURE = {
    ...ENRICHED_ITEM,
    last_checked_at: "2026-06-08T09:00:00Z",
    quotas: [],
    account_states: ["commercial_use_limited"],
  };
  const SLIM_GET_KEYS = [...SLIM_LIST_KEYS, "last_checked_at", "quotas", "account_states"];

  beforeEach(() => {
    client = makeClient();
    (client.accounts.get as Mock).mockResolvedValue(GET_FIXTURE);
  });

  afterEach(() => vi.restoreAllMocks());

  it("slim mode: exactly the 10 slim keys, seat_id present, no enrichment fields", async () => {
    const { runAccountGet } = await import("../../src/commands/account.js");
    const out = makeOut();
    await runAccountGet(client as never, { "account-id": "acc_1", json: true } as AccountFlags, out);
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(Object.keys(parsed).sort()).toEqual([...SLIM_GET_KEYS].sort());
    expect(parsed.seat_id).toBe("seat_1");
    // The value survives, not just the key. Two of the three states are read
    // on responses that SUCCEEDED, so an operator who does not see them
    // concludes the CLI is returning bad data.
    expect(parsed.account_states).toEqual(["commercial_use_limited"]);
    for (const key of ENRICHMENT_KEYS) {
      expect(parsed).not.toHaveProperty(key);
    }
  });

  it("--verbose: all six enrichment fields present and matching", async () => {
    const { runAccountGet } = await import("../../src/commands/account.js");
    const out = makeOut();
    await runAccountGet(client as never, { "account-id": "acc_1", json: true, verbose: true } as AccountFlags, out);
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed).toMatchObject({
      username: "ada.lovelace",
      premium_id: "prem_1",
      public_identifier: "ada-lovelace",
      substrate_created_at: "2020-01-01T00:00:00Z",
      signatures: [{ title: "Default", content: "Best, Ada" }],
      groups: ["Alumni Network"],
    });
  });

  it("an account in no platform condition still carries the key, as an empty array", async () => {
    // A field that appears only when non-empty changes a scripted caller's
    // parse the first time something goes wrong, which is the worst moment.
    (client.accounts.get as Mock).mockResolvedValue({ ...GET_FIXTURE, account_states: undefined });
    const { runAccountGet } = await import("../../src/commands/account.js");
    const out = makeOut();
    await runAccountGet(client as never, { "account-id": "acc_1", json: true } as AccountFlags, out);
    const parsed = JSON.parse((out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join(""));
    expect(parsed).toHaveProperty("account_states");
    expect(parsed.account_states).toEqual([]);
  });

  it("admin seatless account: slim seat_id === null in both modes", async () => {
    (client.accounts.get as Mock).mockResolvedValue({ ...GET_FIXTURE, seat_id: null });
    const { runAccountGet } = await import("../../src/commands/account.js");

    const out1 = makeOut();
    await runAccountGet(client as never, { "account-id": "acc_1", json: true } as AccountFlags, out1);
    const parsed1 = JSON.parse((out1.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join(""));
    expect(parsed1.seat_id).toBeNull();

    const out2 = makeOut();
    await runAccountGet(client as never, { "account-id": "acc_1", json: true, verbose: true } as AccountFlags, out2);
    const parsed2 = JSON.parse((out2.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join(""));
    expect(parsed2.seat_id).toBeNull();
  });

  it("slim output is a strict subset of keys of the verbose output", async () => {
    const { runAccountGet } = await import("../../src/commands/account.js");

    const outSlim = makeOut();
    await runAccountGet(client as never, { "account-id": "acc_1", json: true } as AccountFlags, outSlim);
    const slimParsed = JSON.parse((outSlim.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join(""));

    const outVerbose = makeOut();
    await runAccountGet(client as never, { "account-id": "acc_1", json: true, verbose: true } as AccountFlags, outVerbose);
    const verboseParsed = JSON.parse((outVerbose.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join(""));

    for (const key of Object.keys(slimParsed)) {
      expect(verboseParsed).toHaveProperty(key);
      expect(verboseParsed[key]).toEqual(slimParsed[key]);
    }
  });
});

// ---------------------------------------------------------------------------
// account get — pagination-flag suppression
// ---------------------------------------------------------------------------

describe("account get — args definition suppresses pagination flags, keeps --fields", () => {
  const PAGINATION_ONLY_FLAGS = ["limit", "cursor", "all", "max-pages"] as const;

  it("account get — args definition has no pagination-only flags", async () => {
    const { accountCommand } = await import("../../src/commands/account.js");
    const subCmds = (accountCommand as Record<string, unknown>).subCommands as Record<
      string,
      { args?: Record<string, unknown> }
    >;
    const args = subCmds["get"]?.args ?? {};
    for (const flag of PAGINATION_ONLY_FLAGS) {
      expect(args, `account get args must NOT include --${flag}`).not.toHaveProperty(flag);
    }
    expect(args, "account get must keep --fields (single-object read)").toHaveProperty("fields");
  });

  it("account list — args definition DOES have all pagination flags (negative control)", async () => {
    const { accountCommand } = await import("../../src/commands/account.js");
    const subCmds = (accountCommand as Record<string, unknown>).subCommands as Record<
      string,
      { args?: Record<string, unknown> }
    >;
    const args = subCmds["list"]?.args ?? {};
    for (const flag of PAGINATION_ONLY_FLAGS) {
      expect(args, `account list args must include --${flag}`).toHaveProperty(flag);
    }
  });
});

// ---------------------------------------------------------------------------
// account link
// ---------------------------------------------------------------------------

describe("account link", () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
    (client.auth.intent as Mock).mockResolvedValue({ object: "account", account_id: "acc_new" });
  });

  afterEach(() => vi.restoreAllMocks());

  it("calls accounts.link with required body fields (credentials method)", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const out = makeOut();
    await runAccountLink(client as never, {
      "seat-id": "seat_1",
      "auth-method": "credentials",
      email: "user@example.com",
      password: "secret",
      json: true,
    } as AccountFlags, out);

    expect(client.auth.intent).toHaveBeenCalledWith(
      expect.objectContaining({
        seat_id: "seat_1",
        auth_method: "credentials",
        credentials: { email: "user@example.com", password: "secret" },
      }),
    );
  });

  it("calls accounts.link with cookie method (user_agent required for cookie auth)", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const out = makeOut();
    await runAccountLink(client as never, {
      "seat-id": "seat_1",
      "auth-method": "cookie",
      "li-at": "li_at_value",
      "user-agent": "Mozilla/5.0",
      json: true,
    } as AccountFlags, out);

    expect(client.auth.intent).toHaveBeenCalledWith(
      expect.objectContaining({
        seat_id: "seat_1",
        auth_method: "cookie",
        user_agent: "Mozilla/5.0",
        cookie: expect.objectContaining({ li_at: "li_at_value" }),
      }),
    );
  });

  it("cookie auth without --user-agent exits 2 before calling accounts.link", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const out = makeOut();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runAccountLink(client as never, {
        "seat-id": "seat_1",
        "auth-method": "cookie",
        "li-at": "li_at_value",
      } as AccountFlags, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(client.auth.intent).not.toHaveBeenCalled();
  });

  it("missing --seat-id exits 2", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const out = makeOut();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runAccountLink(client as never, { "auth-method": "cookie", "li-at": "val" } as AccountFlags, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(client.auth.intent).not.toHaveBeenCalled();
  });

  it("missing --auth-method exits 2", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const out = makeOut();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runAccountLink(client as never, { "seat-id": "seat_1" } as AccountFlags, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(client.auth.intent).not.toHaveBeenCalled();
  });

  it("--preview renders request, does not call accounts.link", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const out = makeOut();
    await runAccountLink(client as never, {
      "seat-id": "seat_1",
      "auth-method": "cookie",
      "li-at": "li_at_value",
      "user-agent": "Mozilla/5.0",
      preview: true,
    } as AccountFlags, out);

    expect(client.auth.intent).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("auth.intent");
  });

  // --account-id: the 0.15.0 in-place reconnect flag.

  it("forwards --account-id as account_id in the auth.intent body (in-place reconnect)", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const out = makeOut();
    await runAccountLink(client as never, {
      "seat-id": "seat_1",
      "auth-method": "credentials",
      email: "user@example.com",
      password: "secret",
      "account-id": "acc_x",
      json: true,
    } as AccountFlags, out);

    expect(client.auth.intent).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: "acc_x" }),
    );
  });

  it("omits account_id ENTIRELY from the body when --account-id is not passed (not undefined, not empty)", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const out = makeOut();
    await runAccountLink(client as never, {
      "seat-id": "seat_1",
      "auth-method": "credentials",
      email: "user@example.com",
      password: "secret",
      json: true,
    } as AccountFlags, out);

    const body = (client.auth.intent as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).not.toHaveProperty("account_id");
  });

  it("--preview with --account-id renders the auth.intent body with account_id present", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const out = makeOut();
    await runAccountLink(client as never, {
      "seat-id": "seat_1",
      "auth-method": "credentials",
      email: "a@b.c",
      password: "secret",
      "account-id": "acc_x",
      preview: true,
    } as AccountFlags, out);

    expect(client.auth.intent).not.toHaveBeenCalled();
    const parsed = JSON.parse((out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join(""));
    expect(parsed.method).toBe("auth.intent");
    expect(parsed.body.account_id).toBe("acc_x");
  });

  it("--preview without --account-id renders a body with NO account_id key (control)", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const out = makeOut();
    await runAccountLink(client as never, {
      "seat-id": "seat_1",
      "auth-method": "credentials",
      email: "a@b.c",
      password: "secret",
      preview: true,
    } as AccountFlags, out);

    const parsed = JSON.parse((out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join(""));
    expect(parsed.body).not.toHaveProperty("account_id");
  });
});

// ---------------------------------------------------------------------------
// account update (reshaped: metadata / proxy / --clear-proxy; no country/ip)
// ---------------------------------------------------------------------------

describe("account update", () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
    (client.accounts.update as Mock).mockResolvedValue({ object: "account", account_id: "acc_1" });
  });

  afterEach(() => vi.restoreAllMocks());

  it("forwards a --metadata JSON object as the metadata body field", async () => {
    const { runAccountUpdate } = await import("../../src/commands/account.js");
    const out = makeOut();
    await runAccountUpdate(client as never, {
      "account-id": "acc_1",
      metadata: '{"team":"growth"}',
      json: true,
    } as AccountFlags, out);

    expect(client.accounts.update).toHaveBeenCalledWith(
      "acc_1",
      { metadata: { team: "growth" } },
    );
  });

  it("--clear-proxy sends proxy:null", async () => {
    const { runAccountUpdate } = await import("../../src/commands/account.js");
    const out = makeOut();
    await runAccountUpdate(client as never, {
      "account-id": "acc_1",
      "clear-proxy": true,
      json: true,
    } as AccountFlags, out);

    expect(client.accounts.update).toHaveBeenCalledWith("acc_1", { proxy: null });
  });

  it("rejects a non-object --metadata with exit 2 before calling update", async () => {
    const { runAccountUpdate } = await import("../../src/commands/account.js");
    const out = makeOut();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runAccountUpdate(client as never, {
        "account-id": "acc_1",
        metadata: "not-json",
        json: true,
      } as AccountFlags, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(client.accounts.update).not.toHaveBeenCalled();
  });

  it("--preview renders request without calling update", async () => {
    const { runAccountUpdate } = await import("../../src/commands/account.js");
    const out = makeOut();
    await runAccountUpdate(client as never, {
      "account-id": "acc_1",
      metadata: '{"team":"ops"}',
      preview: true,
    } as AccountFlags, out);

    expect(client.accounts.update).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("accounts.update");
    expect(parsed.args).toHaveProperty("accountId", "acc_1");
  });
});

// ---------------------------------------------------------------------------
// account disconnect
// ---------------------------------------------------------------------------

describe("account disconnect", () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
    (client.accounts.disconnect as Mock).mockResolvedValue({ object: "account_disconnected", account_id: "acc_1" });
  });

  afterEach(() => vi.restoreAllMocks());

  it("calls accounts.disconnect with verbatim account_id", async () => {
    const { runAccountDisconnect } = await import("../../src/commands/account.js");
    const out = makeOut();
    await runAccountDisconnect(client as never, { "account-id": "acc_1", json: true } as AccountFlags, out);
    expect(client.accounts.disconnect).toHaveBeenCalledWith("acc_1");
  });

  it("--preview renders request without calling disconnect", async () => {
    const { runAccountDisconnect } = await import("../../src/commands/account.js");
    const out = makeOut();
    await runAccountDisconnect(client as never, { "account-id": "acc_1", preview: true } as AccountFlags, out);
    expect(client.accounts.disconnect).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("accounts.disconnect");
  });
});

// ---------------------------------------------------------------------------
// account checkpoint solve (path-addressed — account_id positional, body {code})
// ---------------------------------------------------------------------------

describe("account checkpoint solve", () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
    (client.auth.solveCheckpoint as Mock).mockResolvedValue({ object: "account", status: "active" });
  });

  afterEach(() => vi.restoreAllMocks());

  it("account_id is the path arg (positional); the body carries only the code", async () => {
    const { runAccountCheckpointSolve } = await import("../../src/commands/account.js");
    const out = makeOut();
    await runAccountCheckpointSolve(client as never, {
      "account-id": "acc_pending_1",
      code: "123456",
      json: true,
    } as AccountFlags, out);

    // The SDK signature is solveCheckpoint(accountId, { code }).
    expect(client.auth.solveCheckpoint).toHaveBeenCalledWith("acc_pending_1", { code: "123456" });
  });

  it("missing account_id exits 2", async () => {
    const { runAccountCheckpointSolve } = await import("../../src/commands/account.js");
    const out = makeOut();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runAccountCheckpointSolve(client as never, { code: "123456" } as AccountFlags, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(client.auth.solveCheckpoint).not.toHaveBeenCalled();
  });

  it("missing --code exits 2", async () => {
    const { runAccountCheckpointSolve } = await import("../../src/commands/account.js");
    const out = makeOut();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runAccountCheckpointSolve(client as never, { "account-id": "acc_1" } as AccountFlags, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(client.auth.solveCheckpoint).not.toHaveBeenCalled();
  });

  it("--preview renders without calling solveCheckpoint", async () => {
    const { runAccountCheckpointSolve } = await import("../../src/commands/account.js");
    const out = makeOut();
    await runAccountCheckpointSolve(client as never, {
      "account-id": "acc_pending_1",
      code: "654321",
      preview: true,
    } as AccountFlags, out);

    expect(client.auth.solveCheckpoint).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("auth.solveCheckpoint");
    // account_id is a path/positional arg; the body carries the code.
    expect(parsed.args).toHaveProperty("accountId", "acc_pending_1");
    expect(parsed.body).toHaveProperty("code", "654321");
  });
});

// ---------------------------------------------------------------------------
// account checkpoint poll (path-addressed — account_id positional, no body)
// ---------------------------------------------------------------------------

describe("account checkpoint poll", () => {
  let client: Client;

  beforeEach(() => {
    client = makeClient();
    (client.auth.pollCheckpoint as Mock).mockResolvedValue({ object: "checkpoint", status: "pending" });
  });

  afterEach(() => vi.restoreAllMocks());

  it("account_id is the path arg (positional), passed as a string", async () => {
    const { runAccountCheckpointPoll } = await import("../../src/commands/account.js");
    const out = makeOut();
    await runAccountCheckpointPoll(client as never, {
      "account-id": "acc_pending_1",
      json: true,
    } as AccountFlags, out);

    expect(client.auth.pollCheckpoint).toHaveBeenCalledWith("acc_pending_1");
  });

  it("missing account_id exits 2", async () => {
    const { runAccountCheckpointPoll } = await import("../../src/commands/account.js");
    const out = makeOut();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runAccountCheckpointPoll(client as never, {} as AccountFlags, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(client.auth.pollCheckpoint).not.toHaveBeenCalled();
  });

  it("--preview renders without calling pollCheckpoint", async () => {
    const { runAccountCheckpointPoll } = await import("../../src/commands/account.js");
    const out = makeOut();
    await runAccountCheckpointPoll(client as never, {
      "account-id": "acc_pending_1",
      preview: true,
    } as AccountFlags, out);

    expect(client.auth.pollCheckpoint).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("auth.pollCheckpoint");
    expect(parsed.args).toHaveProperty("accountId", "acc_pending_1");
  });
});
