/** `comment` group: flag -> SDK call (the wire contract), --preview, refusals, flag hygiene. */
import { describe, it, expect, vi } from "vitest";
import { CurviateError } from "@curviate/sdk";
import {
  commentCommand, runCommentAdd, runCommentDelete, runCommentEdit, runCommentList, runCommentReact, runCommentReactions,
  runCommentReplies, runCommentReply, runCommentUnreact, runCommentUser,
} from "../../src/commands/comment.js";
import { exitCode } from "../helpers/exit-code.js";
import { calls, go, mkEnv, previews, refuses, text } from "../helpers/f3-unit.js";

const PAGE = { object: "comment_list", items: [], cursor: null };
const CREATED = { object: "comment", id: "cmt_1", text: "hi" };
const SHAPE = {
  posts: { listComments: PAGE },
  comments: {
    create: CREATED, reply: CREATED, edit: CREATED, delete: {}, listReplies: PAGE, addReaction: { object: "reaction" },
    listReactions: PAGE, removeReaction: { object: "reaction" }, listUserComments: PAGE,
  },
  users: { get: { object: "user_profile", id: "ACoAA_resolved" } },
};
const ids = { postId: "p1", commentId: "c1" };
const notFound = (msg = "not found") => new CurviateError({ code: "RESOURCE_NOT_FOUND", message: msg, httpStatus: 404, userFixable: false, retryLikelyToSucceed: false });

describe("comment: request building", () => {
  calls(SHAPE, [
    ["list", runCommentList, { postId: "p1" }, "posts.listComments", ["p1", {}]],
    ["list forwards --limit/--cursor as top-level query params", runCommentList, { postId: "p1", limit: "5", cursor: "c9" }, "posts.listComments", ["p1", { limit: 5, cursor: "c9" }]],
    ["replies", runCommentReplies, ids, "comments.listReplies", ["p1", "c1", {}]],
    ["reactions", runCommentReactions, ids, "comments.listReactions", ["p1", "c1", {}]],
    ["user me is not resolved", runCommentUser, { userId: "me" }, "comments.listUserComments", ["me", {}]],
    ["user <provider id> is not resolved", runCommentUser, { userId: "ACoAAA_x" }, "comments.listUserComments", ["ACoAAA_x", {}]],
    ["user <slug> is resolved to a provider id first", runCommentUser, { userId: "raphael-redmer" }, "comments.listUserComments", ["ACoAA_resolved", {}]],
    ["add sends {text}", runCommentAdd, { postId: "p1", text: "hi" }, "comments.create", ["p1", { text: "hi" }]],
    ["reply sends post id, comment id, {text}", runCommentReply, { ...ids, text: "yo" }, "comments.reply", ["p1", "c1", { text: "yo" }]],
    ["edit sends post id, comment id, {text}", runCommentEdit, { ...ids, text: "fixed" }, "comments.edit", ["p1", "c1", { text: "fixed" }]],
    ["delete is bodyless (two arguments)", runCommentDelete, ids, "comments.delete", ["p1", "c1"]],
    ["react sends {reaction}", runCommentReact, { ...ids, reaction: "like" }, "comments.addReaction", ["p1", "c1", { reaction: "like" }]],
    ["unreact sends {reaction} (DELETE-with-body)", runCommentUnreact, { ...ids, reaction: "like" }, "comments.removeReaction", ["p1", "c1", { reaction: "like" }]],
  ]);

  it("user <slug> resolves with users.get({}); a provider id or `me` never does", async () => {
    expect((await go(SHAPE, runCommentUser, { userId: "raphael-redmer" })).fn("users.get")).toHaveBeenCalledWith("raphael-redmer", {});
    for (const userId of ["ACoAAA_x", "me"]) expect((await go(SHAPE, runCommentUser, { userId })).fn("users.get")).not.toHaveBeenCalled();
  });

  it("add reads the text from stdin when the positional is '-'", async () => {
    const readStdin = vi.fn().mockResolvedValue("from stdin");
    const e = await go(SHAPE, (c, a, o) => runCommentAdd(c, a, o, readStdin), { postId: "p1", text: "-" });
    expect(e.fn("comments.create")).toHaveBeenCalledWith("p1", { text: "from stdin" });
  });
});

describe("comment: output and exit codes", () => {
  it("delete prints {} when the SDK resolves undefined", async () => {
    const e = await go(SHAPE, runCommentDelete, ids, (x) => x.fn("comments.delete").mockResolvedValueOnce(undefined));
    expect(text(e.out)).toBe("{}\n");
  });

  it("an unresolvable slug exits 4 and lists nothing", async () => {
    const e = mkEnv(SHAPE);
    e.fn("users.get").mockRejectedValue(notFound("Member not found."));
    expect(await exitCode(() => runCommentUser(e.client as never, { userId: "no-such-member", account: "acc_1", json: true }, e.out as never))).toBe(4);
    expect(e.fn("comments.listUserComments")).not.toHaveBeenCalled();
  });

  it("a RESOURCE_NOT_FOUND from the SDK on a write exits 4", async () => {
    const e = mkEnv(SHAPE);
    e.fn("comments.create").mockRejectedValue(notFound());
    expect(await exitCode(() => runCommentAdd(e.client as never, { postId: "p1", text: "hi", account: "acc_1", json: true }, e.out as never))).toBe(4);
  });

  previews(SHAPE, [["add", runCommentAdd, { postId: "p1", text: "hi" }, "comments.create", { body: { text: "hi" } }]]);
  refuses(SHAPE, [
    ["a read without a connected account", runCommentReplies, { ...ids, account: null }, 2],
    ["react outside the unified enum", runCommentReact, { ...ids, reaction: "thumbsup" }, 2],
  ]);
});

describe("comment: flag hygiene", () => {
  type Cmd = { args?: Record<string, unknown>; subCommands?: Record<string, Cmd> };
  const args = (n: string) => (commentCommand as unknown as Cmd).subCommands![n]!.args ?? {};
  const PAGING = ["limit", "cursor", "all", "max-pages"];
  it.each(["add", "reply", "edit", "delete", "react", "unreact"])("%s: no pagination flags, keeps --fields", (n) => {
    for (const f of PAGING) expect(args(n)).not.toHaveProperty(f);
    expect(args(n)).toHaveProperty("fields");
  });
  it.each(["list", "replies", "reactions", "user"])("%s: has the pagination flags", (n) => {
    for (const f of PAGING) expect(args(n)).toHaveProperty(f);
  });
});
