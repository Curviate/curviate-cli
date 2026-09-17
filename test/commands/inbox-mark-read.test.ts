/**
 * Tests for `inbox mark-read <chat_id>` — messaging.markChatRead.
 * Assert the SDK method + exact args (the wire contract): the body is
 * { read: true }, and a thread URL is normalized to the bare chat id.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { noConnectedAccounts } from "../helpers/no-connected-accounts.js";

function makeAccountNs() {
  return {
    messaging: {
      markChatRead: vi.fn(),
    },
  };
}

function makeClient(accountNs: ReturnType<typeof makeAccountNs>) {
  return { account: vi.fn().mockReturnValue(accountNs) };
}

function makeOut() {
  return { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
}

function mockExit() {
  return vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new Error(`process.exit(${code})`);
  });
}

type Args = Record<string, unknown>;

describe("inbox mark-read", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;
  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.messaging.markChatRead as Mock).mockResolvedValue({ object: "chat", unread_count: 0 });
  });
  afterEach(() => vi.restoreAllMocks());

  it("calls messaging.markChatRead with the chat id and { read: true }", async () => {
    const { runInboxMarkRead } = await import("../../src/commands/inbox.js");
    await runInboxMarkRead(client as never, { chatId: "chat_1", account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.messaging.markChatRead).toHaveBeenCalledWith("chat_1", { read: true });
  });

  it("normalizes a thread URL to the bare chat id before the call", async () => {
    const { runInboxMarkRead } = await import("../../src/commands/inbox.js");
    await runInboxMarkRead(
      client as never,
      { chatId: "https://www.linkedin.com/messaging/thread/chat_9/", account: "acc_1", json: true } as Args,
      makeOut(),
    );
    const call = (accountNs.messaging.markChatRead as Mock).mock.calls[0]!;
    expect(call[0]).toBe("chat_9");
    expect(call[1]).toEqual({ read: true });
  });

  it("--preview renders the request without calling the SDK", async () => {
    const { runInboxMarkRead } = await import("../../src/commands/inbox.js");
    const out = makeOut();
    await runInboxMarkRead(client as never, { chatId: "chat_1", account: "acc_1", preview: true, json: true } as Args, out);
    expect(accountNs.messaging.markChatRead).not.toHaveBeenCalled();
    const preview = JSON.parse((out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join(""));
    expect(preview.method).toBe("messaging.markChatRead");
    expect(preview.body).toEqual({ read: true });
  });

  it("without --account exits 2 before any SDK call", async () => {
    const { runInboxMarkRead } = await import("../../src/commands/inbox.js");
    const exitSpy = mockExit();
    try {
      await runInboxMarkRead(noConnectedAccounts(client) as never, { chatId: "chat_1" } as Args, makeOut());
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.messaging.markChatRead).not.toHaveBeenCalled();
  });

  it("a NOT_FOUND from the SDK exits 4", async () => {
    const err = Object.assign(new Error("no such chat"), {
      code: "RESOURCE_NOT_FOUND",
      toJSON: () => ({ code: "RESOURCE_NOT_FOUND", message: "no such chat" }),
    });
    const { CurviateError } = await import("@curviate/sdk");
    Object.setPrototypeOf(err, CurviateError.prototype);
    (accountNs.messaging.markChatRead as Mock).mockRejectedValue(err);

    const { runInboxMarkRead } = await import("../../src/commands/inbox.js");
    const exitSpy = mockExit();
    try {
      await runInboxMarkRead(client as never, { chatId: "chat_x", account: "acc_1", json: true } as Args, makeOut());
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(4)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("inbox command surface", () => {
  type CommandLike = { subCommands?: Record<string, { args?: Record<string, unknown> }> };

  it("registers mark-read as a write (no pagination flags, keeps --fields)", async () => {
    const { inboxCommand } = await import("../../src/commands/inbox.js");
    const subs = (inboxCommand as unknown as CommandLike).subCommands ?? {};
    expect(subs).toHaveProperty("mark-read");
    const args = subs["mark-read"]?.args ?? {};
    for (const flag of ["limit", "cursor", "all", "max-pages"]) {
      expect(args, `inbox mark-read must NOT include --${flag}`).not.toHaveProperty(flag);
    }
    expect(args).toHaveProperty("fields");
  });
});
