/**
 * Tests for the `inboxes` command group (Beta).
 *
 * Coverage:
 *   inboxes list                          → inboxes.list (flat, non-paginated: rejects --all)
 *   inboxes list --kind/--company-id       → filters forwarded to the SDK
 *   inboxes chats <inbox_id>               → inboxes.listChats (paginated: --all/--limit/--cursor)
 *
 * Distinct from the existing `inbox` command group (messaging.* alias) —
 * this one wraps the newer inbox-discovery resource.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { noConnectedAccounts } from "../helpers/no-connected-accounts.js";

function makeInboxesNs() {
  return {
    inboxes: {
      list: vi.fn(),
      listChats: vi.fn(),
    },
  };
}

function makeClient(ns: ReturnType<typeof makeInboxesNs>) {
  return {
    account: vi.fn().mockReturnValue(ns),
  };
}

type InboxesArgs = {
  inboxId?: string;
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
  kind?: string;
  "company-id"?: string;
};

describe("inboxes list", () => {
  let ns: ReturnType<typeof makeInboxesNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeInboxesNs();
    client = makeClient(ns);
    (ns.inboxes.list as Mock).mockResolvedValue({
      object: "inbox_list",
      items: [{ object: "inbox", id: "CLASSIC_PRIMARY", kind: "personal" }],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("inboxes list — calls inboxes.list with account, no filters by default", async () => {
    const { runInboxesList } = await import("../../src/commands/inboxes.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runInboxesList(client as never, { account: "acc_1", json: true } as InboxesArgs, out);

    expect(client.account).toHaveBeenCalledWith("acc_1");
    expect(ns.inboxes.list).toHaveBeenCalledWith({});
  });

  it("inboxes list --kind company --company-id 112013061 — forwards both filters", async () => {
    const { runInboxesList } = await import("../../src/commands/inboxes.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runInboxesList(
      client as never,
      { account: "acc_1", json: true, kind: "company", "company-id": "112013061" } as InboxesArgs,
      out,
    );

    expect(ns.inboxes.list).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "company", company_id: "112013061" }),
    );
  });

  it("inboxes list --all — usage error exit 2 (not paginated)", async () => {
    const { runInboxesList } = await import("../../src/commands/inboxes.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runInboxesList(client as never, { account: "acc_1", all: true } as InboxesArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("inboxes list --preview — usage error exit 2 (preview on read)", async () => {
    const { runInboxesList } = await import("../../src/commands/inboxes.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runInboxesList(client as never, { account: "acc_1", preview: true } as InboxesArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("inboxes list — missing account exits 2", async () => {
    const { runInboxesList } = await import("../../src/commands/inboxes.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runInboxesList(noConnectedAccounts(client) as never, { json: true } as InboxesArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("inboxes chats", () => {
  let ns: ReturnType<typeof makeInboxesNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ns = makeInboxesNs();
    client = makeClient(ns);
    (ns.inboxes.listChats as Mock).mockResolvedValue({ object: "inbox_chat_list", items: [], cursor: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("inboxes chats <inbox_id> — calls listChats with verbatim inbox id", async () => {
    const { runInboxesChats } = await import("../../src/commands/inboxes.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runInboxesChats(
      client as never,
      { inboxId: "COMPANY_83734124_PRIMARY", account: "acc_1", json: true } as InboxesArgs,
      out,
    );

    expect(ns.inboxes.listChats).toHaveBeenCalledWith("COMPANY_83734124_PRIMARY", {});
  });

  it("inboxes chats --limit 10 --cursor c1 — passes pagination params", async () => {
    const { runInboxesChats } = await import("../../src/commands/inboxes.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runInboxesChats(
      client as never,
      { inboxId: "CLASSIC_PRIMARY", account: "acc_1", json: true, limit: "10", cursor: "c1" } as InboxesArgs,
      out,
    );

    expect(ns.inboxes.listChats).toHaveBeenCalledWith(
      "CLASSIC_PRIMARY",
      expect.objectContaining({ limit: 10, cursor: "c1" }),
    );
  });

  it("inboxes chats --limit 40 — exits 2 with a clear range message before any SDK call (AX P1: qa finding)", async () => {
    const { runInboxesChats } = await import("../../src/commands/inboxes.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runInboxesChats(
        client as never,
        { inboxId: "CLASSIC_PRIMARY", account: "acc_1", limit: "40" } as InboxesArgs,
        out,
      );
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(ns.inboxes.listChats).not.toHaveBeenCalled();
    const stderrText = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    expect(stderrText).toContain("--limit must be between 1 and 25");
  });

  it("inboxes chats --limit 25 — the server maximum is accepted, no client-side rejection", async () => {
    const { runInboxesChats } = await import("../../src/commands/inboxes.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runInboxesChats(
      client as never,
      { inboxId: "CLASSIC_PRIMARY", account: "acc_1", limit: "25", json: true } as InboxesArgs,
      out,
    );

    expect(ns.inboxes.listChats).toHaveBeenCalledWith("CLASSIC_PRIMARY", expect.objectContaining({ limit: 25 }));
  });

  it("inboxes chats --all — streams NDJSON across pages", async () => {
    const { runInboxesChats } = await import("../../src/commands/inboxes.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    (ns.inboxes.listChats as Mock)
      .mockResolvedValueOnce({ items: [{ id: "c1" }, { id: "c2" }], cursor: "next" })
      .mockResolvedValueOnce({ items: [{ id: "c3" }], cursor: null });

    await runInboxesChats(
      client as never,
      { inboxId: "COMPANY_83734124_PRIMARY", account: "acc_1", all: true } as InboxesArgs,
      out,
    );

    const lines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string);
    const ndjson = lines.filter((l) => l.trim().startsWith("{"));
    expect(ndjson).toHaveLength(3);
  });

  it("inboxes chats --preview — usage error exit 2", async () => {
    const { runInboxesChats } = await import("../../src/commands/inboxes.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runInboxesChats(
        client as never,
        { inboxId: "CLASSIC_PRIMARY", account: "acc_1", preview: true } as InboxesArgs,
        out,
      );
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("inboxes chats — missing account exits 2", async () => {
    const { runInboxesChats } = await import("../../src/commands/inboxes.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runInboxesChats(noConnectedAccounts(client) as never, { inboxId: "CLASSIC_PRIMARY", json: true } as InboxesArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("a foreign inbox_id surfaces the SDK's 404 CurviateError as exit code 4", async () => {
    const { CurviateError } = await import("@curviate/sdk");
    const { runInboxesChats } = await import("../../src/commands/inboxes.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    (ns.inboxes.listChats as Mock).mockRejectedValue(
      new CurviateError({
        code: "RESOURCE_NOT_FOUND",
        message: "The referenced resource does not exist for this tenant.",
        httpStatus: 404,
        userFixable: true,
        retryLikelyToSucceed: false,
      }),
    );

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    try {
      await runInboxesChats(
        client as never,
        { inboxId: "BOGUS_ID", account: "acc_1", json: true } as InboxesArgs,
        out,
      );
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(4)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});
