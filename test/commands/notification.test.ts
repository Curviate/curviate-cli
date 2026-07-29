/**
 * Tests for the new `notification` command group closing the SDK-parity gap
 * (#521).
 *
 *   notification list [--filter <f>]     → notifications.list(params) (paginated read)
 *   notification delete <card_urn>        → notifications.delete(cardUrn) (write)
 *   notification show-less <card_urn>     → notifications.showLess(cardUrn) (write)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

function makeAccountNs() {
  return {
    notifications: {
      list: vi.fn(),
      delete: vi.fn(),
      showLess: vi.fn(),
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

describe("notification list", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;
  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.notifications.list as Mock).mockResolvedValue({
      items: [{ card_urn: "urn:li:fsd_notificationCard:(1)", text: "New comment" }],
      cursor: null,
      unread_count: 3,
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("calls notifications.list with no params by default", async () => {
    const { runNotificationList } = await import("../../src/commands/notification.js");
    await runNotificationList(client as never, { account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.notifications.list).toHaveBeenCalledWith({});
  });

  it("--json prints the full response shape, including unread_count", async () => {
    const { runNotificationList } = await import("../../src/commands/notification.js");
    const out = makeOut();
    await runNotificationList(client as never, { account: "acc_1", json: true } as Args, out);
    const written = JSON.parse((out.stdout.write as Mock).mock.calls[0]![0] as string);
    expect(written.unread_count).toBe(3);
    expect(written.items[0]).toEqual({ card_urn: "urn:li:fsd_notificationCard:(1)", text: "New comment" });
  });

  it("--filter maps to the filter param", async () => {
    const { runNotificationList } = await import("../../src/commands/notification.js");
    await runNotificationList(client as never, { account: "acc_1", filter: "mentions", json: true } as Args, makeOut());
    expect(accountNs.notifications.list).toHaveBeenCalledWith(expect.objectContaining({ filter: "mentions" }));
  });

  it("--limit/--cursor pass through", async () => {
    const { runNotificationList } = await import("../../src/commands/notification.js");
    await runNotificationList(client as never, { account: "acc_1", limit: "10", cursor: "cur_1", json: true } as Args, makeOut());
    expect(accountNs.notifications.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 10, cursor: "cur_1" }));
  });

  it("--all streams NDJSON across pages", async () => {
    const { runNotificationList } = await import("../../src/commands/notification.js");
    (accountNs.notifications.list as Mock)
      .mockResolvedValueOnce({ items: [{ card_urn: "1" }], cursor: "cur_1" })
      .mockResolvedValueOnce({ items: [{ card_urn: "2" }], cursor: null });
    const out = makeOut();
    await runNotificationList(client as never, { account: "acc_1", all: true } as Args, out);
    const lines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).filter((l) => l.trim().startsWith("{"));
    expect(lines).toHaveLength(2);
  });

  it("--preview → usage error exit 2 (read command)", async () => {
    const { runNotificationList } = await import("../../src/commands/notification.js");
    const exitSpy = mockExit();
    try {
      await runNotificationList(client as never, { account: "acc_1", preview: true } as Args, makeOut());
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("missing account → exit 2", async () => {
    const { runNotificationList } = await import("../../src/commands/notification.js");
    const exitSpy = mockExit();
    try {
      await runNotificationList(client as never, { json: true } as Args, makeOut());
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("notification delete", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;
  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.notifications.delete as Mock).mockResolvedValue({ object: "notification_card_deleted", deleted: true });
  });
  afterEach(() => vi.restoreAllMocks());

  it("calls notifications.delete with the verbatim card urn, single argument", async () => {
    const { runNotificationDelete } = await import("../../src/commands/notification.js");
    await runNotificationDelete(
      client as never,
      { cardUrn: "urn:li:fsd_notificationCard:(1)", account: "acc_1", json: true } as Args,
      makeOut(),
    );
    expect(accountNs.notifications.delete).toHaveBeenCalledWith("urn:li:fsd_notificationCard:(1)");
    expect((accountNs.notifications.delete as Mock).mock.calls[0]).toHaveLength(1);
  });

  it("--json prints the write confirmation", async () => {
    const { runNotificationDelete } = await import("../../src/commands/notification.js");
    const out = makeOut();
    await runNotificationDelete(client as never, { cardUrn: "urn:li:fsd_notificationCard:(1)", account: "acc_1", json: true } as Args, out);
    const written = JSON.parse((out.stdout.write as Mock).mock.calls[0]![0] as string);
    expect(written).toEqual({ object: "notification_card_deleted", deleted: true });
  });

  it("--preview renders the request and makes no SDK call", async () => {
    const { runNotificationDelete } = await import("../../src/commands/notification.js");
    const out = makeOut();
    await runNotificationDelete(
      client as never,
      { cardUrn: "urn:li:fsd_notificationCard:(1)", account: "acc_1", preview: true, json: true } as Args,
      out,
    );
    expect(accountNs.notifications.delete).not.toHaveBeenCalled();
    const preview = JSON.parse((out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join(""));
    expect(preview.method).toBe("notifications.delete");
    expect(preview.args).toEqual({ card_urn: "urn:li:fsd_notificationCard:(1)" });
    expect(preview.body).toEqual({});
  });

  it("missing account → exit 2", async () => {
    const { runNotificationDelete } = await import("../../src/commands/notification.js");
    const exitSpy = mockExit();
    try {
      await runNotificationDelete(client as never, { cardUrn: "urn:li:fsd_notificationCard:(1)", json: true } as Args, makeOut());
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("notification show-less", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;
  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.notifications.showLess as Mock).mockResolvedValue({ object: "notification_card_deleted", deleted: true });
  });
  afterEach(() => vi.restoreAllMocks());

  it("calls notifications.showLess with the verbatim card urn, single argument", async () => {
    const { runNotificationShowLess } = await import("../../src/commands/notification.js");
    await runNotificationShowLess(
      client as never,
      { cardUrn: "urn:li:fsd_notificationCard:(1)", account: "acc_1", json: true } as Args,
      makeOut(),
    );
    expect(accountNs.notifications.showLess).toHaveBeenCalledWith("urn:li:fsd_notificationCard:(1)");
    expect((accountNs.notifications.showLess as Mock).mock.calls[0]).toHaveLength(1);
  });

  it("--json prints the write confirmation", async () => {
    const { runNotificationShowLess } = await import("../../src/commands/notification.js");
    const out = makeOut();
    await runNotificationShowLess(client as never, { cardUrn: "urn:li:fsd_notificationCard:(1)", account: "acc_1", json: true } as Args, out);
    const written = JSON.parse((out.stdout.write as Mock).mock.calls[0]![0] as string);
    expect(written).toEqual({ object: "notification_card_deleted", deleted: true });
  });

  it("--preview renders the request and makes no SDK call", async () => {
    const { runNotificationShowLess } = await import("../../src/commands/notification.js");
    const out = makeOut();
    await runNotificationShowLess(
      client as never,
      { cardUrn: "urn:li:fsd_notificationCard:(1)", account: "acc_1", preview: true, json: true } as Args,
      out,
    );
    expect(accountNs.notifications.showLess).not.toHaveBeenCalled();
    const preview = JSON.parse((out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join(""));
    expect(preview.method).toBe("notifications.showLess");
    expect(preview.args).toEqual({ card_urn: "urn:li:fsd_notificationCard:(1)" });
    expect(preview.body).toEqual({});
  });
});
