/**
 * Tests for the `inbox` command group.
 *
 * Coverage:
 *   inbox list              → messaging.listChats (paginated: --all / --limit / --cursor)
 *   inbox list --unread     → messaging.listChats with unread filter (three-way: true/false/omit)
 *   inbox get <chat_id>     → messaging.getChat (not paginated, rejects --all, rejects --preview)
 *   inbox messages <chat_id>→ messaging.listMessages (paginated)
 *   inbox messages --before/--after → date filter with UTC/Z validation
 *
 * IDs (chat_id, message_id) pass through verbatim — NOT resolved via resolveIdentifier.
 * All subcommands are account-scoped (error exit 2 when no account).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

function makeMessagingNs() {
  return {
    messaging: {
      listChats: vi.fn(),
      getChat: vi.fn(),
      listMessages: vi.fn(),
      searchChats: vi.fn(),
    },
  };
}

function makeClient(ns: ReturnType<typeof makeMessagingNs>) {
  return {
    account: vi.fn().mockReturnValue(ns),
  };
}

type InboxArgs = {
  chatId?: string;
  account?: string;
  json?: boolean;
  fields?: string;
  limit?: string;
  cursor?: string;
  all?: boolean;
  "max-pages"?: string;
  preview?: boolean;
  "api-key"?: string;
  "base-url"?: string;
  timeout?: string;
  profile?: string;
  // Inbox list filter
  unread?: boolean;
  // Inbox messages date filters
  before?: string;
  after?: string;
  // Inbox sync-chat wait/polling
  wait?: boolean;
  // inbox search
  query?: string;
};

describe("inbox list", () => {
  let ns: ReturnType<typeof makeMessagingNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeMessagingNs();
    client = makeClient(ns);
    (ns.messaging.listChats as Mock).mockResolvedValue({ items: [], cursor: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("inbox list — calls messaging.listChats with account", async () => {
    const { runInboxList } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runInboxList(client as never, { account: "acc_1", json: true } as InboxArgs, out);

    expect(client.account).toHaveBeenCalledWith("acc_1");
    expect(ns.messaging.listChats).toHaveBeenCalled();
  });

  it("inbox list --limit 5 --cursor c1 — passes limit and cursor to SDK", async () => {
    const { runInboxList } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runInboxList(client as never, { account: "acc_1", json: true, limit: "5", cursor: "c1" } as InboxArgs, out);

    expect(ns.messaging.listChats).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5, cursor: "c1" }),
    );
  });

  it("inbox list --all — streams NDJSON across pages", async () => {
    const { runInboxList } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    (ns.messaging.listChats as Mock)
      .mockResolvedValueOnce({ items: [{ id: "c1" }, { id: "c2" }], cursor: "next" })
      .mockResolvedValueOnce({ items: [{ id: "c3" }], cursor: null });

    await runInboxList(client as never, { account: "acc_1", all: true } as InboxArgs, out);

    const lines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string);
    const ndjson = lines.filter((l) => l.trim().startsWith("{"));
    expect(ndjson).toHaveLength(3);
  });

  it("inbox list --preview — usage error exit 2 (preview on read)", async () => {
    const { runInboxList } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runInboxList(client as never, { account: "acc_1", preview: true } as InboxArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("inbox list — missing account exits 2", async () => {
    const { runInboxList } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runInboxList(client as never, { json: true } as InboxArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("inbox list --limit 40 — exits 2 with a clear range message before any SDK call (AX P1: qa finding)", async () => {
    const { runInboxList } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runInboxList(client as never, { account: "acc_1", limit: "40" } as InboxArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(ns.messaging.listChats).not.toHaveBeenCalled();
    const stderrText = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    expect(stderrText).toContain("--limit must be between 1 and 25");
  });

  it("inbox list --limit 0 — exits 2 (below the minimum)", async () => {
    const { runInboxList } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runInboxList(client as never, { account: "acc_1", limit: "0" } as InboxArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(ns.messaging.listChats).not.toHaveBeenCalled();
  });

  it("inbox list --limit 25 — the server maximum is accepted, no client-side rejection", async () => {
    const { runInboxList } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runInboxList(client as never, { account: "acc_1", limit: "25", json: true } as InboxArgs, out);

    expect(ns.messaging.listChats).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }));
  });
});

describe("inbox get", () => {
  let ns: ReturnType<typeof makeMessagingNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeMessagingNs();
    client = makeClient(ns);
    (ns.messaging.getChat as Mock).mockResolvedValue({ id: "chat_1" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("inbox get <chat_id> — calls getChat with verbatim id", async () => {
    const { runInboxGet } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runInboxGet(client as never, { chatId: "chat_abc", account: "acc_1", json: true } as InboxArgs, out);

    expect(ns.messaging.getChat).toHaveBeenCalledWith("chat_abc");
  });

  it("inbox get — rejects --preview (read command)", async () => {
    const { runInboxGet } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runInboxGet(client as never, { chatId: "chat_abc", account: "acc_1", preview: true } as InboxArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("inbox get — rejects --all (not paginated)", async () => {
    const { runInboxGet } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runInboxGet(client as never, { chatId: "chat_abc", account: "acc_1", all: true } as InboxArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("inbox messages", () => {
  let ns: ReturnType<typeof makeMessagingNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeMessagingNs();
    client = makeClient(ns);
    (ns.messaging.listMessages as Mock).mockResolvedValue({ items: [], cursor: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("inbox messages <chat_id> — calls listMessages with verbatim chat_id", async () => {
    const { runInboxMessages } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runInboxMessages(client as never, { chatId: "chat_xyz", account: "acc_1", json: true } as InboxArgs, out);

    expect(ns.messaging.listMessages).toHaveBeenCalledWith("chat_xyz", expect.anything());
  });

  it("inbox messages --limit 10 --cursor c2 — passes pagination params", async () => {
    const { runInboxMessages } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runInboxMessages(client as never, {
      chatId: "chat_xyz",
      account: "acc_1",
      json: true,
      limit: "10",
      cursor: "c2",
    } as InboxArgs, out);

    expect(ns.messaging.listMessages).toHaveBeenCalledWith(
      "chat_xyz",
      expect.objectContaining({ limit: 10, cursor: "c2" }),
    );
  });

  it("inbox messages --all — streams NDJSON", async () => {
    const { runInboxMessages } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    (ns.messaging.listMessages as Mock)
      .mockResolvedValueOnce({ items: [{ id: "m1" }], cursor: "next" })
      .mockResolvedValueOnce({ items: [{ id: "m2" }], cursor: null });

    await runInboxMessages(client as never, { chatId: "chat_xyz", account: "acc_1", all: true } as InboxArgs, out);

    const lines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string);
    const ndjson = lines.filter((l) => l.trim().startsWith("{"));
    expect(ndjson).toHaveLength(2);
  });

  it("inbox messages --preview — usage error exit 2", async () => {
    const { runInboxMessages } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runInboxMessages(client as never, { chatId: "chat_xyz", account: "acc_1", preview: true } as InboxArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("inbox messages --limit 40 — exits 2 with a clear range message before any SDK call (AX P1: qa finding)", async () => {
    const { runInboxMessages } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runInboxMessages(client as never, { chatId: "chat_xyz", account: "acc_1", limit: "40" } as InboxArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(ns.messaging.listMessages).not.toHaveBeenCalled();
    const stderrText = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    expect(stderrText).toContain("--limit must be between 1 and 25");
  });
});

// ---------------------------------------------------------------------------
// inbox list --unread filter (three-way: true / false / omit)
// ---------------------------------------------------------------------------

describe("inbox list unread filter", () => {
  let ns: ReturnType<typeof makeMessagingNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeMessagingNs();
    client = makeClient(ns);
    (ns.messaging.listChats as Mock).mockResolvedValue({ items: [], cursor: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("inbox list with unread flag passes unread true to the SDK", async () => {
    const { runInboxList } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runInboxList(
      client as never,
      { account: "acc_1", json: true, unread: true } as InboxArgs,
      out,
    );

    expect(ns.messaging.listChats).toHaveBeenCalledWith(
      expect.objectContaining({ unread: true }),
    );
  });

  it("inbox list with no-unread flag passes unread false to the SDK", async () => {
    const { runInboxList } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runInboxList(
      client as never,
      { account: "acc_1", json: true, unread: false } as InboxArgs,
      out,
    );

    expect(ns.messaging.listChats).toHaveBeenCalledWith(
      expect.objectContaining({ unread: false }),
    );
  });

  it("inbox list without the unread flag sends no unread parameter to the SDK", async () => {
    const { runInboxList } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runInboxList(
      client as never,
      { account: "acc_1", json: true } as InboxArgs,
      out,
    );

    const call = ((ns.messaging.listChats as Mock).mock.calls[0] as [Record<string, unknown>])[0];
    expect(call).not.toHaveProperty("unread");
  });
});

// ---------------------------------------------------------------------------
// inbox messages --before / --after date filters
// ---------------------------------------------------------------------------

describe("inbox messages date filters", () => {
  let ns: ReturnType<typeof makeMessagingNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeMessagingNs();
    client = makeClient(ns);
    (ns.messaging.listMessages as Mock).mockResolvedValue({ items: [], cursor: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("inbox messages with before flag passes the timestamp to the SDK", async () => {
    const { runInboxMessages } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runInboxMessages(
      client as never,
      { chatId: "chat_1", account: "acc_1", json: true, before: "2025-01-01T00:00:00Z" } as InboxArgs,
      out,
    );

    expect(ns.messaging.listMessages).toHaveBeenCalledWith(
      "chat_1",
      expect.objectContaining({ before: "2025-01-01T00:00:00Z" }),
    );
  });

  it("inbox messages with after flag passes the timestamp to the SDK", async () => {
    const { runInboxMessages } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runInboxMessages(
      client as never,
      { chatId: "chat_1", account: "acc_1", json: true, after: "2024-12-01T00:00:00Z" } as InboxArgs,
      out,
    );

    expect(ns.messaging.listMessages).toHaveBeenCalledWith(
      "chat_1",
      expect.objectContaining({ after: "2024-12-01T00:00:00Z" }),
    );
  });

  it("inbox messages with both before and after passes both timestamps to the SDK", async () => {
    const { runInboxMessages } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runInboxMessages(
      client as never,
      {
        chatId: "chat_1",
        account: "acc_1",
        json: true,
        before: "2025-01-01T00:00:00Z",
        after: "2024-12-01T00:00:00Z",
      } as InboxArgs,
      out,
    );

    expect(ns.messaging.listMessages).toHaveBeenCalledWith(
      "chat_1",
      expect.objectContaining({
        before: "2025-01-01T00:00:00Z",
        after: "2024-12-01T00:00:00Z",
      }),
    );
  });

  it("inbox messages without date flags sends no date parameters to the SDK", async () => {
    const { runInboxMessages } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runInboxMessages(
      client as never,
      { chatId: "chat_1", account: "acc_1", json: true } as InboxArgs,
      out,
    );

    const call = ((ns.messaging.listMessages as Mock).mock.calls[0] as [string, Record<string, unknown>])[1];
    expect(call).not.toHaveProperty("before");
    expect(call).not.toHaveProperty("after");
  });

  it("inbox messages with a before timestamp missing the Z suffix exits with code 2", async () => {
    const { runInboxMessages } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runInboxMessages(
        client as never,
        { chatId: "chat_1", account: "acc_1", json: true, before: "2025-01-01T00:00:00" } as InboxArgs,
        out,
      );
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
      expect(ns.messaging.listMessages).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("inbox messages with an unparseable before value exits with code 2", async () => {
    const { runInboxMessages } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runInboxMessages(
        client as never,
        { chatId: "chat_1", account: "acc_1", json: true, before: "not-a-date" } as InboxArgs,
        out,
      );
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
      expect(ns.messaging.listMessages).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("inbox messages with an after timestamp missing the Z suffix exits with code 2", async () => {
    const { runInboxMessages } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runInboxMessages(
        client as never,
        { chatId: "chat_1", account: "acc_1", json: true, after: "2024-12-01" } as InboxArgs,
        out,
      );
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
      expect(ns.messaging.listMessages).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// inbox search — messaging.searchChats
// ---------------------------------------------------------------------------

describe("inbox search", () => {
  let ns: ReturnType<typeof makeMessagingNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeMessagingNs();
    client = makeClient(ns);
    (ns.messaging.searchChats as Mock).mockResolvedValue({
      items: [{ id: "chat_1", name: "Sophie Keller" }],
      cursor: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("inbox search <query> — calls messaging.searchChats with the query and account", async () => {
    const { runInboxSearch } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runInboxSearch(client as never, { account: "acc_1", query: "sophie keller", json: true } as InboxArgs, out);

    expect(client.account).toHaveBeenCalledWith("acc_1");
    expect(ns.messaging.searchChats).toHaveBeenCalledWith(expect.objectContaining({ query: "sophie keller" }));
  });

  it("inbox search --json prints the full result shape", async () => {
    const { runInboxSearch } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runInboxSearch(client as never, { account: "acc_1", query: "sophie", json: true } as InboxArgs, out);

    const written = (out.stdout.write as Mock).mock.calls[0]![0] as string;
    expect(JSON.parse(written)).toEqual({ items: [{ id: "chat_1", name: "Sophie Keller" }], cursor: null });
  });

  it("inbox search — --limit/--cursor pass through to the SDK call", async () => {
    const { runInboxSearch } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runInboxSearch(
      client as never,
      { account: "acc_1", query: "sophie", limit: "10", cursor: "cur_1", json: true } as InboxArgs,
      out,
    );

    expect(ns.messaging.searchChats).toHaveBeenCalledWith(
      expect.objectContaining({ query: "sophie", limit: 10, cursor: "cur_1" }),
    );
  });

  it("inbox search --all — streams NDJSON across pages", async () => {
    const { runInboxSearch } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    (ns.messaging.searchChats as Mock)
      .mockResolvedValueOnce({ items: [{ id: "chat_1" }], cursor: "cur_1" })
      .mockResolvedValueOnce({ items: [{ id: "chat_2" }], cursor: null });

    await runInboxSearch(client as never, { account: "acc_1", query: "sophie", all: true } as InboxArgs, out);

    const lines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string);
    const ndjson = lines.filter((l) => l.trim().startsWith("{"));
    expect(ndjson).toHaveLength(2);
  });

  it("inbox search — missing <query> exits 2 before any SDK call", async () => {
    const { runInboxSearch } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runInboxSearch(client as never, { account: "acc_1" } as InboxArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(ns.messaging.searchChats).not.toHaveBeenCalled();
  });

  it("inbox search — missing account exits 2", async () => {
    const { runInboxSearch } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runInboxSearch(client as never, { query: "sophie", json: true } as InboxArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("inbox search --preview — usage error exit 2 (preview on read)", async () => {
    const { runInboxSearch } = await import("../../src/commands/inbox.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runInboxSearch(client as never, { account: "acc_1", query: "sophie", preview: true } as InboxArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});
