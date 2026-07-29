/**
 * Tests for the new `profile` insight subcommands closing the SDK-parity gap
 * (#521): subscription / analytics / visitors / ssi — the account-scoped
 * `profile.*` namespace, distinct from the classic `users.*` namespace
 * `profile <id>`/`profile me`/`profile follow` etc. already wire.
 *
 *   profile subscription → profile.subscription()          (zero-arg read)
 *   profile analytics    → profile.analytics()              (zero-arg read)
 *   profile visitors     → profile.visitors(params)         (paginated read)
 *   profile ssi          → profile.ssi()                    (zero-arg read)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

function makeAccountNs() {
  return {
    profile: {
      subscription: vi.fn(),
      analytics: vi.fn(),
      visitors: vi.fn(),
      ssi: vi.fn(),
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

describe("profile subscription", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;
  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.profile.subscription as Mock).mockResolvedValue({ has_premium: false, plan_title: null, subscriptions: [] });
  });
  afterEach(() => vi.restoreAllMocks());

  it("calls profile.subscription with no arguments", async () => {
    const { runProfileSubscription } = await import("../../src/commands/profile.js");
    await runProfileSubscription(client as never, { account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.profile.subscription).toHaveBeenCalledWith();
  });

  it("--json prints the full response, including a free account's non-error result", async () => {
    const { runProfileSubscription } = await import("../../src/commands/profile.js");
    const out = makeOut();
    await runProfileSubscription(client as never, { account: "acc_1", json: true } as Args, out);
    const written = JSON.parse((out.stdout.write as Mock).mock.calls[0]![0] as string);
    expect(written).toEqual({ has_premium: false, plan_title: null, subscriptions: [] });
  });

  it("--all → usage error exit 2 (not paginated)", async () => {
    const { runProfileSubscription } = await import("../../src/commands/profile.js");
    const exitSpy = mockExit();
    try {
      await runProfileSubscription(client as never, { account: "acc_1", all: true } as Args, makeOut());
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("--preview → usage error exit 2 (read command)", async () => {
    const { runProfileSubscription } = await import("../../src/commands/profile.js");
    const exitSpy = mockExit();
    try {
      await runProfileSubscription(client as never, { account: "acc_1", preview: true } as Args, makeOut());
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("missing account → exit 2", async () => {
    const { runProfileSubscription } = await import("../../src/commands/profile.js");
    const exitSpy = mockExit();
    try {
      await runProfileSubscription(client as never, { json: true } as Args, makeOut());
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("profile analytics", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;
  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.profile.analytics as Mock).mockResolvedValue({
      profile_viewers: { count: 12 },
      followers: { count: 340 },
      post_impressions: { count: 0 },
      search_appearances: { count: null },
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("calls profile.analytics with no arguments", async () => {
    const { runProfileAnalytics } = await import("../../src/commands/profile.js");
    await runProfileAnalytics(client as never, { account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.profile.analytics).toHaveBeenCalledWith();
  });

  it("--json prints the full response, preserving a real zero vs a null unavailable card", async () => {
    const { runProfileAnalytics } = await import("../../src/commands/profile.js");
    const out = makeOut();
    await runProfileAnalytics(client as never, { account: "acc_1", json: true } as Args, out);
    const written = JSON.parse((out.stdout.write as Mock).mock.calls[0]![0] as string);
    expect(written.post_impressions.count).toBe(0);
    expect(written.search_appearances.count).toBeNull();
  });

  it("--all → usage error exit 2 (not paginated)", async () => {
    const { runProfileAnalytics } = await import("../../src/commands/profile.js");
    const exitSpy = mockExit();
    try {
      await runProfileAnalytics(client as never, { account: "acc_1", all: true } as Args, makeOut());
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("--preview → usage error exit 2 (read command)", async () => {
    const { runProfileAnalytics } = await import("../../src/commands/profile.js");
    const exitSpy = mockExit();
    try {
      await runProfileAnalytics(client as never, { account: "acc_1", preview: true } as Args, makeOut());
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("profile visitors", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;
  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.profile.visitors as Mock).mockResolvedValue({
      items: [{ kind: "identified", name: "Jane Doe" }],
      cursor: null,
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("calls profile.visitors with pagination params", async () => {
    const { runProfileVisitors } = await import("../../src/commands/profile.js");
    await runProfileVisitors(client as never, { account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.profile.visitors).toHaveBeenCalledWith({});
  });

  it("--json prints the full response shape", async () => {
    const { runProfileVisitors } = await import("../../src/commands/profile.js");
    const out = makeOut();
    await runProfileVisitors(client as never, { account: "acc_1", json: true } as Args, out);
    const written = JSON.parse((out.stdout.write as Mock).mock.calls[0]![0] as string);
    expect(written).toEqual({ items: [{ kind: "identified", name: "Jane Doe" }], cursor: null });
  });

  it("--limit/--cursor pass through", async () => {
    const { runProfileVisitors } = await import("../../src/commands/profile.js");
    await runProfileVisitors(client as never, { account: "acc_1", limit: "10", cursor: "cur_1", json: true } as Args, makeOut());
    expect(accountNs.profile.visitors).toHaveBeenCalledWith({ limit: 10, cursor: "cur_1" });
  });

  it("--all streams NDJSON across pages", async () => {
    const { runProfileVisitors } = await import("../../src/commands/profile.js");
    (accountNs.profile.visitors as Mock)
      .mockResolvedValueOnce({ items: [{ kind: "aggregate" }], cursor: "cur_1" })
      .mockResolvedValueOnce({ items: [{ kind: "identified" }], cursor: null });
    const out = makeOut();
    await runProfileVisitors(client as never, { account: "acc_1", all: true } as Args, out);
    const lines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).filter((l) => l.trim().startsWith("{"));
    expect(lines).toHaveLength(2);
  });

  it("--preview → usage error exit 2 (read command)", async () => {
    const { runProfileVisitors } = await import("../../src/commands/profile.js");
    const exitSpy = mockExit();
    try {
      await runProfileVisitors(client as never, { account: "acc_1", preview: true } as Args, makeOut());
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("profile ssi", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;
  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.profile.ssi as Mock).mockResolvedValue({ overall_score: 62.3, active_seat: true });
  });
  afterEach(() => vi.restoreAllMocks());

  it("calls profile.ssi with no arguments", async () => {
    const { runProfileSsi } = await import("../../src/commands/profile.js");
    await runProfileSsi(client as never, { account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.profile.ssi).toHaveBeenCalledWith();
  });

  it("--json prints the full float-precision score", async () => {
    const { runProfileSsi } = await import("../../src/commands/profile.js");
    const out = makeOut();
    await runProfileSsi(client as never, { account: "acc_1", json: true } as Args, out);
    const written = JSON.parse((out.stdout.write as Mock).mock.calls[0]![0] as string);
    expect(written).toEqual({ overall_score: 62.3, active_seat: true });
  });

  it("--all → usage error exit 2 (not paginated)", async () => {
    const { runProfileSsi } = await import("../../src/commands/profile.js");
    const exitSpy = mockExit();
    try {
      await runProfileSsi(client as never, { account: "acc_1", all: true } as Args, makeOut());
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("--preview → usage error exit 2 (read command)", async () => {
    const { runProfileSsi } = await import("../../src/commands/profile.js");
    const exitSpy = mockExit();
    try {
      await runProfileSsi(client as never, { account: "acc_1", preview: true } as Args, makeOut());
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});
