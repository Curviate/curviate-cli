/**
 * `inbox` / `inboxes` run functions against a mock SDK client: request
 * building, chat-id normalization, --limit range, date filters, --all
 * streaming, exit codes; plus the `inbox search` 3-character floor and the
 * `--mode cache_only` walk hint through the real entry point / SDK client.
 * IDs (chat_id, inbox_id) pass through verbatim; thread URLs are normalized.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Curviate, CurviateError } from "@curviate/sdk";
import { noConnectedAccounts } from "../helpers/no-connected-accounts.js";
import { exitCode } from "../helpers/exit-code.js";
import { jsonLines, mkClient, mkOut, written } from "../helpers/f4-unit.js";
import { useSink } from "../helpers/sink.js";
import { inboxCommand, runInboxGet, runInboxList, runInboxMarkRead, runInboxMessages, runInboxSearch } from "../../src/commands/inbox.js";
import { runInboxesChats, runInboxesList } from "../../src/commands/inboxes.js";

type Fn = (client: never, args: never, out: never) => Promise<void>;
const page = (items: unknown[] = [], cursor: string | null = null) => ({ items, cursor });

let ns: ReturnType<typeof makeNs>;
let client: ReturnType<typeof mkClient>;
function makeNs() {
  return {
    messaging: {
      listChats: vi.fn().mockResolvedValue(page()),
      getChat: vi.fn().mockResolvedValue({ id: "chat_1" }),
      listMessages: vi.fn().mockResolvedValue(page()),
      searchChats: vi.fn().mockResolvedValue(page([{ id: "chat_1", name: "Sophie Keller" }])),
      markChatRead: vi.fn().mockResolvedValue({ object: "chat", unread_count: 0 }),
    },
    inboxes: { list: vi.fn().mockResolvedValue({ items: [] }), listChats: vi.fn().mockResolvedValue(page()) },
  };
}
beforeEach(() => {
  ns = makeNs();
  client = mkClient(ns);
});
afterEach(() => vi.restoreAllMocks());

async function call(fn: unknown, args: Record<string, unknown>, c: unknown = client) {
  const out = mkOut();
  await (fn as Fn)(c as never, { account: "acc_1", json: true, ...args } as never, out as never);
  return out;
}
const exits = (fn: unknown, args: Record<string, unknown>, c: unknown = client) => exitCode(() => call(fn, args, c));

describe("--limit is 1..25 on every paged inbox read; --all streams NDJSON", () => {
  const reads: Array<[string, unknown, Record<string, unknown>, () => ReturnType<typeof vi.fn>]> = [
    ["inbox list", runInboxList, {}, () => ns.messaging.listChats],
    ["inbox messages", runInboxMessages, { chatId: "chat_xyz" }, () => ns.messaging.listMessages],
    ["inbox search", runInboxSearch, { query: "sophie" }, () => ns.messaging.searchChats],
    ["inboxes chats", runInboxesChats, { inboxId: "COMPANY_83734124_PRIMARY" }, () => ns.inboxes.listChats],
  ];

  it.each(reads.filter(([n]) => n !== "inbox search"))("%s: --limit 40 and 0 exit 2 with the range message before any call", async (_n, fn, extra, spy) => {
    for (const limit of ["40", "0"]) {
      const out = mkOut();
      expect(await exitCode(() => (fn as Fn)(client as never, { account: "acc_1", ...extra, limit } as never, out as never))).toBe(2);
      expect(written(out.stderr)).toContain("--limit must be between 1 and 25");
      expect(spy()).not.toHaveBeenCalled();
    }
  });

  it.each(reads)("%s: --limit 25 / 5 and --cursor go through as an integer and verbatim", async (_n, fn, extra, spy) => {
    for (const limit of ["25", "5"]) await call(fn, { ...extra, limit, cursor: "c1" });
    expect(spy().mock.calls[0]!.at(-1)).toMatchObject({ limit: 25, cursor: "c1" });
    expect(spy().mock.calls[1]!.at(-1)).toMatchObject({ limit: 5, cursor: "c1" });
  });

  it.each(reads)("%s --all: pages are walked and every item is one NDJSON line", async (_n, fn, extra, spy) => {
    spy().mockResolvedValueOnce(page([{ id: "a" }, { id: "b" }], "next")).mockResolvedValueOnce(page([{ id: "c" }]));
    const out = await call(fn, { ...extra, all: true, "page-delay": "0", json: undefined });
    expect(jsonLines(out).map((o) => o["id"])).toEqual(["a", "b", "c"]);
    expect(spy()).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["inbox list", runInboxList, {}],
    ["inbox search", runInboxSearch, { query: "sophie" }],
    ["inboxes list", runInboxesList, {}],
    ["inboxes chats", runInboxesChats, { inboxId: "CLASSIC_PRIMARY" }],
    ["inbox mark-read", runInboxMarkRead, { chatId: "chat_1" }],
  ])("%s without any connected account exits 2", async (_n, fn, extra) => {
    expect(await exits(fn, { ...extra, account: undefined }, noConnectedAccounts(client))).toBe(2);
  });
});

describe("inbox list", () => {
  it("calls listChats for the account; unread is sent true / false and absent when unset", async () => {
    await call(runInboxList, { unread: true });
    await call(runInboxList, { unread: false });
    await call(runInboxList, {});
    expect(client.account).toHaveBeenCalledWith("acc_1");
    const calls = ns.messaging.listChats.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(calls[0]).toMatchObject({ unread: true });
    expect(calls[1]).toMatchObject({ unread: false });
    expect(calls[2]).not.toHaveProperty("unread");
  });

  it.each(["inmail", "primary", "archived", "spam", "jobs", "starred"])("--inbox %s is passed through; unset sends no inbox", async (folder) => {
    await call(runInboxList, { inbox: folder });
    await call(runInboxList, {});
    expect(ns.messaging.listChats.mock.calls[0]![0]).toMatchObject({ inbox: folder });
    expect(ns.messaging.listChats.mock.calls[1]![0]).not.toHaveProperty("inbox");
  });

  it("--inbox bogus exits 2 naming the accepted values; the folder rides every --all page", async () => {
    const out = mkOut();
    expect(await exitCode(() => runInboxList(client as never, { account: "acc_1", inbox: "bogus" } as never, out))).toBe(2);
    expect(written(out.stderr)).toContain("--inbox must be one of: primary, inmail, archived, spam, jobs, starred");
    expect(ns.messaging.listChats).not.toHaveBeenCalled();
    ns.messaging.listChats.mockResolvedValueOnce(page([{ id: "c1" }], "next")).mockResolvedValueOnce(page([{ id: "c2" }]));
    await call(runInboxList, { inbox: "inmail", all: true, "page-delay": "0", json: undefined });
    expect(ns.messaging.listChats.mock.calls.map((c) => (c[0] as Record<string, unknown>)["inbox"])).toEqual(["inmail", "inmail"]);
  });
});

describe("inbox get / messages: chat ids", () => {
  it.each([
    ["https://www.linkedin.com/messaging/thread/2-AbCd==", "2-AbCd=="],
    ["https://www.linkedin.com/messaging/thread/2-AbCd==/", "2-AbCd=="],
    ["https://www.linkedin.com/messaging/thread/2-AbCd==?overlayThreadListFilter=FOCUS_INBOX", "2-AbCd=="],
    ["2-AbCd==", "2-AbCd=="],
    ["chat_internal_123", "chat_internal_123"],
  ])("%s reaches getChat and listMessages as %s, with no other lookup", async (chatId, sent) => {
    await call(runInboxGet, { chatId });
    await call(runInboxMessages, { chatId });
    expect(ns.messaging.getChat).toHaveBeenCalledWith(sent, {});
    expect(ns.messaging.listMessages).toHaveBeenCalledWith(sent, expect.anything());
    expect(ns.messaging.getChat).toHaveBeenCalledTimes(1);
  });

  it("inbox get is not paginated (--all exits 2)", async () => {
    expect(await exits(runInboxGet, { chatId: "chat_abc", all: true })).toBe(2);
  });

  it("messages: --before / --after are passed (both, either) and absent when unset", async () => {
    const before = "2025-01-01T00:00:00Z";
    const after = "2024-12-01T00:00:00Z";
    await call(runInboxMessages, { chatId: "c", before, after });
    await call(runInboxMessages, { chatId: "c", before });
    await call(runInboxMessages, { chatId: "c", after });
    await call(runInboxMessages, { chatId: "c" });
    const q = ns.messaging.listMessages.mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(q[0]).toMatchObject({ before, after });
    expect(q[1]).toMatchObject({ before });
    expect(q[1]).not.toHaveProperty("after");
    expect(q[2]).toMatchObject({ after });
    expect(q[2]).not.toHaveProperty("before");
    expect(q[3]).not.toHaveProperty("before");
    expect(q[3]).not.toHaveProperty("after");
  });

  it.each([["before", "2025-01-01T00:00:00"], ["before", "not-a-date"], ["after", "2024-12-01"]])(
    "--%s %s exits 2 and sends nothing",
    async (flag, value) => {
      expect(await exits(runInboxMessages, { chatId: "chat_1", [flag]: value })).toBe(2);
      expect(ns.messaging.listMessages).not.toHaveBeenCalled();
    },
  );
});

describe("inbox search / inboxes", () => {
  it("search sends the query and prints the full result; a missing query exits 2 before any call", async () => {
    const out = await call(runInboxSearch, { query: "sophie keller" });
    expect(ns.messaging.searchChats).toHaveBeenCalledWith(expect.objectContaining({ query: "sophie keller" }));
    expect(JSON.parse(written(out.stdout))).toEqual(page([{ id: "chat_1", name: "Sophie Keller" }]));
    ns.messaging.searchChats.mockClear();
    expect(await exits(runInboxSearch, { query: undefined })).toBe(2);
    expect(ns.messaging.searchChats).not.toHaveBeenCalled();
  });

  it("inboxes list sends no filter by default and forwards --kind / --company-id; it is not paginated", async () => {
    await call(runInboxesList, {});
    await call(runInboxesList, { kind: "company", "company-id": "112013061" });
    expect(ns.inboxes.list.mock.calls[0]![0]).toEqual({});
    expect(ns.inboxes.list.mock.calls[1]![0]).toMatchObject({ kind: "company", company_id: "112013061" });
    expect(await exits(runInboxesList, { all: true })).toBe(2);
  });

  it("inboxes chats uses the inbox id verbatim; a foreign id's SDK 404 exits 4", async () => {
    await call(runInboxesChats, { inboxId: "COMPANY_83734124_PRIMARY" });
    expect(ns.inboxes.listChats).toHaveBeenCalledWith("COMPANY_83734124_PRIMARY", {});
    ns.inboxes.listChats.mockRejectedValue(new CurviateError({ code: "RESOURCE_NOT_FOUND", message: "m", httpStatus: 404, userFixable: true, retryLikelyToSucceed: false } as never));
    expect(await exits(runInboxesChats, { inboxId: "BOGUS_ID" })).toBe(4);
  });
});

describe("inbox mark-read", () => {
  it("sends { read: true } for the normalized chat id", async () => {
    await call(runInboxMarkRead, { chatId: "https://www.linkedin.com/messaging/thread/chat_9/" });
    expect(ns.messaging.markChatRead).toHaveBeenCalledWith("chat_9", { read: true });
  });

  it("--preview renders the request and calls nothing; an SDK NOT_FOUND exits 4", async () => {
    const out = await call(runInboxMarkRead, { chatId: "chat_1", preview: true });
    expect(ns.messaging.markChatRead).not.toHaveBeenCalled();
    expect(JSON.parse(written(out.stdout))).toMatchObject({ method: "messaging.markChatRead", body: { read: true } });
    ns.messaging.markChatRead.mockRejectedValue(new CurviateError({ code: "RESOURCE_NOT_FOUND", message: "no such chat", httpStatus: 404, userFixable: false, retryLikelyToSucceed: false } as never));
    expect(await exits(runInboxMarkRead, { chatId: "chat_x" })).toBe(4);
  });

  it("is registered as a write: no pagination flags, keeps --fields", () => {
    const args = (inboxCommand as unknown as { subCommands: Record<string, { args: Record<string, unknown> }> }).subCommands["mark-read"]!.args;
    for (const flag of ["limit", "cursor", "all", "max-pages"]) expect(args).not.toHaveProperty(flag);
    expect(args).toHaveProperty("fields");
  });
});

describe("inbox messages under --mode cache_only: exit 14 and the walk hint", () => {
  const NOT_STORED = { code: "NOT_STORED", message: "Nothing is stored.", user_fixable: true, retry_likely_to_succeed: false };
  const NOT_FOUND = { code: "RESOURCE_NOT_FOUND", message: "No such chat.", user_fixable: true, retry_likely_to_succeed: false };
  const answering = (status: number, body: unknown) =>
    new Curviate({
      apiKey: "cvt_live_test",
      baseUrl: "https://walk.curviate.test",
      timeout: 5_000,
      maxRetries: 1,
      fetch: (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch,
    });
  const drive = async (fn: unknown, c: Curviate, flags: Record<string, unknown> = {}) => {
    const out = mkOut();
    const code = await exitCode(() => (fn as Fn)(c as never, { account: "acc_01", chatId: "chat_1", json: true, mode: "cache_only", ...flags } as never, out as never));
    return { code, stderr: written(out.stderr) };
  };

  it("exit 14 prints the --all hint; a filtered or cursored read, another error, and inbox get print none", async () => {
    const hinted = await drive(runInboxMessages, answering(422, NOT_STORED));
    expect(hinted.code).toBe(14);
    expect(hinted.stderr).toMatch(/^error \[NOT_STORED\][^\n]*\nhint: [^\n]*--all[^\n]*\n$/);
    for (const flags of [{ before: "2026-01-01T00:00:00Z" }, { after: "2026-01-01T00:00:00Z" }, { cursor: "opaque" }]) {
      const r = await drive(runInboxMessages, answering(422, NOT_STORED), flags);
      expect([r.code, r.stderr.includes("hint: ")]).toEqual([14, false]);
    }
    const other = await drive(runInboxMessages, answering(404, NOT_FOUND));
    expect([other.code, other.stderr.includes("hint: ")]).toEqual([4, false]);
    const get = await drive(runInboxGet, answering(422, NOT_STORED));
    expect([get.code, get.stderr.includes("--all")]).toEqual([14, false]);
  });
});

describe("inbox search <query>: the 3-character floor is enforced before any request", () => {
  const sink = useSink((h) => ({ body: h.url.startsWith("/v1/accounts") ? { items: [{ account_id: "acc_01SEARCH", full_name: "Ada" }], cursor: null } : page() }));
  const search = (q: string) => sink.run(["inbox", "search", q, "--json"], { env: { CURVIATE_ACCOUNT: "acc_01SEARCH" } });

  it("1- and 2-character terms exit 2 naming the minimum with an empty request set; 3 characters reaches /chats/search", async () => {
    for (const q of ["a", "ab"]) {
      const r = await search(q);
      expect([r.status, r.requests]).toEqual([2, []]);
      expect(r.stderr).toContain("at least 3 characters");
    }
    const ok = await search("abc");
    expect(ok.status).toBe(0);
    expect(ok.requests.some((q) => q.url.includes("/chats/search"))).toBe(true);
  });
});
