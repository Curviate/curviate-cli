/**
 * `curviate post`, LinkedIn post operations.
 *
 * Subcommands:
 *   post get <post_id>: get a single post (read)
 *   post create "<text>" [--attach <file>...]: create post (write, JSON only in v2)
 *   post react <post_id> <reaction>: react to post (write, body field: reaction; --reaction alias)
 *   post reactions <post_id>: list reactions (paginated, read)
 *   post delete <post_id>: delete a post you own (write)
 *   post unreact <post_id> <reaction>: remove your reaction (write)
 *   post saved: list your saved posts (paginated, read)
 *   post save <post_id>: save a post to your bookmark list (write)
 *   post unsave <post_id>: remove a post from your bookmark list (write)
 *   post user-posts <user_id>: list a member's own posts (read)
 *   post user-reactions <user_id>: list a member's own reactions (read)
 *
 * Comment operations moved to the dedicated `comment` command group.
 * post_id passes through verbatim, NOT resolved via resolveIdentifier.
 * All subcommands are account-scoped.
 *
 * v2: posts.create/posts.react are re-pointed here, --video-thumbnail
 * has no v2 home (dropped, same class as profile's --notify) and attachments
 * are base64 JSON objects, not multipart. --comment-id on `post react` is
 * also dropped: comment-level reactions moved to the comments.* group
 * (comment-id has no home on posts.react's v2 body); --as-organization now
 * maps to the renamed `react_as` body field.
 */

import { defineCommand } from "citty";
import { GLOBAL_FLAGS, WRITE_FLAGS, WRITE_SINGLE_FLAGS } from "../lib/global-flags.js";
import { resolveMemberOrMeProviderId } from "../lib/member-id.js";
import { resolveTextOrStdin } from "../lib/stdin.js";
import { resolveEffectiveConfig } from "../lib/resolve.js";
import { createClient } from "../lib/client.js";
import { renderSuccess, renderError, renderUnexpectedError } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { streamAll, pageDelayFromFlags } from "../lib/paginate.js";
import { readAttachment, AttachError, toAttachmentPayload } from "../lib/attach.js";
import type { Curviate, CurviateError } from "@curviate/sdk";

// ---------------------------------------------------------------------------
// Valid write-side reaction values.
// Write values are ALWAYS lowercase. Uppercase read-side values (LIKE, PRAISE ...)
// surface in responses as `value` (reactions list items) and `user_reacted` (post get),
// they are NOT accepted as write values here.
// ---------------------------------------------------------------------------
const VALID_REACTIONS = new Set(["like", "celebrate", "support", "love", "insightful", "funny"]);

type PostFlags = {
  postId?: string;
  userId?: string;
  text?: string;
  reaction?: string;
  /** Deprecated alias for the positional <reaction> (the old `--reaction` flag). */
  reactionAlias?: string;
  "reply-to"?: string;
  "as-organization"?: string;
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
};

type OutputStreams = {
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
};

function buildOutputStreams(): OutputStreams {
  return {
    stdout: { write: (s: string) => process.stdout.write(s) },
    stderr: { write: (s: string) => process.stderr.write(s) },
  };
}

function requireAccount(account: string | undefined, out: OutputStreams): string {
  if (!account) {
    out.stderr.write("error: --account is required for this command. Set it via --account, CURVIATE_ACCOUNT, or `curviate config set-account`.\n");
    process.exit(2);
  }
  return account;
}

function rejectPreviewOnRead(preview: boolean | undefined, out: OutputStreams): void {
  if (preview) {
    out.stderr.write("error: --preview is only valid on write commands (mutations). Reads just run.\n");
    process.exit(2);
  }
}

function rejectAllOnNonPaginated(all: boolean | undefined, out: OutputStreams): void {
  if (all) {
    out.stderr.write("error: --all is not supported on non-paginated commands.\n");
    process.exit(2);
  }
}

function resolveOutputOpts(flags: PostFlags) {
  return {
    json: (flags.json ?? false) || !process.stdout.isTTY,
    isTTY: process.stdout.isTTY ?? false,
    fields: flags.fields,
  };
}

function buildPaginationParams(flags: PostFlags): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (flags.limit !== undefined) params["limit"] = parseInt(flags.limit, 10);
  if (flags.cursor) params["cursor"] = flags.cursor;
  return params;
}

