/**
 * `curviate comment`, comment-thread operations.
 *
 * A dedicated, legible surface over the SDK `comments.*` namespace (plus
 * `posts.listComments` for reading a post's comment thread). It replaces the
 * earlier overloaded post-flag design with intent-shaped verbs.
 *
 * Subcommands:
 *   comment list <post_id>: list comments on a post (read)
 *   comment add <post_id> <text>: publish a comment (write)
 *   comment reply <post_id> <comment_id> <text>: reply to a comment (write)
 *   comment edit <post_id> <comment_id> <text>: edit own comment (write)
 *   comment delete <post_id> <comment_id>: delete own comment (write, bodyless)
 *   comment replies <post_id> <comment_id>: list replies to a comment (read)
 *   comment react <post_id> <comment_id> <reaction>: react to a comment (write)
 *   comment reactions <post_id> <comment_id>: list reactions on a comment (read)
 *   comment unreact <post_id> <comment_id> <reaction>: remove own reaction (write)
 *   comment user <user_id>: list a user's own comments (read)
 *
 * All subcommands are account-scoped. Read commands reject --preview (exit 2)
 * and support --all NDJSON streaming; write commands render --preview and never
 * touch the network under it. `add`/`reply` accept the TEXT positional or `-`
 * (stdin) and an optional --attach.
 *
 * `react`/`unreact` take a reaction from the unified lowercase enum:
 * like | celebrate | support | love | insightful | funny.
 * `unreact` is a DELETE-with-body, the reaction value travels in the JSON body.
 */

import { requireAccount } from "../lib/account-arg.js";
import { defineCommand } from "citty";
import { GLOBAL_FLAGS, WRITE_SINGLE_FLAGS } from "../lib/global-flags.js";
import { resolveMemberOrMeProviderId } from "../lib/member-id.js";
import { resolveEffectiveConfig } from "../lib/resolve.js";
import { createClient } from "../lib/client.js";
import { renderSuccess, renderError, renderUnexpectedError } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { streamAll, pageDelayFromFlags } from "../lib/paginate.js";
import { resolveTextOrStdin } from "../lib/stdin.js";
import { readAttachment, AttachError, toAttachmentPayload, describeAttachment } from "../lib/attach.js";
import type { Curviate, CurviateError } from "@curviate/sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CommentFlags = {
  postId?: string;
  commentId?: string;
  userId?: string;
  text?: string;
  reaction?: string;
  attach?: string | string[];
  account?: string;
  json?: boolean;
  fields?: string;
  limit?: string;
  cursor?: string;
  all?: boolean;
  "max-pages"?: string;
  "page-delay"?: string;
  preview?: boolean;
  "api-key"?: string;
  "base-url"?: string;
  timeout?: string;
  profile?: string;
  verbose?: boolean;
};

type OutputStreams = {
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
};

// Pagination-query shape shared by the comment list reads (limit + cursor).
type ListQuery = { limit?: number; cursor?: string };

// The unified lowercase reaction enum shared by post + comment reactions.
const REACTIONS = ["like", "celebrate", "support", "love", "insightful", "funny"] as const;
type Reaction = (typeof REACTIONS)[number];

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function buildOutputStreams(): OutputStreams {
  return {
    stdout: { write: (s: string) => process.stdout.write(s) },
    stderr: { write: (s: string) => process.stderr.write(s) },
  };
}

function rejectPreviewOnRead(preview: boolean | undefined, out: OutputStreams): void {
  if (preview) {
    out.stderr.write("error: --preview is only valid on write commands (mutations). Reads just run.\n");
    process.exit(2);
  }
}

function resolveOutputOpts(flags: CommentFlags) {
  return {
    json: (flags.json ?? false) || !process.stdout.isTTY,
    isTTY: process.stdout.isTTY ?? false,
    fields: flags.fields,
    verbose: flags.verbose ?? false,
  };
}

function buildListQuery(flags: CommentFlags): ListQuery {
  const params: ListQuery = {};
  if (flags.limit) params.limit = parseInt(flags.limit, 10);
  if (flags.cursor) params.cursor = flags.cursor;
  return params;
}

