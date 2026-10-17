/**
 * Tests for the new `company` sub-resource commands closing the SDK-parity
 * gap:
 *
 *   company managed                              → companies.managed(params)               (list read, no <id>)
 *   company followers <id>                       → companies.followers(id, params)          (list read)
 *   company chats <id>                           → companies.chats(id, params)              (list read, Beta)
 *   company chat <id> <chat_id>                  → companies.chat(id, chat_id)              (single read, Beta)
 *   company messages <id> <chat_id>               → companies.messages(id, chat_id, params)  (list read, Beta)
 *   company message <id> <chat_id> <message_id>   → companies.message(id, chat_id, message_id) (single read, Beta)
 *   company search-chats <id> [<query>]           → companies.searchChats(id, params)        (list read, Beta)
 *
 * `company message` (a GET single-message read) is distinct from the
 * pre-existing `company reply` (a POST send, via companies.sendMessage) —
 * see the SDK-signature-wins deviation noted in src/commands/company.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { noConnectedAccounts } from "../helpers/no-connected-accounts.js";
import { runCompanyChat, runCompanyChats, runCompanyFollowers, runCompanyManaged, runCompanyMessage, runCompanyMessages, runCompanySearchChats } from "../../src/commands/company.js";
import { exitCode } from "../helpers/exit-code.js";

function makeAccountNs() {
  return {
    companies: {
      get: vi.fn(),
      managed: vi.fn(),
      followers: vi.fn(),
      chats: vi.fn(),
      chat: vi.fn(),
      messages: vi.fn(),
      message: vi.fn(),
      searchChats: vi.fn(),
    },
  };
}

function makeClient(accountNs: ReturnType<typeof makeAccountNs>) {
  return { account: vi.fn().mockReturnValue(accountNs) };
}

function makeOut() {
  return { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
}

type Args = Record<string, unknown>;

describe("company managed", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;
  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.companies.managed as Mock).mockResolvedValue({ items: [{ id: "112013061", name: "Acme" }], cursor: null });
  });
  afterEach(() => vi.restoreAllMocks());

  it("calls companies.managed with no identifier", async () => {
    await runCompanyManaged(client as never, { account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.companies.managed).toHaveBeenCalledWith({});
    expect(accountNs.companies.get).not.toHaveBeenCalled();
  });

  it("--json prints the full response shape", async () => {
    const out = makeOut();
    await runCompanyManaged(client as never, { account: "acc_1", json: true } as Args, out);
    const written = JSON.parse((out.stdout.write as Mock).mock.calls[0]![0] as string);
    expect(written).toEqual({ items: [{ id: "112013061", name: "Acme" }], cursor: null });
  });

  it("--limit/--cursor pass through", async () => {
    await runCompanyManaged(client as never, { account: "acc_1", limit: "5", cursor: "cur_1", json: true } as Args, makeOut());
    expect(accountNs.companies.managed).toHaveBeenCalledWith(expect.objectContaining({ limit: 5, cursor: "cur_1" }));
  });

  it("--all streams NDJSON", async () => {
    (accountNs.companies.managed as Mock)
      .mockResolvedValueOnce({ items: [{ id: "1" }], cursor: "cur_1" })
      .mockResolvedValueOnce({ items: [{ id: "2" }], cursor: null });
    const out = makeOut();
    await runCompanyManaged(client as never, { account: "acc_1", all: true } as Args, out);
    const lines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).filter((l) => l.trim().startsWith("{"));
    expect(lines).toHaveLength(2);
  });

  it("missing account → exit 2", async () => {
    expect(await exitCode(() => runCompanyManaged(noConnectedAccounts(client) as never, { json: true } as Args, makeOut()))).toBe(2);
  });
});

describe("company followers", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;
  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.companies.followers as Mock).mockResolvedValue({ items: [{ id: "f1" }], cursor: null });
  });
  afterEach(() => vi.restoreAllMocks());

  it("numeric id passes through with no companies.get call", async () => {
    await runCompanyFollowers(client as never, { id: "112013061", account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.companies.get).not.toHaveBeenCalled();
    expect(accountNs.companies.followers).toHaveBeenCalledWith("112013061", {});
  });

  it("slug resolves to the numeric id via companies.get first", async () => {
    (accountNs.companies.get as Mock).mockResolvedValue({ id: "112013061" });
    await runCompanyFollowers(client as never, { id: "t-systems", account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.companies.get).toHaveBeenCalledWith("t-systems");
    expect(accountNs.companies.followers).toHaveBeenCalledWith("112013061", {});
  });

  it("--all streams NDJSON", async () => {
    (accountNs.companies.followers as Mock)
      .mockResolvedValueOnce({ items: [{ id: "1" }], cursor: "cur_1" })
      .mockResolvedValueOnce({ items: [{ id: "2" }], cursor: null });
    const out = makeOut();
    await runCompanyFollowers(client as never, { id: "112013061", account: "acc_1", all: true } as Args, out);
    const lines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).filter((l) => l.trim().startsWith("{"));
    expect(lines).toHaveLength(2);
  });
});

describe("company chats", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;
  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.companies.chats as Mock).mockResolvedValue({ items: [{ id: "2-abc" }], cursor: null });
  });
  afterEach(() => vi.restoreAllMocks());

  it("calls companies.chats with the resolved identifier", async () => {
    await runCompanyChats(client as never, { id: "112013061", account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.companies.chats).toHaveBeenCalledWith("112013061", {});
  });

  it("--all streams NDJSON", async () => {
    (accountNs.companies.chats as Mock)
      .mockResolvedValueOnce({ items: [{ id: "1" }], cursor: "cur_1" })
      .mockResolvedValueOnce({ items: [{ id: "2" }], cursor: null });
    const out = makeOut();
    await runCompanyChats(client as never, { id: "112013061", account: "acc_1", all: true } as Args, out);
    const lines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).filter((l) => l.trim().startsWith("{"));
    expect(lines).toHaveLength(2);
  });
});

describe("company chat", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;
  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.companies.chat as Mock).mockResolvedValue({ id: "2-abc", is_group_chat: false });
  });
  afterEach(() => vi.restoreAllMocks());

  it("calls companies.chat with the resolved identifier and the verbatim chat id", async () => {
    await runCompanyChat(client as never, { id: "112013061", chatId: "2-abc", account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.companies.chat).toHaveBeenCalledWith("112013061", "2-abc");
  });

  it("--json prints the full response shape", async () => {
    const out = makeOut();
    await runCompanyChat(client as never, { id: "112013061", chatId: "2-abc", account: "acc_1", json: true } as Args, out);
    const written = JSON.parse((out.stdout.write as Mock).mock.calls[0]![0] as string);
    expect(written).toEqual({ id: "2-abc", is_group_chat: false });
  });

  it("--all → usage error exit 2 (not paginated)", async () => {
    expect(await exitCode(() => runCompanyChat(client as never, { id: "112013061", chatId: "2-abc", account: "acc_1", all: true } as Args, makeOut()))).toBe(2);
  });
});

describe("company messages", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;
  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.companies.messages as Mock).mockResolvedValue({ items: [{ id: "m1" }], cursor: null });
  });
  afterEach(() => vi.restoreAllMocks());

  it("calls companies.messages with the resolved identifier and the verbatim chat id", async () => {
    await runCompanyMessages(client as never, { id: "112013061", chatId: "2-abc", account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.companies.messages).toHaveBeenCalledWith("112013061", "2-abc", {});
  });

  it("--all streams NDJSON", async () => {
    (accountNs.companies.messages as Mock)
      .mockResolvedValueOnce({ items: [{ id: "1" }], cursor: "cur_1" })
      .mockResolvedValueOnce({ items: [{ id: "2" }], cursor: null });
    const out = makeOut();
    await runCompanyMessages(client as never, { id: "112013061", chatId: "2-abc", account: "acc_1", all: true } as Args, out);
    const lines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).filter((l) => l.trim().startsWith("{"));
    expect(lines).toHaveLength(2);
  });
});

describe("company message (single-message GET, distinct from company reply)", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;
  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.companies.message as Mock).mockResolvedValue({ id: "msg_1", text: "hello" });
  });
  afterEach(() => vi.restoreAllMocks());

  it("calls companies.message with the resolved identifier, chat id, and message id", async () => {
    await runCompanyMessage(
      client as never,
      { id: "112013061", chatId: "2-abc", messageId: "msg_1", account: "acc_1", json: true } as Args,
      makeOut(),
    );
    expect(accountNs.companies.message).toHaveBeenCalledWith("112013061", "2-abc", "msg_1");
  });

  it("--json prints the full response shape", async () => {
    const out = makeOut();
    await runCompanyMessage(
      client as never,
      { id: "112013061", chatId: "2-abc", messageId: "msg_1", account: "acc_1", json: true } as Args,
      out,
    );
    const written = JSON.parse((out.stdout.write as Mock).mock.calls[0]![0] as string);
    expect(written).toEqual({ id: "msg_1", text: "hello" });
  });

  it("--all → usage error exit 2 (not paginated)", async () => {
    expect(await exitCode(() => runCompanyMessage(
        client as never,
        { id: "112013061", chatId: "2-abc", messageId: "msg_1", account: "acc_1", all: true } as Args,
        makeOut(),
      ))).toBe(2);
  });
});

describe("company search-chats", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;
  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.companies.searchChats as Mock).mockResolvedValue({ items: [{ id: "2-abc" }], cursor: null });
  });
  afterEach(() => vi.restoreAllMocks());

  it("<query> maps to the query param", async () => {
    await runCompanySearchChats(
      client as never,
      { id: "112013061", query: "sophie", account: "acc_1", json: true } as Args,
      makeOut(),
    );
    expect(accountNs.companies.searchChats).toHaveBeenCalledWith("112013061", expect.objectContaining({ query: "sophie" }));
  });

  it("--topic maps to the topic param", async () => {
    await runCompanySearchChats(
      client as never,
      { id: "112013061", topic: "Support", account: "acc_1", json: true } as Args,
      makeOut(),
    );
    expect(accountNs.companies.searchChats).toHaveBeenCalledWith("112013061", expect.objectContaining({ topic: "Support" }));
  });

  it("--unread maps to the unread param", async () => {
    await runCompanySearchChats(
      client as never,
      { id: "112013061", unread: true, account: "acc_1", json: true } as Args,
      makeOut(),
    );
    expect(accountNs.companies.searchChats).toHaveBeenCalledWith("112013061", expect.objectContaining({ unread: true }));
  });

  it("--all streams NDJSON", async () => {
    (accountNs.companies.searchChats as Mock)
      .mockResolvedValueOnce({ items: [{ id: "1" }], cursor: "cur_1" })
      .mockResolvedValueOnce({ items: [{ id: "2" }], cursor: null });
    const out = makeOut();
    await runCompanySearchChats(client as never, { id: "112013061", query: "sophie", account: "acc_1", all: true } as Args, out);
    const lines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).filter((l) => l.trim().startsWith("{"));
    expect(lines).toHaveLength(2);
  });
});