/** Normalize --attach flag to an array of paths. */
function normalizeAttachPaths(attach: string | string[] | undefined): string[] {
  if (!attach) return [];
  return Array.isArray(attach) ? attach : [attach];
}

async function handleSdkError(err: unknown, outOpts: ReturnType<typeof resolveOutputOpts>, out: OutputStreams): Promise<never> {
  const { CurviateError } = await import("@curviate/sdk");
  if (err instanceof CurviateError) {
    const { getExitCode } = await import("../lib/exit-codes.js");
    renderError(err as CurviateError, outOpts, out);
    process.exit(getExitCode(err.code));
  }
  renderUnexpectedError(err, out);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Exported run functions (testable without citty)
// ---------------------------------------------------------------------------

/**
 * Run `post get <post_id>`.
 * Read command, rejects --preview and --all.
 */
export async function runPostGet(
  client: Curviate,
  flags: PostFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);
  rejectAllOnNonPaginated(flags.all, out);

  const accountId = requireAccount(flags.account, out);
  const postId = flags.postId ?? "";
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.posts.get(postId);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `post create "<text>" [--attach <file>...]`.
 * Write command, supports --preview.
 *
 * v2: pure application/json, no multipart op on the served surface, and no
 * `video_thumbnail` field (--video-thumbnail has no v2 home and is dropped,
 * same class of removal as profile's --notify). Attachments (images, a
 * single PDF for a document post, etc.) travel as base64
 * {content,content_type,filename} objects; multiple entries produce a
 * carousel.
 */
export async function runPostCreate(
  client: Curviate,
  flags: PostFlags,
  out: OutputStreams,
  _readStdin?: () => Promise<string>,
): Promise<void> {
  const accountId = requireAccount(flags.account, out);
  const rawText = flags.text ?? "";
  const attachPaths = normalizeAttachPaths(flags.attach);

  // Resolve stdin sentinel: "-" reads all of stdin.
  const text = await resolveTextOrStdin(rawText, out, _readStdin);

  // Load attachments before any preview or SDK call.
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

  if (flags.preview) {
    const allAttachmentPreviews = attachBuffers.map((buf, i) => ({
      name: attachPaths[i] ? attachPaths[i].split("/").pop() ?? attachPaths[i] : `attachment_${i}`,
      buffer: buf,
    }));
    const preview = buildPreviewOutput({
      method: "posts.create",
      args: {},
      body: { text },
      account: accountId,
      attachments: allAttachmentPreviews,
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const attachmentPayloads = attachBuffers.map((buf, i) => toAttachmentPayload(attachPaths[i]!, buf));
  const body = {
    text,
    ...(attachmentPayloads.length > 0 ? { attachments: attachmentPayloads } : {}),
  };

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.posts.create(body);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `post react <post_id> <reaction> [--as-organization <org>]`.
 * Write command, supports --preview.
 * <reaction>: the canonical positional (the deprecated `--reaction` flag still
 * works as an alias); validated against the write-side enum (lowercase only).
 * --as-organization: reacts on behalf of an organization page (v2 body
 * field: `react_as`).
 *
 * v2: `comment_id` has no home on posts.react's body (PostReactBody is just
 * {reaction, react_as?}), comment-level reactions moved to the comments.*
 * group; --comment-id is dropped from this command.
 */
export async function runPostReact(
  client: Curviate,
  flags: PostFlags,
  out: OutputStreams,
): Promise<void> {
  const accountId = requireAccount(flags.account, out);
  const postId = flags.postId ?? "";
  // Unified reaction input: the canonical positional <reaction>, falling back
  // to the deprecated `--reaction` alias. Positional wins when both are given.
  const reaction = flags.reaction ?? flags.reactionAlias ?? "";

  // Validate write-side enum (must be lowercase; uppercase read-side values rejected).
  if (!VALID_REACTIONS.has(reaction)) {
    out.stderr.write(
      `error: reaction must be one of: like, celebrate, support, love, insightful, funny. Got: "${reaction}"\n`,
    );
    process.exit(2);
    return;
  }

  const asOrganization = flags["as-organization"];

  // Build body shared between preview and SDK call.
  const body = {
    reaction: reaction as "like" | "celebrate" | "support" | "love" | "insightful" | "funny",
    ...(asOrganization ? { react_as: asOrganization } : {}),
  };

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "posts.react",
      args: { post_id: postId },
      body,
      account: accountId,
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.posts.react(postId, body);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `post reactions <post_id> [--all] [--limit] [--cursor]`.
 * Read command, rejects --preview.
 */
export async function runPostReactions(
  client: Curviate,
  flags: PostFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = requireAccount(flags.account, out);
  const postId = flags.postId ?? "";
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
  const params = buildPaginationParams(flags);

  try {
    if (all) {
      const fn = (p: Record<string, unknown>) =>
        ns.posts.listReactions(postId, p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.posts.listReactions(postId, params);
      renderSuccess(result, outOpts, out);
    }
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `post saved [--all] [--limit] [--cursor]`, posts.listSaved.
 * Read command, rejects --preview. Lists the connected account's own saved
 * posts (a private bookmark list, newest-saved-first). Each item is a
 * PREVIEW, snippet capped at <=140 chars, never the full post body.
 */
export async function runPostSaved(
  client: Curviate,
  flags: PostFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = requireAccount(flags.account, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
  const params = buildPaginationParams(flags);

  try {
    if (all) {
      const fn = (p: Record<string, unknown>) =>
        ns.posts.listSaved(p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.posts.listSaved(params);
      renderSuccess(result, outOpts, out);
    }
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `post save <post_id>`, posts.save. Write command, supports --preview.
 * Any post may be saved; saving an already-saved post re-asserts saved:true
 * (idempotent). Accepts urn:li:activity:<id> or a bare numeric <id>.
 */
export async function runPostSave(
  client: Curviate,
  flags: PostFlags,
  out: OutputStreams,
): Promise<void> {
  const accountId = requireAccount(flags.account, out);
  const postId = flags.postId ?? "";

  if (flags.preview) {
    const preview = buildPreviewOutput({ method: "posts.save", args: { post_id: postId }, body: {}, account: accountId });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  try {
    const result = await ns.posts.save(postId);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `post unsave <post_id>`, posts.unsave. Write command, supports
 * --preview. Unsaving a not-currently-saved post re-asserts saved:false
 * (idempotent). Same accepted id shapes as `post save`.
 */
export async function runPostUnsave(
  client: Curviate,
  flags: PostFlags,
  out: OutputStreams,
): Promise<void> {
  const accountId = requireAccount(flags.account, out);
  const postId = flags.postId ?? "";

  if (flags.preview) {
    const preview = buildPreviewOutput({ method: "posts.unsave", args: { post_id: postId }, body: {}, account: accountId });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  try {
    const result = await ns.posts.unsave(postId);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `post delete <post_id>`, posts.delete (bodyless, 204).
 * Write command, supports --preview. post_id passes verbatim.
 */
export async function runPostDelete(
  client: Curviate,
  flags: PostFlags,
  out: OutputStreams,
): Promise<void> {
  const accountId = requireAccount(flags.account, out);
  const postId = flags.postId ?? "";

  if (flags.preview) {
    const preview = buildPreviewOutput({ method: "posts.delete", args: { post_id: postId }, body: {}, account: accountId });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  try {
    const result = await ns.posts.delete(postId);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `post unreact <post_id> <reaction>`, posts.unreact.
 * Write command, supports --preview. DELETE-with-body: the reaction value
 * travels in the JSON body, not the path. post_id passes verbatim.
 */
export async function runPostUnreact(
  client: Curviate,
  flags: PostFlags,
  out: OutputStreams,
): Promise<void> {
  const accountId = requireAccount(flags.account, out);
  const postId = flags.postId ?? "";
  const reaction = flags.reaction ?? "";

  if (!VALID_REACTIONS.has(reaction)) {
    out.stderr.write(
      `error: reaction must be one of: like, celebrate, support, love, insightful, funny. Got: "${reaction}"\n`,
    );
    process.exit(2);
    return;
  }

  const body = {
    reaction: reaction as "like" | "celebrate" | "support" | "love" | "insightful" | "funny",
  };

  if (flags.preview) {
    const preview = buildPreviewOutput({ method: "posts.unreact", args: { post_id: postId }, body, account: accountId });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  try {
    const result = await ns.posts.unreact(postId, body);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `post user-posts <user_id> [--all] [--limit] [--cursor]`, posts.listUserPosts.
 * Read command, rejects --preview. user_id is the "me" sentinel or a
 * provider id, forwarded straight through with no extra call; a URL/slug
 * 400s this endpoint (D7) and is first resolved to the provider id via a
 * users.get READ (contact-safe, notifies no one).
 */
export async function runPostUserPosts(
  client: Curviate,
  flags: PostFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);
  const accountId = requireAccount(flags.account, out);
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
  const params = buildPaginationParams(flags);

  try {
    if (all) {
      const fn = (p: Record<string, unknown>) =>
        ns.posts.listUserPosts(userId, p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.posts.listUserPosts(userId, params);
      renderSuccess(result, outOpts, out);
    }
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `post user-reactions <user_id> [--all] [--limit] [--cursor]`, posts.listUserReactions.
 * Read command, rejects --preview. Same D7 provider-id resolution as
 * `post user-posts` (see its docstring): "me" or a provider id pass
 * through unchanged; a URL/slug resolves via a users.get READ first.
 */
export async function runPostUserReactions(
  client: Curviate,
  flags: PostFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);
  const accountId = requireAccount(flags.account, out);
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
  const params = buildPaginationParams(flags);

  try {
    if (all) {
      const fn = (p: Record<string, unknown>) =>
        ns.posts.listUserReactions(userId, p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.posts.listUserReactions(userId, params);
      renderSuccess(result, outOpts, out);
    }
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

// ---------------------------------------------------------------------------
// Citty command definitions
// ---------------------------------------------------------------------------

const postGetCommand = defineCommand({
  meta: { name: "get", description: "Get a post by id." },
  args: {
    ...GLOBAL_FLAGS,
    postId: {
      type: "positional",
      description:
        "Numeric post id, urn:li:activity:N, or full LinkedIn share URL (activity-<N>- extracted). " +
        "POSTID is always the post's id. To list comments on a post, use 'comment list <post_id>'.",
    },
  },
  async run({ args }) {
    const flags = args as PostFlags;
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
    await runPostGet(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const postCreateCommand = defineCommand({
  meta: { name: "create", description: "Create a new post." },
  args: {
    // Write command: WRITE_FLAGS omits pagination/projection flags
    ...WRITE_FLAGS,
    text: { type: "positional", stdinArg: true, description: "Post body text. Pass - to read from stdin (enables multiline via heredoc or pipe)." },
    attach: {
      type: "string",
      description:
        "Image/video/document to attach (repeatable for images; a single PDF produces a document post). " +
        "Supported: jpg, png, gif, mp4, pdf.",
    },
  },
  async run({ args }) {
    const flags = args as PostFlags;
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
    await runPostCreate(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const postReactCommand = defineCommand({
  meta: { name: "react", description: "React to a post." },
  args: {
    // Write command: WRITE_FLAGS omits pagination/projection flags
    ...WRITE_FLAGS,
    postId: {
      type: "positional",
      description:
        "Numeric post id, urn:li:activity:N, or full LinkedIn share URL (activity-<N>- extracted). " +
        "POSTID is always the post's id.",
    },
    reaction: {
      type: "positional",
      required: false,
      description:
        "Write-side reaction (lowercase). Write values: like, celebrate, support, love, insightful, funny. " +
        "Read-side vocabulary (in the value and user_reacted response fields): LIKE, PRAISE, APPRECIATION, EMPATHY, INTEREST, ENTERTAINMENT. " +
        "Confirmed write->read mappings: like=LIKE, celebrate=PRAISE, insightful=INTEREST. " +
        "(support, love, and funny are valid write values; their read-side pairings are unconfirmed.)",
    },
    reactionAlias: {
      type: "string",
      alias: "reaction",
      description: "Deprecated: pass the reaction as the positional <reaction> instead. --reaction still works.",
    },
    "as-organization": {
      type: "string",
      description: "React on behalf of an organization/company page you administer. Pass that page's numeric id or URN.",
    },
  },
  async run({ args }) {
    const flags = args as PostFlags;
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
    await runPostReact(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const postReactionsCommand = defineCommand({
  meta: { name: "reactions", description: "List reactions on a post." },
  args: {
    ...GLOBAL_FLAGS,
    postId: {
      type: "positional",
      description:
        "Numeric post id, urn:li:activity:N, or full LinkedIn share URL (activity-<N>- extracted). " +
        "POSTID is always the post's id.",
    },
  },
  async run({ args }) {
    const flags = args as PostFlags;
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
    await runPostReactions(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

/** Shared config/client boilerplate for a subcommand's run(). */
async function withClient(
  flags: PostFlags,
  fn: (client: Curviate, flags: PostFlags, out: OutputStreams) => Promise<void>,
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

const postDeleteCommand = defineCommand({
  meta: { name: "delete", description: "Delete a post you own." },
  args: {
    ...WRITE_SINGLE_FLAGS,
    postId: { type: "positional", description: "Post id, urn:li:activity:N, or full share URL." },
  },
  async run({ args }) {
    await withClient(args as PostFlags, runPostDelete);
  },
});

const postUnreactCommand = defineCommand({
  meta: { name: "unreact", description: "Remove your reaction from a post." },
  args: {
    ...WRITE_SINGLE_FLAGS,
    postId: { type: "positional", description: "Post id, urn:li:activity:N, or full share URL." },
    reaction: { type: "positional", description: "Reaction to remove: like|celebrate|support|love|insightful|funny." },
  },
  async run({ args }) {
    await withClient(args as PostFlags, runPostUnreact);
  },
});

const postSavedCommand = defineCommand({
  meta: { name: "saved", description: "List your own saved posts (a private bookmark list, newest-saved-first). Each item is a preview (snippet capped at 140 chars)." },
  args: { ...GLOBAL_FLAGS },
  async run({ args }) {
    await withClient(args as PostFlags, runPostSaved);
  },
});

const postSaveCommand = defineCommand({
  meta: { name: "save", description: "Save a post to your private bookmark list. Never notifies the author, never visible to third parties. Idempotent." },
  args: {
    ...WRITE_SINGLE_FLAGS,
    postId: { type: "positional", description: "Post id (urn:li:activity:N or a bare numeric id)." },
  },
  async run({ args }) {
    await withClient(args as PostFlags, runPostSave);
  },
});

const postUnsaveCommand = defineCommand({
  meta: { name: "unsave", description: "Remove a post from your saved-posts bookmark list. Idempotent." },
  args: {
    ...WRITE_SINGLE_FLAGS,
    postId: { type: "positional", description: "Post id (urn:li:activity:N or a bare numeric id)." },
  },
  async run({ args }) {
    await withClient(args as PostFlags, runPostUnsave);
  },
});

const postUserPostsCommand = defineCommand({
  meta: { name: "user-posts", description: "List a member's own posts (accepts 'me'). A very recent create/delete may take a few minutes to appear or clear here (LinkedIn-side indexing); `post get <post_id>` reflects it immediately." },
  args: {
    ...GLOBAL_FLAGS,
    userId: { type: "positional", description: "Member identifier (URL, slug, provider id, or 'me')." },
  },
  async run({ args }) {
    await withClient(args as PostFlags, runPostUserPosts);
  },
});

const postUserReactionsCommand = defineCommand({
  meta: { name: "user-reactions", description: "List a member's own reactions (accepts 'me')." },
  args: {
    ...GLOBAL_FLAGS,
    userId: { type: "positional", description: "Member identifier (URL, slug, provider id, or 'me')." },
  },
  async run({ args }) {
    await withClient(args as PostFlags, runPostUserReactions);
  },
});

export const postCommand = defineCommand({
  meta: { name: "post", description: "Create and manage LinkedIn posts." },
  subCommands: {
    get: postGetCommand,
    create: postCreateCommand,
    react: postReactCommand,
    reactions: postReactionsCommand,
    delete: postDeleteCommand,
    unreact: postUnreactCommand,
    saved: postSavedCommand,
    save: postSaveCommand,
    unsave: postUnsaveCommand,
    "user-posts": postUserPostsCommand,
    "user-reactions": postUserReactionsCommand,
  },
  async run() {
    process.stderr.write(
      "Usage: curviate post <subcommand>\n" +
      "  get <post_id>\n" +
      "  create \"<text>\" [--attach <file>...]\n" +
      "  react <post_id> <reaction> [--as-organization <org_id>]\n" +
      "  reactions <post_id>\n" +
      "  delete <post_id>\n" +
      "  unreact <post_id> <reaction>\n" +
      "  saved\n" +
      "  save <post_id>\n" +
      "  unsave <post_id>\n" +
      "  user-posts <user_id>\n" +
      "  user-reactions <user_id>\n" +
      "\nComment operations moved to the `comment` command group.\n",
    );
  },
});
