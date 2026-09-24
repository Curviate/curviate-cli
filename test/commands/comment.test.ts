/**
 * Tests for the `comment` command group.
 *
 * The comment group is a dedicated, legible surface over the SDK `comments.*`
 * namespace (plus `posts.listComments` for reading a post's comment thread).
 * It replaces the earlier overloaded post-flag design.
 *
 * Coverage — assert the SDK method called + its exact args (the wire contract):
 *   comment list <post_id>                          → posts.listComments
 *   comment add <post_id> <text>                    → comments.create
 *   comment reply <post_id> <comment_id> <text>     → comments.reply
 *   comment edit <post_id> <comment_id> <text>      → comments.edit
 *   comment delete <post_id> <comment_id>           → comments.delete (bodyless)
 *   comment replies <post_id> <comment_id>          → comments.listReplies
 *   comment react <post_id> <comment_id> <reaction> → comments.addReaction
 *   comment reactions <post_id> <comment_id>        → comments.listReactions
 *   comment unreact <post_id> <comment_id> <r>      → comments.removeReaction (DELETE-with-body)
 *   comment user <user_id>                          → comments.listUserComments
 *
 * Read commands reject --preview (exit 2); write commands render --preview
 * hermetically (no SDK call). Missing --account is a usage error (exit 2).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { noConnectedAccounts } from "../helpers/no-connected-accounts.js";

function makeAccountNs() {
  return {
    posts: {
      listComments: vi.fn(),
    },
    comments: {
      create: vi.fn(),
      reply: vi.fn(),
      edit: vi.fn(),
      delete: vi.fn(),
      listReplies: vi.fn(),
      addReaction: vi.fn(),
      listReactions: vi.fn(),
      removeReaction: vi.fn(),
      listUserComments: vi.fn(),
    },
    users: {
      get: vi.fn(),
    },
  };
}

function makeClient(accountNs: ReturnType<typeof makeAccountNs>) {
  return {
    account: vi.fn().mockReturnValue(accountNs),
  };
}

function makeOut() {
  return {
    stdout: { write: vi.fn() },
    stderr: { write: vi.fn() },
  };
}

function mockExit() {
  return vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new Error(`process.exit(${code})`);
  });
}

const page = { object: "comment_list", items: [], cursor: null };
const created = { object: "comment", id: "cmt_1", text: "hi" };

type Args = Record<string, unknown>;

describe("comment reads — method + args", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.posts.listComments as Mock).mockResolvedValue(page);
    (accountNs.comments.listReplies as Mock).mockResolvedValue(page);
    (accountNs.comments.listReactions as Mock).mockResolvedValue(page);
    (accountNs.comments.listUserComments as Mock).mockResolvedValue(page);
  });

  afterEach(() => vi.restoreAllMocks());

  it("comment list <post_id> calls posts.listComments with the post id", async () => {
    const { runCommentList } = await import("../../src/commands/comment.js");
    await runCommentList(client as never, { postId: "p1", account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.posts.listComments).toHaveBeenCalledWith("p1", {});
  });

  it("comment list forwards --limit and --cursor as top-level query params", async () => {
    const { runCommentList } = await import("../../src/commands/comment.js");
    await runCommentList(
      client as never,
      { postId: "p1", account: "acc_1", json: true, limit: "5", cursor: "c9" } as Args,
      makeOut(),
    );
    expect(accountNs.posts.listComments).toHaveBeenCalledWith("p1", { limit: 5, cursor: "c9" });
  });

  it("comment replies calls comments.listReplies with post + comment ids", async () => {
    const { runCommentReplies } = await import("../../src/commands/comment.js");
    await runCommentReplies(
      client as never,
      { postId: "p1", commentId: "c1", account: "acc_1", json: true } as Args,
      makeOut(),
    );
    expect(accountNs.comments.listReplies).toHaveBeenCalledWith("p1", "c1", {});
  });

  it("comment reactions calls comments.listReactions with post + comment ids", async () => {
    const { runCommentReactions } = await import("../../src/commands/comment.js");
    await runCommentReactions(
      client as never,
      { postId: "p1", commentId: "c1", account: "acc_1", json: true } as Args,
      makeOut(),
    );
    expect(accountNs.comments.listReactions).toHaveBeenCalledWith("p1", "c1", {});
  });

  it("comment user <user_id> calls comments.listUserComments", async () => {
    const { runCommentUser } = await import("../../src/commands/comment.js");
    await runCommentUser(client as never, { userId: "me", account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.comments.listUserComments).toHaveBeenCalledWith("me", {});
    expect(accountNs.users.get).not.toHaveBeenCalled();
  });

  // D7: comment user 400s on a raw slug (only "me" + a provider id route) —
  // resolve a slug/URL to the provider id via a users.get READ first, same
  // pattern as the D6 follow/unfollow fix.

  it("comment user <slug> resolves the slug to a provider id via users.get, then lists (D7)", async () => {
    (accountNs.users.get as Mock).mockResolvedValue({ object: "user_profile", id: "ACoAA_resolved" });
    const { runCommentUser } = await import("../../src/commands/comment.js");
    await runCommentUser(client as never, { userId: "raphael-redmer", account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.users.get).toHaveBeenCalledWith("raphael-redmer", {});
    expect(accountNs.comments.listUserComments).toHaveBeenCalledWith("ACoAA_resolved", {});
  });

  it("comment user <provider_id> skips the resolve call (already a provider id) (D7)", async () => {
    const { runCommentUser } = await import("../../src/commands/comment.js");
    await runCommentUser(client as never, { userId: "ACoAAA_x", account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.users.get).not.toHaveBeenCalled();
    expect(accountNs.comments.listUserComments).toHaveBeenCalledWith("ACoAAA_x", {});
  });

  it("comment user <unresolvable-slug> surfaces users.get's 404 as exit 4, no list call (D7)", async () => {
    const { CurviateError } = await import("@curviate/sdk");
    const notFound = new CurviateError({
      code: "RESOURCE_NOT_FOUND",
      message: "Member not found.",
      httpStatus: 404,
      userFixable: false,
      retryLikelyToSucceed: false,
    });
    (accountNs.users.get as Mock).mockRejectedValue(notFound);
    const { runCommentUser } = await import("../../src/commands/comment.js");
    const exitSpy = mockExit();
    try {
      await runCommentUser(client as never, { userId: "no-such-member", account: "acc_1", json: true } as Args, makeOut());
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(4)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.comments.listUserComments).not.toHaveBeenCalled();
  });

  it("a read command without --account is a usage error (exit 2)", async () => {
    const { runCommentReplies } = await import("../../src/commands/comment.js");
    const exitSpy = mockExit();
    try {
      await runCommentReplies(noConnectedAccounts(client) as never, { postId: "p1", commentId: "c1" } as Args, makeOut());
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.comments.listReplies).not.toHaveBeenCalled();
  });
});

describe("comment writes — method + args", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.comments.create as Mock).mockResolvedValue(created);
    (accountNs.comments.reply as Mock).mockResolvedValue(created);
    (accountNs.comments.edit as Mock).mockResolvedValue(created);
    (accountNs.comments.delete as Mock).mockResolvedValue({});
    (accountNs.comments.addReaction as Mock).mockResolvedValue({ object: "reaction" });
    (accountNs.comments.removeReaction as Mock).mockResolvedValue({ object: "reaction" });
  });

  afterEach(() => vi.restoreAllMocks());

  it("comment add <post_id> <text> calls comments.create with a {text} body", async () => {
    const { runCommentAdd } = await import("../../src/commands/comment.js");
    await runCommentAdd(client as never, { postId: "p1", text: "hi", account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.comments.create).toHaveBeenCalledWith("p1", { text: "hi" });
  });

  it("comment reply calls comments.reply with post id, comment id, and {text}", async () => {
    const { runCommentReply } = await import("../../src/commands/comment.js");
    await runCommentReply(
      client as never,
      { postId: "p1", commentId: "c1", text: "yo", account: "acc_1", json: true } as Args,
      makeOut(),
    );
    expect(accountNs.comments.reply).toHaveBeenCalledWith("p1", "c1", { text: "yo" });
  });

  it("comment edit calls comments.edit with post id, comment id, and {text}", async () => {
    const { runCommentEdit } = await import("../../src/commands/comment.js");
    await runCommentEdit(
      client as never,
      { postId: "p1", commentId: "c1", text: "fixed", account: "acc_1", json: true } as Args,
      makeOut(),
    );
    expect(accountNs.comments.edit).toHaveBeenCalledWith("p1", "c1", { text: "fixed" });
  });

  it("comment delete calls comments.delete bodyless (no third argument)", async () => {
    const { runCommentDelete } = await import("../../src/commands/comment.js");
    await runCommentDelete(
      client as never,
      { postId: "p1", commentId: "c1", account: "acc_1", json: true } as Args,
      makeOut(),
    );
    expect(accountNs.comments.delete).toHaveBeenCalledWith("p1", "c1");
    expect((accountNs.comments.delete as Mock).mock.calls[0]).toHaveLength(2);
  });

  it("comment react calls comments.addReaction with a {reaction} body", async () => {
    const { runCommentReact } = await import("../../src/commands/comment.js");
    await runCommentReact(
      client as never,
      { postId: "p1", commentId: "c1", reaction: "like", account: "acc_1", json: true } as Args,
      makeOut(),
    );
    expect(accountNs.comments.addReaction).toHaveBeenCalledWith("p1", "c1", { reaction: "like" });
  });

  it("comment unreact calls comments.removeReaction with a {reaction} body (DELETE-with-body)", async () => {
    const { runCommentUnreact } = await import("../../src/commands/comment.js");
    await runCommentUnreact(
      client as never,
      { postId: "p1", commentId: "c1", reaction: "like", account: "acc_1", json: true } as Args,
      makeOut(),
    );
    expect(accountNs.comments.removeReaction).toHaveBeenCalledWith("p1", "c1", { reaction: "like" });
  });

  it("comment add --preview renders the request without calling the SDK", async () => {
    const { runCommentAdd } = await import("../../src/commands/comment.js");
    const out = makeOut();
    await runCommentAdd(
      client as never,
      { postId: "p1", text: "hi", account: "acc_1", preview: true, json: true } as Args,
      out,
    );
    expect(accountNs.comments.create).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const preview = JSON.parse(written) as { method: string; body: Record<string, unknown> };
    expect(preview.method).toBe("comments.create");
    expect(preview.body).toMatchObject({ text: "hi" });
  });

  it("comment react rejects a reaction outside the unified enum (exit 2, no SDK call)", async () => {
    const { runCommentReact } = await import("../../src/commands/comment.js");
    const exitSpy = mockExit();
    try {
      await runCommentReact(
        client as never,
        { postId: "p1", commentId: "c1", reaction: "thumbsup", account: "acc_1" } as Args,
        makeOut(),
      );
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.comments.addReaction).not.toHaveBeenCalled();
  });

  it("comment add reads the text from stdin when the positional is '-'", async () => {
    const { runCommentAdd } = await import("../../src/commands/comment.js");
    const readStdin = vi.fn().mockResolvedValue("from stdin");
    await runCommentAdd(
      client as never,
      { postId: "p1", text: "-", account: "acc_1", json: true } as Args,
      makeOut(),
      readStdin,
    );
    expect(readStdin).toHaveBeenCalled();
    expect(accountNs.comments.create).toHaveBeenCalledWith("p1", { text: "from stdin" });
  });
});

describe("comment writes — exit-code mapping", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
  });

  afterEach(() => vi.restoreAllMocks());

  it("a RESOURCE_NOT_FOUND from the SDK exits 4", async () => {
    const err = Object.assign(new Error("not found"), {
      code: "RESOURCE_NOT_FOUND",
      toJSON: () => ({ code: "RESOURCE_NOT_FOUND", message: "not found" }),
    });
    const { CurviateError } = await import("@curviate/sdk");
    Object.setPrototypeOf(err, CurviateError.prototype);
    (accountNs.comments.create as Mock).mockRejectedValue(err);

    const { runCommentAdd } = await import("../../src/commands/comment.js");
    const exitSpy = mockExit();
    try {
      await runCommentAdd(client as never, { postId: "p1", text: "hi", account: "acc_1", json: true } as Args, makeOut());
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(4)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("comment group — flag hygiene", () => {
  const PAGINATION_ONLY = ["limit", "cursor", "all", "max-pages"] as const;
  type CommandLike = { args?: Record<string, unknown>; subCommands?: Record<string, CommandLike> };

  async function subArgs(name: string): Promise<Record<string, unknown>> {
    const { commentCommand } = await import("../../src/commands/comment.js");
    const cmd = commentCommand as unknown as CommandLike;
    return (cmd.subCommands ?? {})[name]?.args ?? {};
  }

  it("write subcommands do not advertise pagination flags but keep --fields", async () => {
    for (const name of ["add", "reply", "edit", "delete", "react", "unreact"]) {
      const args = await subArgs(name);
      for (const flag of PAGINATION_ONLY) {
        expect(args, `comment ${name} must NOT include --${flag}`).not.toHaveProperty(flag);
      }
      expect(args, `comment ${name} keeps --fields`).toHaveProperty("fields");
    }
  });

  it("list subcommands advertise the pagination flags", async () => {
    for (const name of ["list", "replies", "reactions", "user"]) {
      const args = await subArgs(name);
      for (const flag of PAGINATION_ONLY) {
        expect(args, `comment ${name} includes --${flag}`).toHaveProperty(flag);
      }
    }
  });
});
