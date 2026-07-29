/**
 * Tests for the new `feed` command group closing the SDK-parity gap (#521).
 *
 *   feed home [--sort recent|relevant] [--limit] [--cursor] [--all] → feed.home(params)
 *
 * `feed home` is the only callable form (see the grammar note in
 * src/commands/feed.ts on why a bare `feed <value-flag>` is not wired).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { resolveLeaf } from "../../src/dispatch.js";
import { feedCommand } from "../../src/commands/feed.js";

function makeAccountNs() {
  return {
    feed: {
      home: vi.fn(),
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

describe("feed home", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;
  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.feed.home as Mock).mockResolvedValue({
      object: "feed",
      items: [{ activity_id: "1", author_name: "Jane Doe" }],
      cursor: null,
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("calls feed.home with no params by default", async () => {
    const { runFeedHome } = await import("../../src/commands/feed.js");
    await runFeedHome(client as never, { account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.feed.home).toHaveBeenCalledWith({});
  });

  it("--json prints the full response shape", async () => {
    const { runFeedHome } = await import("../../src/commands/feed.js");
    const out = makeOut();
    await runFeedHome(client as never, { account: "acc_1", json: true } as Args, out);
    const written = JSON.parse((out.stdout.write as Mock).mock.calls[0]![0] as string);
    expect(written.items[0]).toEqual({ activity_id: "1", author_name: "Jane Doe" });
  });

  it("--sort maps to the sort param", async () => {
    const { runFeedHome } = await import("../../src/commands/feed.js");
    await runFeedHome(client as never, { account: "acc_1", sort: "relevant", json: true } as Args, makeOut());
    expect(accountNs.feed.home).toHaveBeenCalledWith(expect.objectContaining({ sort: "relevant" }));
  });

  it("--limit/--cursor pass through", async () => {
    const { runFeedHome } = await import("../../src/commands/feed.js");
    await runFeedHome(client as never, { account: "acc_1", limit: "10", cursor: "cur_1", json: true } as Args, makeOut());
    expect(accountNs.feed.home).toHaveBeenCalledWith(expect.objectContaining({ limit: 10, cursor: "cur_1" }));
  });

  it("--all streams NDJSON across pages", async () => {
    const { runFeedHome } = await import("../../src/commands/feed.js");
    (accountNs.feed.home as Mock)
      .mockResolvedValueOnce({ items: [{ activity_id: "1" }], cursor: "cur_1" })
      .mockResolvedValueOnce({ items: [{ activity_id: "2" }], cursor: null });
    const out = makeOut();
    await runFeedHome(client as never, { account: "acc_1", all: true } as Args, out);
    const lines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).filter((l) => l.trim().startsWith("{"));
    expect(lines).toHaveLength(2);
  });

  it("--preview → usage error exit 2 (read command)", async () => {
    const { runFeedHome } = await import("../../src/commands/feed.js");
    const exitSpy = mockExit();
    try {
      await runFeedHome(client as never, { account: "acc_1", preview: true } as Args, makeOut());
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("missing account → exit 2", async () => {
    const { runFeedHome } = await import("../../src/commands/feed.js");
    const exitSpy = mockExit();
    try {
      await runFeedHome(client as never, { json: true } as Args, makeOut());
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("feed dispatch routing", () => {
  afterEach(() => vi.restoreAllMocks());

  it("`feed home --sort relevant` resolves to the home subcommand", async () => {
    const { leaf, leafArgs } = await resolveLeaf(feedCommand as never, ["home", "--sort", "relevant"]);
    expect(leaf).toBeDefined();
    expect(leafArgs).toEqual(["--sort", "relevant"]);
  });

  it("bare `feed` (no args) resolves to the group's own usage-printing run()", async () => {
    const { leaf, leafArgs } = await resolveLeaf(feedCommand as never, []);
    expect(leaf).toBeDefined();
    expect(leafArgs).toEqual([]);
  });
});
