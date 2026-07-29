/**
 * Tests for the new `group` command group closing the SDK-parity gap (#521).
 *
 *   group list [--target <t>]        → groups.list(params)         (paginated read)
 *   group get <group_id>             → groups.get(group)           (single read)
 *   group members <group_id> [--name] → groups.members(group, params) (paginated read)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

function makeAccountNs() {
  return {
    groups: {
      list: vi.fn(),
      get: vi.fn(),
      members: vi.fn(),
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

describe("group list", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;
  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.groups.list as Mock).mockResolvedValue({
      object: "group_list",
      items: [{ object: "group", id: "9123014", name: "Alumni Network" }],
      cursor: null,
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("calls groups.list with no target by default (own groups)", async () => {
    const { runGroupList } = await import("../../src/commands/group.js");
    await runGroupList(client as never, { account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.groups.list).toHaveBeenCalledWith({});
  });

  it("--json prints the full response shape", async () => {
    const { runGroupList } = await import("../../src/commands/group.js");
    const out = makeOut();
    await runGroupList(client as never, { account: "acc_1", json: true } as Args, out);
    const written = JSON.parse((out.stdout.write as Mock).mock.calls[0]![0] as string);
    expect(written.items[0]).toEqual({ object: "group", id: "9123014", name: "Alumni Network" });
  });

  it("--target maps to the SDK's profile query param", async () => {
    const { runGroupList } = await import("../../src/commands/group.js");
    await runGroupList(client as never, { account: "acc_1", target: "raphael-redmer", json: true } as Args, makeOut());
    expect(accountNs.groups.list).toHaveBeenCalledWith(expect.objectContaining({ profile: "raphael-redmer" }));
  });

  it("--limit/--cursor pass through", async () => {
    const { runGroupList } = await import("../../src/commands/group.js");
    await runGroupList(client as never, { account: "acc_1", limit: "5", cursor: "cur_1", json: true } as Args, makeOut());
    expect(accountNs.groups.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 5, cursor: "cur_1" }));
  });

  it("--all streams NDJSON across pages", async () => {
    const { runGroupList } = await import("../../src/commands/group.js");
    (accountNs.groups.list as Mock)
      .mockResolvedValueOnce({ items: [{ id: "1" }], cursor: "cur_1" })
      .mockResolvedValueOnce({ items: [{ id: "2" }], cursor: null });
    const out = makeOut();
    await runGroupList(client as never, { account: "acc_1", all: true } as Args, out);
    const lines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).filter((l) => l.trim().startsWith("{"));
    expect(lines).toHaveLength(2);
  });

  it("--preview → usage error exit 2 (read command)", async () => {
    const { runGroupList } = await import("../../src/commands/group.js");
    const exitSpy = mockExit();
    try {
      await runGroupList(client as never, { account: "acc_1", preview: true } as Args, makeOut());
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("missing account → exit 2", async () => {
    const { runGroupList } = await import("../../src/commands/group.js");
    const exitSpy = mockExit();
    try {
      await runGroupList(client as never, { json: true } as Args, makeOut());
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("group get", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;
  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.groups.get as Mock).mockResolvedValue({ object: "group", id: "9123014", name: "Alumni Network" });
  });
  afterEach(() => vi.restoreAllMocks());

  it("calls groups.get with the verbatim group id", async () => {
    const { runGroupGet } = await import("../../src/commands/group.js");
    await runGroupGet(client as never, { groupId: "9123014", account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.groups.get).toHaveBeenCalledWith("9123014");
  });

  it("--json prints the full response shape", async () => {
    const { runGroupGet } = await import("../../src/commands/group.js");
    const out = makeOut();
    await runGroupGet(client as never, { groupId: "9123014", account: "acc_1", json: true } as Args, out);
    const written = JSON.parse((out.stdout.write as Mock).mock.calls[0]![0] as string);
    expect(written).toEqual({ object: "group", id: "9123014", name: "Alumni Network" });
  });

  it("--all → usage error exit 2 (not paginated)", async () => {
    const { runGroupGet } = await import("../../src/commands/group.js");
    const exitSpy = mockExit();
    try {
      await runGroupGet(client as never, { groupId: "9123014", account: "acc_1", all: true } as Args, makeOut());
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("--preview → usage error exit 2 (read command)", async () => {
    const { runGroupGet } = await import("../../src/commands/group.js");
    const exitSpy = mockExit();
    try {
      await runGroupGet(client as never, { groupId: "9123014", account: "acc_1", preview: true } as Args, makeOut());
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("group members", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;
  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.groups.members as Mock).mockResolvedValue({ items: [{ id: "ACoAA1", name: "Jane Doe" }], cursor: null });
  });
  afterEach(() => vi.restoreAllMocks());

  it("calls groups.members with the verbatim group id", async () => {
    const { runGroupMembers } = await import("../../src/commands/group.js");
    await runGroupMembers(client as never, { groupId: "9123014", account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.groups.members).toHaveBeenCalledWith("9123014", {});
  });

  it("--name maps to the name filter", async () => {
    const { runGroupMembers } = await import("../../src/commands/group.js");
    await runGroupMembers(client as never, { groupId: "9123014", name: "raphael red", account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.groups.members).toHaveBeenCalledWith("9123014", expect.objectContaining({ name: "raphael red" }));
  });

  it("--all streams NDJSON across pages", async () => {
    const { runGroupMembers } = await import("../../src/commands/group.js");
    (accountNs.groups.members as Mock)
      .mockResolvedValueOnce({ items: [{ id: "1" }], cursor: "cur_1" })
      .mockResolvedValueOnce({ items: [{ id: "2" }], cursor: null });
    const out = makeOut();
    await runGroupMembers(client as never, { groupId: "9123014", account: "acc_1", all: true } as Args, out);
    const lines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).filter((l) => l.trim().startsWith("{"));
    expect(lines).toHaveLength(2);
  });

  it("--preview → usage error exit 2 (read command)", async () => {
    const { runGroupMembers } = await import("../../src/commands/group.js");
    const exitSpy = mockExit();
    try {
      await runGroupMembers(client as never, { groupId: "9123014", account: "acc_1", preview: true } as Args, makeOut());
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});
