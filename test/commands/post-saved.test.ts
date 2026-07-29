/**
 * Tests for the new `post` saved-posts subcommands.
 *
 *   post saved            → posts.listSaved(params)     (paginated read)
 *   post save <post_id>   → posts.save(post_id)          (write)
 *   post unsave <post_id> → posts.unsave(post_id)        (write)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

function makeAccountNs() {
  return {
    posts: {
      listSaved: vi.fn(),
      save: vi.fn(),
      unsave: vi.fn(),
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

describe("post saved", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;
  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.posts.listSaved as Mock).mockResolvedValue({
      items: [{ id: "post_1", snippet: "A saved post" }],
      cursor: null,
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("calls posts.listSaved with the account and pagination params", async () => {
    const { runPostSaved } = await import("../../src/commands/post.js");
    await runPostSaved(client as never, { account: "acc_1", json: true } as Args, makeOut());
    expect(client.account).toHaveBeenCalledWith("acc_1");
    expect(accountNs.posts.listSaved).toHaveBeenCalled();
  });

  it("--json prints the full response shape", async () => {
    const { runPostSaved } = await import("../../src/commands/post.js");
    const out = makeOut();
    await runPostSaved(client as never, { account: "acc_1", json: true } as Args, out);
    const written = JSON.parse((out.stdout.write as Mock).mock.calls[0]![0] as string);
    expect(written).toEqual({ items: [{ id: "post_1", snippet: "A saved post" }], cursor: null });
  });

  it("--limit/--cursor pass through to the SDK call", async () => {
    const { runPostSaved } = await import("../../src/commands/post.js");
    await runPostSaved(client as never, { account: "acc_1", limit: "10", cursor: "cur_1", json: true } as Args, makeOut());
    expect(accountNs.posts.listSaved).toHaveBeenCalledWith(expect.objectContaining({ limit: 10, cursor: "cur_1" }));
  });

  it("--all streams NDJSON across pages", async () => {
    const { runPostSaved } = await import("../../src/commands/post.js");
    (accountNs.posts.listSaved as Mock)
      .mockResolvedValueOnce({ items: [{ id: "post_1" }], cursor: "cur_1" })
      .mockResolvedValueOnce({ items: [{ id: "post_2" }], cursor: null });
    const out = makeOut();
    await runPostSaved(client as never, { account: "acc_1", all: true } as Args, out);
    const lines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).filter((l) => l.trim().startsWith("{"));
    expect(lines).toHaveLength(2);
  });

  it("--preview → usage error exit 2 (read command)", async () => {
    const { runPostSaved } = await import("../../src/commands/post.js");
    const exitSpy = mockExit();
    try {
      await runPostSaved(client as never, { account: "acc_1", preview: true } as Args, makeOut());
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("missing account → exit 2", async () => {
    const { runPostSaved } = await import("../../src/commands/post.js");
    const exitSpy = mockExit();
    try {
      await runPostSaved(client as never, { json: true } as Args, makeOut());
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("post save", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;
  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.posts.save as Mock).mockResolvedValue({ object: "post_saved", saved: true });
  });
  afterEach(() => vi.restoreAllMocks());

  it("calls posts.save with the verbatim post id, single argument", async () => {
    const { runPostSave } = await import("../../src/commands/post.js");
    await runPostSave(client as never, { postId: "urn:li:activity:1", account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.posts.save).toHaveBeenCalledWith("urn:li:activity:1");
    expect((accountNs.posts.save as Mock).mock.calls[0]).toHaveLength(1);
  });

  it("--json prints the write confirmation", async () => {
    const { runPostSave } = await import("../../src/commands/post.js");
    const out = makeOut();
    await runPostSave(client as never, { postId: "1", account: "acc_1", json: true } as Args, out);
    const written = JSON.parse((out.stdout.write as Mock).mock.calls[0]![0] as string);
    expect(written).toEqual({ object: "post_saved", saved: true });
  });

  it("--preview renders the request and makes no SDK call", async () => {
    const { runPostSave } = await import("../../src/commands/post.js");
    const out = makeOut();
    await runPostSave(client as never, { postId: "p1", account: "acc_1", preview: true, json: true } as Args, out);
    expect(accountNs.posts.save).not.toHaveBeenCalled();
    const preview = JSON.parse((out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join(""));
    expect(preview.method).toBe("posts.save");
    expect(preview.args).toEqual({ post_id: "p1" });
    expect(preview.body).toEqual({});
  });

  it("missing post_id → still calls the SDK with an empty string (no client-side positional guard beyond citty)", async () => {
    // post_id is a required positional at the citty layer (exit 2 there);
    // the run function itself passes whatever it is given straight through.
    const { runPostSave } = await import("../../src/commands/post.js");
    await runPostSave(client as never, { account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.posts.save).toHaveBeenCalledWith("");
  });
});

describe("post unsave", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;
  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.posts.unsave as Mock).mockResolvedValue({ object: "post_saved", saved: false });
  });
  afterEach(() => vi.restoreAllMocks());

  it("calls posts.unsave with the verbatim post id, single argument", async () => {
    const { runPostUnsave } = await import("../../src/commands/post.js");
    await runPostUnsave(client as never, { postId: "urn:li:activity:1", account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.posts.unsave).toHaveBeenCalledWith("urn:li:activity:1");
    expect((accountNs.posts.unsave as Mock).mock.calls[0]).toHaveLength(1);
  });

  it("--json prints the write confirmation", async () => {
    const { runPostUnsave } = await import("../../src/commands/post.js");
    const out = makeOut();
    await runPostUnsave(client as never, { postId: "1", account: "acc_1", json: true } as Args, out);
    const written = JSON.parse((out.stdout.write as Mock).mock.calls[0]![0] as string);
    expect(written).toEqual({ object: "post_saved", saved: false });
  });

  it("--preview renders the request and makes no SDK call", async () => {
    const { runPostUnsave } = await import("../../src/commands/post.js");
    const out = makeOut();
    await runPostUnsave(client as never, { postId: "p1", account: "acc_1", preview: true, json: true } as Args, out);
    expect(accountNs.posts.unsave).not.toHaveBeenCalled();
    const preview = JSON.parse((out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join(""));
    expect(preview.method).toBe("posts.unsave");
    expect(preview.args).toEqual({ post_id: "p1" });
    expect(preview.body).toEqual({});
  });

  it("missing account → exit 2", async () => {
    const { runPostUnsave } = await import("../../src/commands/post.js");
    const exitSpy = mockExit();
    try {
      await runPostUnsave(client as never, { postId: "p1", json: true } as Args, makeOut());
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});
