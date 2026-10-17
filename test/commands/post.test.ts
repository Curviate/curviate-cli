/**
 * `post` group (and the reaction-signature unification with `message react`):
 * flag -> SDK call, output, --preview, refusals. Run functions against mocks;
 * the argv forms go through the entry point against a recording sink.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CurviateError } from "@curviate/sdk";
import {
  postCommand, runPostCreate, runPostDelete, runPostGet, runPostReact, runPostReactions, runPostSave, runPostSaved,
  runPostUnreact, runPostUnsave, runPostUserPosts, runPostUserReactions,
} from "../../src/commands/post.js";
import { messageCommand, runMessageReact } from "../../src/commands/message.js";
import { inboxCommand } from "../../src/commands/inbox.js";
import { exitCode } from "../helpers/exit-code.js";
import { calls, go, mkEnv, mkOut, prints, previews, refuses, streams, text } from "../helpers/f3-unit.js";
import { useSink } from "../helpers/sink.js";

const PAGE = { object: "user_post_list", items: [], cursor: null };
const SHAPE = {
  posts: {
    get: { id: "post_1" },
    create: { post_id: "p_1" },
    react: { object: "reaction_added" },
    listReactions: { items: [], cursor: null },
    delete: {},
    unreact: { object: "reaction" },
    listUserPosts: PAGE,
    listUserReactions: PAGE,
    listSaved: { items: [{ id: "post_1", snippet: "A saved post" }], cursor: null },
    save: { object: "post_saved", saved: true },
    unsave: { object: "post_saved", saved: false },
  },
  users: { get: { object: "user_profile", id: "ACoAA_resolved" } },
  messaging: { addReaction: { object: "reaction_added" } },
};
const NOT_FOUND = new CurviateError({ code: "RESOURCE_NOT_FOUND", message: "Member not found.", httpStatus: 404, userFixable: false, retryLikelyToSucceed: false });

describe("post: request building", () => {
  calls(SHAPE, [
    ["get passes the id verbatim", runPostGet, { postId: "7332661864792854528" }, "posts.get", ["7332661864792854528"]],
    ["create sends the text", runPostCreate, { text: "Hello world" }, "posts.create", [expect.objectContaining({ text: "Hello world" })]],
    ["react sends {reaction}", runPostReact, { postId: "post_abc", reaction: "like" }, "posts.react", ["post_abc", { reaction: "like" }]],
    ["react --as-organization sends react_as", runPostReact, { postId: "p", reaction: "celebrate", "as-organization": "org_123" }, "posts.react", ["p", { reaction: "celebrate", react_as: "org_123" }]],
    ["react accepts support (valid write value)", runPostReact, { postId: "p", reaction: "support" }, "posts.react", ["p", { reaction: "support" }]],
    ["react: the deprecated --reaction alias is honored", runPostReact, { postId: "p1", reactionAlias: "celebrate" }, "posts.react", ["p1", { reaction: "celebrate" }]],
    ["react: the positional beats the alias", runPostReact, { postId: "p1", reaction: "love", reactionAlias: "funny" }, "posts.react", ["p1", { reaction: "love" }]],
    ["reactions", runPostReactions, { postId: "post_abc" }, "posts.listReactions", ["post_abc", expect.anything()]],
    ["delete is bodyless (one argument)", runPostDelete, { postId: "urn:li:activity:1" }, "posts.delete", ["urn:li:activity:1"]],
    ["unreact sends {reaction}", runPostUnreact, { postId: "p1", reaction: "like" }, "posts.unreact", ["p1", { reaction: "like" }]],
    ["user-posts: --limit is top-level", runPostUserPosts, { userId: "me", limit: "5" }, "posts.listUserPosts", ["me", { limit: 5 }]],
    ["user-reactions", runPostUserReactions, { userId: "me" }, "posts.listUserReactions", ["me", {}]],
    ["user-posts: a provider id skips the resolve", runPostUserPosts, { userId: "ACoAAA_x" }, "posts.listUserPosts", ["ACoAAA_x", {}]],
    ["user-posts: a slug is resolved via users.get first", runPostUserPosts, { userId: "raphael-redmer" }, "posts.listUserPosts", ["ACoAA_resolved", {}]],
    ["user-reactions: a slug is resolved via users.get first", runPostUserReactions, { userId: "raphael-redmer" }, "posts.listUserReactions", ["ACoAA_resolved", {}]],
    ["saved forwards --limit/--cursor", runPostSaved, { limit: "10", cursor: "cur_1" }, "posts.listSaved", [expect.objectContaining({ limit: 10, cursor: "cur_1" })]],
    ["save is one argument", runPostSave, { postId: "urn:li:activity:1" }, "posts.save", ["urn:li:activity:1"]],
    ["unsave is one argument", runPostUnsave, { postId: "urn:li:activity:1" }, "posts.unsave", ["urn:li:activity:1"]],
  ]);

  it("a slug is resolved with users.get({}) and a provider id or `me` is never resolved", async () => {
    const slug = await go(SHAPE, runPostUserPosts, { userId: "raphael-redmer" });
    expect(slug.fn("users.get")).toHaveBeenCalledWith("raphael-redmer", {});
    for (const userId of ["ACoAAA_x", "me"]) expect((await go(SHAPE, runPostUserPosts, { userId })).fn("users.get")).not.toHaveBeenCalled();
  });

  it("an unresolvable slug exits 4 and lists nothing", async () => {
    const e = mkEnv(SHAPE);
    e.fn("users.get").mockRejectedValue(NOT_FOUND);
    expect(await exitCode(() => runPostUserPosts(e.client as never, { userId: "no-such-member", account: "acc_1", json: true }, e.out as never))).toBe(4);
    expect(e.fn("posts.listUserPosts")).not.toHaveBeenCalled();
  });

  it("create --attach sends the file base64 in attachments (no multipart)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "curviate-test-post-"));
    try {
      const file = join(dir, "img.jpg");
      await writeFile(file, "jpgdata");
      const e = await go(SHAPE, runPostCreate, { text: "Post with image", attach: file });
      const sent = e.fn("posts.create").mock.calls[0]![0] as { attachments: unknown[] };
      expect(sent.attachments[0]).toEqual({ content: Buffer.from("jpgdata").toString("base64"), content_type: "image/jpeg", filename: "img.jpg" });
      const p = await go(SHAPE, runPostCreate, { text: "x", attach: file, preview: true });
      expect(JSON.parse(text(p.out)).attachments[0]).toMatch(/img\.jpg \(\d+ bytes\)/);
      expect(p.fn("posts.create")).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("post: output", () => {
  prints(SHAPE, [
    ["saved --json prints the response", runPostSaved, {}, "posts.listSaved"],
    ["save --json prints the confirmation", runPostSave, { postId: "1" }, "posts.save"],
    ["unsave --json prints the confirmation", runPostUnsave, { postId: "1" }, "posts.unsave"],
  ]);
  streams(SHAPE, [
    ["reactions", runPostReactions, { postId: "post_abc" }, "posts.listReactions"],
    ["saved", runPostSaved, {}, "posts.listSaved"],
  ]);
  previews(SHAPE, [
    ["create", runPostCreate, { text: "Preview only" }, "posts.create", {}],
    ["react --as-organization", runPostReact, { postId: "post_abc", reaction: "like", "as-organization": "org_xyz" }, "posts.react", { body: { react_as: "org_xyz" } }],
    ["delete", runPostDelete, { postId: "p1" }, "posts.delete", { body: {} }],
    ["save", runPostSave, { postId: "p1" }, "posts.save", { args: { post_id: "p1" }, body: {} }],
    ["unsave", runPostUnsave, { postId: "p1" }, "posts.unsave", { args: { post_id: "p1" }, body: {} }],
  ]);

  it("react with only the positional sends no react_as / comment_id", async () => {
    const e = await go(SHAPE, runPostReact, { postId: "post_1", reaction: "like" });
    expect(e.fn("posts.react").mock.calls[0]![1]).toEqual({ reaction: "like" });
  });
});

describe("post: refusals (exit code, no SDK call)", () => {
  refuses(SHAPE, [
    ["get --all (not paginated)", runPostGet, { postId: "post_1", all: true }, 2],
    ["create --attach <missing file>", runPostCreate, { text: "Post", attach: "/nonexistent/nope.jpg" }, 2],
    ["react LIKE (the write enum is lowercase)", runPostReact, { postId: "p", reaction: "LIKE" }, 2],
    ["react thumbsup", runPostReact, { postId: "p", reaction: "thumbsup" }, 2],
    ["react with no reaction at all", runPostReact, { postId: "p1" }, 2],
    ["unreact LIKE", runPostUnreact, { postId: "p1", reaction: "LIKE" }, 2],
    ["saved with no connected account", runPostSaved, { account: null }, 2],
    ["unsave with no connected account", runPostUnsave, { postId: "p1", account: null }, 2],
  ]);
});

describe("reaction signature: positional or alias, same preview body (through the entry point)", () => {
  const sink = useSink();
  it.each([
    [["post", "react", "post_1", "like"], "posts.react", { reaction: "like" }],
    [["post", "react", "post_1", "--reaction", "like"], "posts.react", { reaction: "like" }],
    [["message", "react", "chat_1", "msg_1", "👍"], "messaging.addReaction", { reaction: "👍" }],
    [["message", "react", "chat_1", "msg_1", "--emoji", "👍"], "messaging.addReaction", { reaction: "👍" }],
  ])("%j", async (argv, method, body) => {
    const r = await sink.run([...argv, "--preview", "--account", "acc_x"]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ method, body });
    expect(r.requests).toEqual([]);
  });

  it("an invalid positional reaction exits 2", async () => {
    expect((await sink.run(["post", "react", "post_1", "thumbsup", "--preview", "--account", "acc_x"])).status).toBe(2);
  });

  it("message react: positional and --emoji alias reach messaging.addReaction as {reaction}; none exits 2", async () => {
    const m = (a: object) => go(SHAPE, runMessageReact, { chatId: "c1", messageId: "m1", ...a });
    expect((await m({ emoji: "👍" })).fn("messaging.addReaction")).toHaveBeenCalledWith("c1", "m1", { reaction: "👍" });
    expect((await m({ emojiAlias: "🎉" })).fn("messaging.addReaction")).toHaveBeenCalledWith("c1", "m1", { reaction: "🎉" });
    const e = mkEnv(SHAPE);
    expect(await exitCode(() => runMessageReact(e.client as never, { chatId: "c1", messageId: "m1", account: "acc_1" }, mkOut() as never))).toBe(2);
    expect(e.fn("messaging.addReaction")).not.toHaveBeenCalled();
  });
});

describe("flag hygiene: no pagination flags where nothing paginates", () => {
  type Cmd = { args?: Record<string, unknown>; subCommands?: Record<string, Cmd> };
  const PAGING = ["limit", "cursor", "all", "max-pages"];
  const sub = (c: unknown, n: string | null) => (n === null ? (c as Cmd) : (c as Cmd).subCommands![n]!).args ?? {};
  const P = postCommand, M = messageCommand, I = inboxCommand;
  it.each([
    ["post create", P, "create", "write"], ["post react", P, "react", "write"],
    ["post delete", P, "delete", "write+fields"], ["post unreact", P, "unreact", "write+fields"],
    ["message new", M, "new", "write"], ["message edit", M, "edit", "write"], ["message delete", M, "delete", "write"],
    ["message react", M, "react", "write"], ["message inmail", M, "inmail", "write"], ["message <chat> <text>", M, null, "write"],
    ["message get", M, "get", "single"], ["message attachment", M, "attachment", "single"], ["message inmail-balance", M, "inmail-balance", "single"],
    ["inbox get", I, "get", "single"], ["inbox mark-read", I, "mark-read", "single"],
    ["post reactions", P, "reactions", "list"], ["inbox list", I, "list", "list"], ["inbox messages", I, "messages", "list"],
  ] as const)("%s (%s)", (_l, cmd, name, kind) => {
    const args = sub(cmd, name);
    for (const f of PAGING) (kind === "list" ? expect(args) : expect(args).not).toHaveProperty(f);
    if (kind === "write") expect(args).not.toHaveProperty("fields");
    if (kind === "write+fields") expect(args).toHaveProperty("fields");
  });
});