async function handleSdkError(
  err: unknown,
  outOpts: ReturnType<typeof resolveOutputOpts>,
  out: OutputStreams,
): Promise<never> {
  const { CurviateError } = await import("@curviate/sdk");
  if (err instanceof CurviateError) {
    const { getExitCode } = await import("../lib/exit-codes.js");
    renderError(err as CurviateError, outOpts, out);
    process.exit(getExitCode(err.code));
  }
  renderUnexpectedError(err, out);
  process.exit(1);
}

/** Normalize --attach to an array of paths. */
function normalizeAttachPaths(attach: string | string[] | undefined): string[] {
  if (!attach) return [];
  return Array.isArray(attach) ? attach : [attach];
}

function assertReaction(reaction: string, out: OutputStreams): asserts reaction is Reaction {
  if (!(REACTIONS as readonly string[]).includes(reaction)) {
    out.stderr.write(
      `error: reaction must be one of: ${REACTIONS.join(", ")}. Got "${reaction}".\n`,
    );
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Read run functions
// ---------------------------------------------------------------------------

/** Run `comment list <post_id>`, posts.listComments (paginated read). */
export async function runCommentList(client: Curviate, flags: CommentFlags, out: OutputStreams): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);
  const accountId = await requireAccount(client, flags.account, out);
  const postId = flags.postId ?? "";
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
  const params = buildListQuery(flags);

  try {
    if (all) {
      const fn = (p: ListQuery) => ns.posts.listComments(postId, p);
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.posts.listComments(postId, params);
      renderSuccess(result, outOpts, out);
    }
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/** Run `comment replies <post_id> <comment_id>`, comments.listReplies (paginated read). */
export async function runCommentReplies(client: Curviate, flags: CommentFlags, out: OutputStreams): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);
  const accountId = await requireAccount(client, flags.account, out);
  const postId = flags.postId ?? "";
  const commentId = flags.commentId ?? "";
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
  const params = buildListQuery(flags);

  try {
    if (all) {
      const fn = (p: ListQuery) => ns.comments.listReplies(postId, commentId, p);
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.comments.listReplies(postId, commentId, params);
      renderSuccess(result, outOpts, out);
    }
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/** Run `comment reactions <post_id> <comment_id>`, comments.listReactions (paginated read). */
export async function runCommentReactions(client: Curviate, flags: CommentFlags, out: OutputStreams): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);
  const accountId = await requireAccount(client, flags.account, out);
  const postId = flags.postId ?? "";
  const commentId = flags.commentId ?? "";
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
  const params = buildListQuery(flags);

  try {
    if (all) {
      const fn = (p: ListQuery) => ns.comments.listReactions(postId, commentId, p);
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.comments.listReactions(postId, commentId, params);
      renderSuccess(result, outOpts, out);
    }
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `comment user <user_id>`, comments.listUserComments (paginated read).
 * user_id is the "me" sentinel or a provider id, forwarded straight through;
 * a URL/slug 400s this endpoint (D7) and is first resolved to the provider
 * id via a users.get READ (contact-safe, notifies no one).
 */
export async function runCommentUser(client: Curviate, flags: CommentFlags, out: OutputStreams): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);
  const accountId = await requireAccount(client, flags.account, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  let userId: string;
  try {
    userId = await resolveMemberOrMeProviderId(ns, flags.userId ?? "");
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
    return; // unreachable: handleSdkError always exits
  }

  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
  const params = buildListQuery(flags);

  try {
    if (all) {
      const fn = (p: ListQuery) => ns.comments.listUserComments(userId, p);
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.comments.listUserComments(userId, params);
      renderSuccess(result, outOpts, out);
    }
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

// ---------------------------------------------------------------------------
// Write run functions
// ---------------------------------------------------------------------------

/**
 * Run `comment add <post_id> <text> [--attach <file>...]`, comments.create.
 * Write command, supports --preview. TEXT accepts `-` for stdin.
 */
export async function runCommentAdd(
  client: Curviate,
  flags: CommentFlags,
  out: OutputStreams,
  readStdin?: () => Promise<string>,
): Promise<void> {
  const accountId = await requireAccount(client, flags.account, out);
  const postId = flags.postId ?? "";
  const attachPaths = normalizeAttachPaths(flags.attach);

  let attachBuffers: Buffer[] = [];
  try {
    attachBuffers = await Promise.all(attachPaths.map((p) => readAttachment(p)));
  } catch (err: unknown) {
    if (err instanceof AttachError) {
      out.stderr.write(`error: ${err.message}\n`);
      process.exit(err.exitCode);
    }
    throw err;
  }

  const text = await resolveTextOrStdin(flags.text ?? "", out, readStdin);
  const attachmentPayloads = attachBuffers.map((buf, i) => toAttachmentPayload(attachPaths[i]!, buf));
  const body = {
    text,
    ...(attachmentPayloads.length > 0 ? { attachments: attachmentPayloads } : {}),
  };

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "comments.create",
      args: { post_id: postId },
      body: { text },
      account: accountId,
      attachments: attachBuffers.map((buf, i) => ({ name: describeAttachment(attachPaths[i]!, buf), buffer: buf })),
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  try {
    const result = await ns.comments.create(postId, body);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `comment reply <post_id> <comment_id> <text> [--attach <file>...]`, comments.reply.
 * Write command, supports --preview. TEXT accepts `-` for stdin.
 */
export async function runCommentReply(
  client: Curviate,
  flags: CommentFlags,
  out: OutputStreams,
  readStdin?: () => Promise<string>,
): Promise<void> {
  const accountId = await requireAccount(client, flags.account, out);
  const postId = flags.postId ?? "";
  const commentId = flags.commentId ?? "";
  const attachPaths = normalizeAttachPaths(flags.attach);

  let attachBuffers: Buffer[] = [];
  try {
    attachBuffers = await Promise.all(attachPaths.map((p) => readAttachment(p)));
  } catch (err: unknown) {
    if (err instanceof AttachError) {
      out.stderr.write(`error: ${err.message}\n`);
      process.exit(err.exitCode);
    }
    throw err;
  }

  const text = await resolveTextOrStdin(flags.text ?? "", out, readStdin);
  const attachmentPayloads = attachBuffers.map((buf, i) => toAttachmentPayload(attachPaths[i]!, buf));
  const body = {
    text,
    ...(attachmentPayloads.length > 0 ? { attachments: attachmentPayloads } : {}),
  };

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "comments.reply",
      args: { post_id: postId, comment_id: commentId },
      body: { text },
      account: accountId,
      attachments: attachBuffers.map((buf, i) => ({ name: describeAttachment(attachPaths[i]!, buf), buffer: buf })),
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  try {
    const result = await ns.comments.reply(postId, commentId, body);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `comment edit <post_id> <comment_id> <text>`, comments.edit.
 * Write command, supports --preview. TEXT accepts `-` for stdin.
 */
export async function runCommentEdit(
  client: Curviate,
  flags: CommentFlags,
  out: OutputStreams,
  readStdin?: () => Promise<string>,
): Promise<void> {
  const accountId = await requireAccount(client, flags.account, out);
  const postId = flags.postId ?? "";
  const commentId = flags.commentId ?? "";
  const text = await resolveTextOrStdin(flags.text ?? "", out, readStdin);
  const body = { text };

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "comments.edit",
      args: { post_id: postId, comment_id: commentId },
      body,
      account: accountId,
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  try {
    const result = await ns.comments.edit(postId, commentId, body);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `comment delete <post_id> <comment_id>`, comments.delete (bodyless, 204).
 * Write command, supports --preview.
 */
export async function runCommentDelete(client: Curviate, flags: CommentFlags, out: OutputStreams): Promise<void> {
  const accountId = await requireAccount(client, flags.account, out);
  const postId = flags.postId ?? "";
  const commentId = flags.commentId ?? "";

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "comments.delete",
      args: { post_id: postId, comment_id: commentId },
      body: {},
      account: accountId,
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  try {
    const result = await ns.comments.delete(postId, commentId);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `comment react <post_id> <comment_id> <reaction>`, comments.addReaction.
 * Write command, supports --preview.
 */
export async function runCommentReact(client: Curviate, flags: CommentFlags, out: OutputStreams): Promise<void> {
  const accountId = await requireAccount(client, flags.account, out);
  const postId = flags.postId ?? "";
  const commentId = flags.commentId ?? "";
  const reaction = flags.reaction ?? "";
  assertReaction(reaction, out);
  const body = { reaction };

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "comments.addReaction",
      args: { post_id: postId, comment_id: commentId },
      body,
      account: accountId,
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  try {
    const result = await ns.comments.addReaction(postId, commentId, body);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `comment unreact <post_id> <comment_id> <reaction>`, comments.removeReaction.
 * Write command, supports --preview. DELETE-with-body: the reaction value
 * travels in the JSON body, not the path.
 */
export async function runCommentUnreact(client: Curviate, flags: CommentFlags, out: OutputStreams): Promise<void> {
  const accountId = await requireAccount(client, flags.account, out);
  const postId = flags.postId ?? "";
  const commentId = flags.commentId ?? "";
  const reaction = flags.reaction ?? "";
  assertReaction(reaction, out);
  const body = { reaction };

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "comments.removeReaction",
      args: { post_id: postId, comment_id: commentId },
      body,
      account: accountId,
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  try {
    const result = await ns.comments.removeReaction(postId, commentId, body);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

// ---------------------------------------------------------------------------
// Citty command definitions
// ---------------------------------------------------------------------------

/** Build the config/client boilerplate shared by every subcommand's run(). */
async function withClient(
  flags: CommentFlags,
  fn: (client: Curviate, flags: CommentFlags, out: OutputStreams) => Promise<void>,
): Promise<void> {
  const cfg = await resolveEffectiveConfig({
    apiKey: flags["api-key"],
    baseUrl: flags["base-url"],
    timeout: flags.timeout,
    account: flags.account,
    profile: flags.profile,
  });
  if (!cfg.apiKey) {
    process.stderr.write("error: no API key, run `curviate login` or pass --api-key.\n");
    process.exit(3);
  }
  const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeout: cfg.timeout });
  const out = buildOutputStreams();
  await fn(client, { ...flags, account: flags.account ?? cfg.account }, out);
}

const commentListCommand = defineCommand({
  meta: { name: "list", description: "List the comments on a post. A very recent add/delete may take a few minutes to appear or clear here (LinkedIn-side indexing)." },
  args: {
    ...GLOBAL_FLAGS,
    postId: { type: "positional", description: "Post id (or share URN) to list comments for." },
  },
  async run({ args }) {
    await withClient(args as CommentFlags, runCommentList);
  },
});

const commentRepliesCommand = defineCommand({
  meta: { name: "replies", description: "List the replies to a comment." },
  args: {
    ...GLOBAL_FLAGS,
    postId: { type: "positional", description: "Post id the comment belongs to." },
    commentId: { type: "positional", description: "Comment id to list replies for." },
  },
  async run({ args }) {
    await withClient(args as CommentFlags, runCommentReplies);
  },
});

const commentReactionsCommand = defineCommand({
  meta: { name: "reactions", description: "List the reactions on a comment." },
  args: {
    ...GLOBAL_FLAGS,
    postId: { type: "positional", description: "Post id the comment belongs to." },
    commentId: { type: "positional", description: "Comment id to list reactions for." },
  },
  async run({ args }) {
    await withClient(args as CommentFlags, runCommentReactions);
  },
});

const commentUserCommand = defineCommand({
  meta: { name: "user", description: "List the comments authored by a user (accepts 'me')." },
  args: {
    ...GLOBAL_FLAGS,
    userId: { type: "positional", description: "Member identifier (URL, slug, provider id, or 'me')." },
  },
  async run({ args }) {
    await withClient(args as CommentFlags, runCommentUser);
  },
});

const commentAddCommand = defineCommand({
  meta: { name: "add", description: "Publish a comment on a post." },
  args: {
    ...WRITE_SINGLE_FLAGS,
    postId: { type: "positional", description: "Post id to comment on." },
    text: { type: "positional", stdinArg: true, description: "Comment text. Pass - to read from stdin." },
    attach: { type: "string", description: "Image file to attach (at most one)." },
  },
  async run({ args }) {
    await withClient(args as CommentFlags, (c, f, o) => runCommentAdd(c, f, o, undefined));
  },
});

const commentReplyCommand = defineCommand({
  meta: { name: "reply", description: "Reply to a comment." },
  args: {
    ...WRITE_SINGLE_FLAGS,
    postId: { type: "positional", description: "Post id the comment belongs to." },
    commentId: { type: "positional", description: "Comment id to reply to." },
    text: { type: "positional", stdinArg: true, description: "Reply text. Pass - to read from stdin." },
    attach: { type: "string", description: "Image file to attach (at most one)." },
  },
  async run({ args }) {
    await withClient(args as CommentFlags, (c, f, o) => runCommentReply(c, f, o, undefined));
  },
});

const commentEditCommand = defineCommand({
  meta: { name: "edit", description: "Edit your own comment." },
  args: {
    ...WRITE_SINGLE_FLAGS,
    postId: { type: "positional", description: "Post id the comment belongs to." },
    commentId: { type: "positional", description: "Comment id to edit." },
    text: { type: "positional", stdinArg: true, description: "Updated comment text. Pass - to read from stdin." },
  },
  async run({ args }) {
    await withClient(args as CommentFlags, (c, f, o) => runCommentEdit(c, f, o, undefined));
  },
});

const commentDeleteCommand = defineCommand({
  meta: { name: "delete", description: "Delete your own comment." },
  args: {
    ...WRITE_SINGLE_FLAGS,
    postId: { type: "positional", description: "Post id the comment belongs to." },
    commentId: { type: "positional", description: "Comment id to delete." },
  },
  async run({ args }) {
    await withClient(args as CommentFlags, runCommentDelete);
  },
});

const commentReactCommand = defineCommand({
  meta: { name: "react", description: "React to a comment (like|celebrate|support|love|insightful|funny)." },
  args: {
    ...WRITE_SINGLE_FLAGS,
    postId: { type: "positional", description: "Post id the comment belongs to." },
    commentId: { type: "positional", description: "Comment id to react to." },
    reaction: { type: "positional", description: "Reaction: like|celebrate|support|love|insightful|funny." },
  },
  async run({ args }) {
    await withClient(args as CommentFlags, runCommentReact);
  },
});

const commentUnreactCommand = defineCommand({
  meta: { name: "unreact", description: "Remove your reaction from a comment." },
  args: {
    ...WRITE_SINGLE_FLAGS,
    postId: { type: "positional", description: "Post id the comment belongs to." },
    commentId: { type: "positional", description: "Comment id to remove your reaction from." },
    reaction: { type: "positional", description: "Reaction to remove: like|celebrate|support|love|insightful|funny." },
  },
  async run({ args }) {
    await withClient(args as CommentFlags, runCommentUnreact);
  },
});

export const commentCommand = defineCommand({
  meta: { name: "comment", description: "Comment-thread operations (list, add, reply, edit, delete, react)." },
  args: { ...GLOBAL_FLAGS },
  subCommands: {
    list: commentListCommand,
    add: commentAddCommand,
    reply: commentReplyCommand,
    edit: commentEditCommand,
    delete: commentDeleteCommand,
    replies: commentRepliesCommand,
    react: commentReactCommand,
    reactions: commentReactionsCommand,
    unreact: commentUnreactCommand,
    user: commentUserCommand,
  },
  async run() {
    process.stderr.write(
      "Usage: curviate comment list <post_id>\n" +
      "       curviate comment add <post_id> <text> [--attach <file>]\n" +
      "       curviate comment reply <post_id> <comment_id> <text>\n" +
      "       curviate comment edit <post_id> <comment_id> <text>\n" +
      "       curviate comment delete <post_id> <comment_id>\n" +
      "       curviate comment replies <post_id> <comment_id>\n" +
      "       curviate comment react <post_id> <comment_id> <reaction>\n" +
      "       curviate comment reactions <post_id> <comment_id>\n" +
      "       curviate comment unreact <post_id> <comment_id> <reaction>\n" +
      "       curviate comment user <user_id>\n",
    );
  },
});
