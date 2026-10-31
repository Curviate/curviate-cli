/**
 * `curviate core message`, LinkedIn message operations.
 *
 * Subcommands:
 *   message new --to <url|slug|provider_id>... "<text>" [--subject <s>] [--attach <file>...] [--share-post <id>|--share-job <id>]: start new chat (write)
 *   message <chat_id> "<text>" [--attach <file>...] [--share-post <id>|--share-job <id>]: send message to chat (write)
 *   message get <chat_id> <message_id>: get a message (read)
 *   message edit <chat_id> <message_id> "<text>": edit a message (write)
 *   message delete <chat_id> <message_id>: delete a message (write)
 *   message react <chat_id> <message_id> <emoji>: react to message (write, body field: reaction; --emoji alias)
 *   message attachment <chat_id> <message_id> <attachment_id> [-o <file>]: download attachment (binary)
 *   message inmail --to <url|slug|provider-id|urn> --subject <s> "<text>": send InMail (write)
 *   message inmail-balance: get InMail credit balance (read)
 *
 * v2: get/edit/delete/react/attachment are re-homed under
 * /chats/{chat_id}/messages/{message_id}, every one of them now takes a
 * leading chat_id as well as message_id. --surface has no v2 home on
 * sendInMail (the body is just recipient_urn/subject/text) and is dropped.
 *
 * chat_id / message_id / attachment_id pass through verbatim (chat_id is
 * additionally normalized from a thread URL to its bare provider id, same as
 * `message send`).
 * --to for `message new` accepts a LinkedIn URL, bare slug, or provider ID.
 *   URL/slug inputs resolve via users.get; provider-ID-shaped inputs pass through directly.
 *   Repeat --to: two or more distinct people start a group chat, named by --subject.
 *   A repeated person counts once, so `--to a --to a` is a direct chat with a.
 * --share-post / --share-job on `message new` and `message send` show a post or job
 *   posting natively beside the text (shared_content). Text is required, no attachments.
 * --to for `message inmail` accepts a LinkedIn URL, bare slug, provider ID, or member URN.
 *   URL/slug inputs resolve via users.get; URN and provider-ID pass through directly.
 * <chat_id> on `message send` accepts a LinkedIn messaging thread URL or bare provider ID;
 *   thread URLs are normalized to the bare provider ID (zero network calls).
 */

import { requireAccount } from "../lib/account-arg.js";
import { defineCommand } from "citty";
import { AS_ACCOUNT, BUDGET, TARGET } from "../lib/help-errors.js";
import { DESCRIPTIONS } from "./descriptions.js";
import { WRITE_FLAGS, READ_SINGLE_FLAGS, readOnly } from "../lib/global-flags.js";
import { looksLikeCommandWord, nearestSubcommand } from "../lib/bare-form-guard.js";
import { resolveIdentifier, normalizeChatId, resolveJobIdentifier } from "../lib/identifier.js";
import { resolveTextOrStdin } from "../lib/stdin.js";
import { resolveEffectiveConfig } from "../lib/resolve.js";
import { createClient, downloadBinary } from "../lib/client.js";
import { renderSuccess, renderError, renderUnexpectedError } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { readAttachment, AttachError, toAttachmentPayload } from "../lib/attach.js";
import { writeBinaryOutput, BinaryOutputError } from "../lib/binary.js";
import { readableId, readableObject } from "../lib/paginate.js";
import type { Curviate, CurviateError } from "@curviate/sdk";

type MessageFlags = {
  chatId?: string;
  messageId?: string;
  attachmentId?: string;
  to?: string | string[];
  text?: string;
  emoji?: string;
  /** Deprecated alias for the positional <emoji> (the old `--emoji` flag). */
  emojiAlias?: string;
  subject?: string;
  output?: string;
  attach?: string | string[];
  "share-post"?: string;
  "share-job"?: string;
  account?: string;
  json?: boolean;
  fields?: string;
  limit?: string;
  cursor?: string;
  all?: boolean;
  "max-pages"?: string;
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


function rejectAllOnNonPaginated(all: boolean | undefined, out: OutputStreams): void {
  if (all) {
    out.stderr.write("error: --all is not supported on non-paginated commands.\n");
    process.exit(2);
  }
}

/** The served cap on a chat's subject (`POST /v1/{account_id}/chats`, maxLength 200). */
const CHAT_SUBJECT_MAX_CHARS = 200;

/**
 * Read `message new --subject` off the parsed flags.
 *
 * Omitted means no subject and the key is left OUT of the body: the server's
 * schema has `max(200)` and no `.min(1)`, so a `subject: ""` sent on the
 * caller's behalf would be accepted and name the chat "" on the platform
 * rather than leave it unnamed. An explicitly empty or blank `--subject` is a
 * lost value, not an omission (`--subject "$S"` with `S` unset) — exit 2,
 * same ruling as `--cursor ""`.
 *
 * The length cap is checked here rather than round-tripped: the limit is
 * served and stable, and a 400 for a typed-too-long subject costs a request
 * to learn something the CLI already knows. Same shape as `inbox search`'s
 * MIN_SEARCH_QUERY_CHARS, which exists because a generated `string` type
 * cannot carry a length.
 */
function readChatSubjectFlag(flags: MessageFlags, out: OutputStreams): string | undefined {
  const raw = flags.subject;
  if (raw === undefined) return undefined;
  if (raw.trim() === "") {
    out.stderr.write(
      "error: --subject was given an empty value. Pass the subject line, or omit the flag entirely to start an unnamed chat.\n",
    );
    process.exit(2);
  }
  if (raw.length > CHAT_SUBJECT_MAX_CHARS) {
    out.stderr.write(
      `error: --subject is ${raw.length} characters; the maximum is ${CHAT_SUBJECT_MAX_CHARS}.\n`,
    );
    process.exit(2);
  }
  return raw;
}

/**
 * Read `message inmail --subject` off the parsed flags.
 *
 * Unlike `message new`'s optional chat subject, InMail's `--subject` is
 * REQUIRED (`POST /v1/{account_id}/messages/inmail`, 1-200 chars). citty's
 * own `required: true` already rejects a fully omitted flag before this
 * command runs, so only an explicitly empty or whitespace-only value needs
 * catching here — citty treats "given but blank" as satisfied.
 *
 * Called before any resolution step (including `--to`, which can call
 * `users.get`) so a lost subject never costs a network round trip, same
 * placement as `readChatSubjectFlag` in `runMessageNew`.
 */
function readInMailSubjectFlag(flags: MessageFlags, out: OutputStreams): string {
  const raw = flags.subject ?? "";
  if (raw.trim() === "") {
    out.stderr.write("error: --subject was given an empty value. Pass the subject line.\n");
    process.exit(2);
  }
  if (raw.length > CHAT_SUBJECT_MAX_CHARS) {
    out.stderr.write(
      `error: --subject is ${raw.length} characters; the maximum is ${CHAT_SUBJECT_MAX_CHARS}.\n`,
    );
    process.exit(2);
  }
  return raw;
}

function resolveOutputOpts(flags: MessageFlags) {
  return {
    json: (flags.json ?? false) || !process.stdout.isTTY,
    isTTY: process.stdout.isTTY ?? false,
    fields: flags.fields,
  };
}

/** Normalize --attach flag to an array of paths. */
function normalizeAttachPaths(attach: string | string[] | undefined): string[] {
  if (!attach) return [];
  return Array.isArray(attach) ? attach : [attach];
}

/**
 * Read `--share-post` / `--share-job` into the body's `shared_content`.
 *
 * Every refusal the server would answer with a 400 and nothing sent is caught
 * here first, so a mistake costs no request: both flags at once (one object
 * only), a blank value (a lost `"$ID"`), no text (the post or job is shown
 * beside it) and any attachment. A post id goes through as given (the id a
 * read returns, an activity id, a URN or a share URL); a job URL is reduced to
 * its numeric id.
 */
function readSharedContent(
  flags: MessageFlags,
  text: string,
  attachPaths: string[],
  out: OutputStreams,
): { type: "post" | "job_posting"; id: string } | undefined {
  const post = flags["share-post"];
  const job = flags["share-job"];
  if (post === undefined && job === undefined) return undefined;
  const refuse = (msg: string): never => {
    out.stderr.write(`error: ${msg}\n`);
    process.exit(2);
  };
  if (post !== undefined && job !== undefined) refuse("pass --share-post or --share-job, not both.");
  const flag = post !== undefined ? "--share-post" : "--share-job";
  const raw = (post ?? job ?? "").trim();
  if (raw === "") refuse(`${flag} was given an empty value. Pass the id, or omit the flag.`);
  if (text.trim() === "") refuse(`${flag} needs the message text: the ${post !== undefined ? "post" : "job posting"} is shown beside it.`);
  if (attachPaths.length > 0) refuse(`${flag} cannot be combined with --attach.`);
  return post !== undefined ? { type: "post", id: raw } : { type: "job_posting", id: resolveJobIdentifier(raw) };
}

/** Normalize repeated --to into its non-blank values. */
function normalizeToValues(to: string | string[] | undefined): string[] {
  return (Array.isArray(to) ? to : to === undefined ? [] : [to]).filter((v) => v !== "");
}

/** A LinkedIn member URN: urn:li:member:<digits>. */
const MEMBER_URN_RE = /^urn:li:member:\d+$/;

/**
 * A LinkedIn member provider id (e.g. ACoAAA...): "A", then C|D|E, then >=4 id chars.
 * Provider IDs always start with an uppercase A followed by C, D, or E.
 * LinkedIn profile slugs are lowercase, so this prefix uniquely identifies provider IDs.
 */
const MEMBER_PROVIDER_ID_RE = /^A[CDE][A-Za-z0-9_-]{4,}$/;

async function handleSdkError(err: unknown, outOpts: ReturnType<typeof resolveOutputOpts>, out: OutputStreams): Promise<never> {
  const { CurviateError } = await import("@curviate/sdk");
  if (err instanceof CurviateError) {
    const { getExitCode } = await import("../lib/exit-codes.js");
    renderError(err as CurviateError, outOpts, out);
    process.exit(getExitCode(err));
  }
  renderUnexpectedError(err, out);
  process.exit(1);
}

/**
 * Human-readable acting-identity notice for a completed send, written to
 * stderr (diagnostic chrome, never the stdout data channel, the SDK's
 * `sent_as` field is already on the JSON response regardless of this
 * notice). Personal sends print nothing (the common case stays quiet); a
 * company-page send names the page when the server correlated it to a
 * managed company, or a generic fallback when it could not.
 *
 * Shared: exported for reuse by `company reply` (companies.ts), which sends
 * as a page unconditionally and prints the same notice on its own responses.
 */
export function sentAsNotice(sentAs: unknown): string | null {
  if (!sentAs || typeof sentAs !== "object") return null;
  const s = sentAs as { kind?: string; name?: string | null };
  if (s.kind !== "company") return null;
  return s.name ? `Sent as ${s.name} (company page)\n` : "Sent as a company page\n";
}

/**
 * Client-side-only "will send as a company page" note for `--preview` on a
 * `COMPANY_` chat id. Never makes a network call (that would break the
 * zero-round-trip --preview contract), a page's display name is only
 * resolvable by correlating a live inboxes/managed-companies read, so this
 * states the fact that the send would act as a page, derived purely from the
 * chat id's own `COMPANY_` prefix.
 *
 * Used by `message send`'s --preview (the personal send still accepts a
 * `COMPANY_` chat id). Exported so it can be unit-tested directly.
 * (`company reply` no longer uses this: post-cutover its chat id is the
 * normal `2-...` form, so it derives the notice from the company identifier.)
 */
export function willSendAsNotice(chatId: string): string | null {
  return chatId.startsWith("COMPANY_") ? "Will send as a company page\n" : null;
}

// ---------------------------------------------------------------------------
// Exported run functions (testable without citty)
// ---------------------------------------------------------------------------

/**
 * Run `message new --to <url|slug|provider_id>... "<text>" [--subject <s>] [--attach <file>...]`.
 * Write command, supports --preview.
 *
 * --to resolution (each value, in order; repeat --to for a group chat):
 *   LinkedIn URL or bare slug -> users.get(slug) -> provider_id passed to startChat.
 *   Provider-ID-shaped input (uppercase AC/AD/AE prefix) -> passed directly, no users.get call.
 *   users.get not-found -> exit 4.
 *   A person named twice is sent once (the server counts a repeat once too).
 *
 * v2: attachments travel as base64 {content,content_type,filename} objects
 * (application/json only, no multipart op), never raw Buffers.
 */
export async function runMessageNew(
  client: Curviate,
  flags: MessageFlags,
  out: OutputStreams,
  _readStdin?: () => Promise<string>,
): Promise<void> {
  const subject = readChatSubjectFlag(flags, out);
  const accountId = await requireAccount(client, flags, out);
  const rawTos = normalizeToValues(flags.to);
  const rawText = flags.text ?? "";
  const attachPaths = normalizeAttachPaths(flags.attach);

  // Load attachments before any SDK call.
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

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  // Resolve stdin sentinel: "-" reads all of stdin.
  const text = await resolveTextOrStdin(rawText, out, _readStdin);
  const sharedContent = readSharedContent(flags, text, attachPaths, out);

  // Resolve each recipient to a provider ID.
  // URL/slug inputs call users.get; provider-ID-shaped inputs pass through directly.
  const attendeeIds: string[] = [];
  for (const rawTo of rawTos) {
    const resolvedSlugOrId = resolveIdentifier(rawTo);
    let providerId: string | undefined;
    if (MEMBER_PROVIDER_ID_RE.test(resolvedSlugOrId)) {
      // Already a provider ID, use directly without an extra SDK call.
      providerId = resolvedSlugOrId;
    } else {
      // Slug or other form, resolve via users.get.
      try {
        providerId = readableId(await ns.users.get(resolvedSlugOrId, {}));
      } catch (err: unknown) {
        await handleSdkError(err, outOpts, out);
        return; // unreachable: handleSdkError always calls process.exit
      }
    }
    if (providerId !== undefined && !attendeeIds.includes(providerId)) attendeeIds.push(providerId);
  }

  const attachmentPayloads = attachBuffers.map((buf, i) => toAttachmentPayload(attachPaths[i]!, buf));

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "messaging.startChat",
      args: { attendees_ids: attendeeIds },
      body: {
        attendees_ids: attendeeIds,
        text,
        ...(subject !== undefined ? { subject } : {}),
        ...(sharedContent ? { shared_content: sharedContent } : {}),
      },
      account: accountId,
      attachments: attachBuffers.map((buf, i) => ({
        name: attachPaths[i] ? attachPaths[i].split("/").pop() ?? attachPaths[i] : `attachment_${i}`,
        buffer: buf,
      })),
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const body = {
    attendees_ids: attendeeIds,
    text,
    // Present only when the flag was given: an absent subject must leave the
    // key out, never send `subject: ""` (the server has no `.min(1)`).
    ...(subject !== undefined ? { subject } : {}),
    ...(attachmentPayloads.length > 0 ? { attachments: attachmentPayloads } : {}),
    ...(sharedContent ? { shared_content: sharedContent } : {}),
  };

  try {
    const result = await ns.messaging.startChat(body);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `message <chat_id> "<text>" [--attach <file>...]`.
 * Write command, supports --preview.
 *
 * <chat_id> accepts a LinkedIn messaging thread URL or bare provider ID.
 * Thread URLs are normalized to the bare provider ID (zero network calls).
 */
export async function runMessageSend(
  client: Curviate,
  flags: MessageFlags,
  out: OutputStreams,
  _readStdin?: () => Promise<string>,
): Promise<void> {
  const accountId = await requireAccount(client, flags, out);
  const chatId = normalizeChatId(flags.chatId ?? "");
  const rawText = flags.text ?? "";
  const attachPaths = normalizeAttachPaths(flags.attach);

  // Resolve stdin sentinel: "-" reads all of stdin.
  const text = await resolveTextOrStdin(rawText, out, _readStdin);
  const sharedContent = readSharedContent(flags, text, attachPaths, out);

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
    const preview = buildPreviewOutput({
      method: "messaging.sendMessage",
      args: { chat_id: chatId },
      body: { text, ...(sharedContent ? { shared_content: sharedContent } : {}) },
      account: accountId,
      attachments: attachBuffers.map((buf, i) => ({
        name: attachPaths[i] ? attachPaths[i].split("/").pop() ?? attachPaths[i] : `attachment_${i}`,
        buffer: buf,
      })),
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    const willSendAs = willSendAsNotice(chatId);
    if (willSendAs) out.stderr.write(willSendAs);
    return;
  }

  const attachmentPayloads = attachBuffers.map((buf, i) => toAttachmentPayload(attachPaths[i]!, buf));
  const body = {
    text,
    ...(attachmentPayloads.length > 0 ? { attachments: attachmentPayloads } : {}),
    ...(sharedContent ? { shared_content: sharedContent } : {}),
  };

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.messaging.sendMessage(chatId, body);
    renderSuccess(result, outOpts, out);
    const notice = sentAsNotice((result as Record<string, unknown> | null)?.["sent_as"]);
    if (notice) out.stderr.write(notice);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `message get <chat_id> <message_id>`.
 * Read command, rejects --preview and --all.
 * v2: re-homed under /chats/{chat_id}/messages/{message_id}, chat_id is now
 * a leading positional (normalized the same way as `message send`'s).
 */
export async function runMessageGet(
  client: Curviate,
  flags: MessageFlags,
  out: OutputStreams,
): Promise<void> {
  rejectAllOnNonPaginated(flags.all, out);

  const accountId = await requireAccount(client, flags, out);
  const chatId = normalizeChatId(flags.chatId ?? "");
  const messageId = flags.messageId ?? "";
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.messaging.getMessage(chatId, messageId);
    readableObject(result);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `message edit <chat_id> <message_id> "<text>"`.
 * Write command, supports --preview.
 * v2: re-homed under /chats/{chat_id}/messages/{message_id}, chat_id is now
 * a leading positional.
 */
export async function runMessageEdit(
  client: Curviate,
  flags: MessageFlags,
  out: OutputStreams,
  _readStdin?: () => Promise<string>,
): Promise<void> {
  const accountId = await requireAccount(client, flags, out);
  const chatId = normalizeChatId(flags.chatId ?? "");
  const messageId = flags.messageId ?? "";
  const rawText = flags.text ?? "";

  // Resolve stdin sentinel: "-" reads all of stdin.
  const text = await resolveTextOrStdin(rawText, out, _readStdin);

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "messaging.editMessage",
      args: { chat_id: chatId, message_id: messageId },
      body: { text },
      account: accountId,
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.messaging.editMessage(chatId, messageId, { text });
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `message delete <chat_id> <message_id>`.
 * Write command, supports --preview.
 * v2: re-homed under /chats/{chat_id}/messages/{message_id}, chat_id is now
 * a leading positional.
 */
export async function runMessageDelete(
  client: Curviate,
  flags: MessageFlags,
  out: OutputStreams,
): Promise<void> {
  const accountId = await requireAccount(client, flags, out);
  const chatId = normalizeChatId(flags.chatId ?? "");
  const messageId = flags.messageId ?? "";

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "messaging.deleteMessage",
      args: { chat_id: chatId, message_id: messageId },
      body: {},
      account: accountId,
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.messaging.deleteMessage(chatId, messageId);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `message react <chat_id> <message_id> <emoji>`.
 * Write command, supports --preview.
 * <emoji> is the canonical positional (the deprecated `--emoji` flag still
 * works as an alias); the SDK body field is `reaction` (confirmed from
 * AddReactionBody).
 * v2: re-homed under /chats/{chat_id}/messages/{message_id}, chat_id is now
 * a leading positional.
 */
export async function runMessageReact(
  client: Curviate,
  flags: MessageFlags,
  out: OutputStreams,
): Promise<void> {
  const accountId = await requireAccount(client, flags, out);
  const chatId = normalizeChatId(flags.chatId ?? "");
  const messageId = flags.messageId ?? "";
  // Unified reaction input: the canonical positional <emoji>, falling back to
  // the deprecated `--emoji` alias. Positional wins when both are given.
  const reaction = flags.emoji ?? flags.emojiAlias ?? "";

  // A reaction value is required (citty no longer enforces it now that the
  // positional is optional to allow the flag alias), a missing value is a
  // usage error, not a silent empty-body reaction.
  if (!reaction) {
    out.stderr.write("error: a reaction is required. Pass it as `curviate core message react <chat_id> <message_id> <emoji>` (or --emoji <e>).\n");
    process.exit(2);
    return;
  }

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "messaging.addReaction",
      args: { chat_id: chatId, message_id: messageId },
      body: { reaction },
      account: accountId,
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.messaging.addReaction(chatId, messageId, { reaction });
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `message attachment <chat_id> <message_id> <attachment_id> [-o <file>]`.
 * Read command, binary response. Rejects --preview.
 * v2: re-homed under /chats/{chat_id}/messages/{message_id}/attachments/{attachment_id};
 * chat_id is now a leading positional.
 * @param isTTY - injectable for tests (avoids reading process.stdout.isTTY)
 */
export async function runMessageAttachment(
  client: Curviate,
  flags: MessageFlags,
  out: OutputStreams,
  isTTY: boolean,
): Promise<void> {

  const accountId = await requireAccount(client, flags, out);
  const chatId = normalizeChatId(flags.chatId ?? "");
  const messageId = flags.messageId ?? "";
  const attachmentId = flags.attachmentId ?? "";
  const ns = client.account(accountId);

  try {
    const data = await downloadBinary(() => ns.messaging.getAttachment(chatId, messageId, attachmentId));
    await writeBinaryOutput(data, {
      outputPath: flags.output,
      isTTY,
      stdout: process.stdout,
    });
  } catch (err: unknown) {
    if (err instanceof BinaryOutputError) {
      out.stderr.write(`error: ${err.message}\n`);
      process.exit(err.exitCode);
    }
    const outOpts = resolveOutputOpts(flags);
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `message inmail --to <url|slug|provider-id|urn> --subject <s> "<text>"`.
 * Write command, supports --preview.
 *
 * --to resolution:
 *   LinkedIn URL or bare slug -> users.get(slug) -> provider_id used as recipient_urn.
 *   Provider ID (AC/AD/AE prefix) -> passed directly as recipient_urn, no users.get call.
 *   Member URN (urn:li:member:<N>) -> passed directly as recipient_urn, no users.get call.
 *   Empty string -> exit 2.
 *   users.get not-found -> exit 4.
 *
 * v2: the body is just {recipient_urn, subject, text}, --surface has no v2
 * home (the old body's `surface` field is gone) and is no longer accepted.
 */
export async function runMessageInMail(
  client: Curviate,
  flags: MessageFlags,
  out: OutputStreams,
  _readStdin?: () => Promise<string>,
): Promise<void> {
  const subject = readInMailSubjectFlag(flags, out);
  const accountId = await requireAccount(client, flags, out);

  // --to is not repeatable here (the dispatcher refuses a second one), so at most one value.
  const rawTo = normalizeToValues(flags.to)[0] ?? "";
  if (!rawTo) {
    out.stderr.write(
      "error: --to: not a valid LinkedIn URL, slug, provider-id, or URN.\n",
    );
    process.exit(2);
    return;
  }

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  // Resolve --to to a recipient URN.
  const resolvedSlugOrId = resolveIdentifier(rawTo);
  let recipientUrn: string | undefined;

  if (MEMBER_URN_RE.test(resolvedSlugOrId)) {
    // Already a member URN, pass through directly.
    recipientUrn = resolvedSlugOrId;
  } else if (MEMBER_PROVIDER_ID_RE.test(resolvedSlugOrId)) {
    // Already a provider ID, pass through directly.
    recipientUrn = resolvedSlugOrId;
  } else {
    // Slug or URL-derived slug, resolve via users.get.
    try {
      recipientUrn = readableId(await ns.users.get(resolvedSlugOrId, {}));
    } catch (err: unknown) {
      await handleSdkError(err, outOpts, out);
      return; // unreachable: handleSdkError always calls process.exit
    }
  }

  const rawText = flags.text ?? "";

  // Resolve stdin sentinel: "-" reads all of stdin.
  const text = await resolveTextOrStdin(rawText, out, _readStdin);

  const body = {
    recipient_urn: recipientUrn!,
    subject,
    text,
  };

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "messaging.sendInMail",
      args: { recipient_urn: recipientUrn! },
      body,
      account: accountId,
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  try {
    const result = await ns.messaging.sendInMail(body);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `message inmail-balance`.
 * Read command, rejects --preview and --all.
 * v2: relocated to users.getInMailCredits (was messaging.getInMailBalance).
 */
export async function runMessageInMailBalance(
  client: Curviate,
  flags: MessageFlags,
  out: OutputStreams,
): Promise<void> {
  rejectAllOnNonPaginated(flags.all, out);

  const accountId = await requireAccount(client, flags, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.users.getInMailCredits();
    readableObject(result);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

// ---------------------------------------------------------------------------
// Citty command definitions
// ---------------------------------------------------------------------------

/** `--share-post` / `--share-job`: the shared_content of a send, on `message new` and `message send`. */
const SHARE_ARGS = {
  "share-post": {
    type: "string",
    description:
      "Show a post natively in the message, beside the text (text required, no --attach). The post id from `curviate core post get` or a list; an activity id, URN or share URL also works. Not with --share-job. Whether a post id renders in the message is unproven until a live send.",
  },
  "share-job": {
    type: "string",
    description:
      "Show a job posting natively in the message, beside the text (text required, no --attach). The numeric job id or a LinkedIn job URL. Not with --share-post.",
  },
} as const;

const messageNewCommand = defineCommand({
  meta: {
    name: "new",
    description: "Start a new chat with one or more members.",
    risk: "write",
    rules: {
      changes: "Starts a chat with the recipient (a group chat with two or more --to) and sends the opening message from your Account.",
      visible_to: "The recipient, or every member of a group, in their LinkedIn inbox.",
      budget_rows: ["messages_first_degree"],
      retry: "Not safe: requests carry no idempotency key, so a retry after a timeout can repeat it. Read `curviate core inbox list` first.",
      undo: "`curviate core message delete <chat_id> <message_id>` removes the message; the chat stays and the recipient may have read it.",
    },
    errors: { ...AS_ACCOUNT, ...BUDGET, ...TARGET, RECIPIENT_UNREACHABLE: "LinkedIn will not let the Account message this person." },
    examples: [
      "curviate core message new --to janesmith \"Hi Jane, enjoyed your post on agent evals.\"",
      "curviate core message new --to janesmith --to ACoAAAexample --subject \"Q4 intro\" \"Hi both, meet each other.\" --preview",
      "curviate core message new --to janesmith --share-job 4012345678 \"Thought of you for this one.\"",
    ],
  },
  args: {
    // Write command: WRITE_FLAGS omits pagination/projection flags
    ...WRITE_FLAGS,
    to: {
      type: "string",
      description:
        "Recipient (repeatable): LinkedIn profile URL (e.g. https://www.linkedin.com/in/some-slug), bare slug (e.g. some-slug), or provider ID (e.g. ACoAAA...). URL and slug inputs resolve the provider ID automatically. One --to starts a direct chat; two or more different people start a group chat. A person named twice counts once.",
      required: true,
    },
    text: { type: "positional", stdinArg: true, description: "Opening message text. Pass - to read from stdin (e.g. via heredoc or pipe)." },
    subject: {
      type: "string",
      description:
        "Optional conversation name / subject line (at most 200 characters). The group's name when there are two or more people. Omit it for an unnamed chat; an empty value is a usage error.",
    },
    attach: { type: "string", description: "File to attach (repeatable). Not with --share-post or --share-job. A voice note stays out of groups." },
    ...SHARE_ARGS,
  },
  async run({ args }) {
    const flags = args as MessageFlags;
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
    await runMessageNew(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const messageGetCommand = defineCommand({
  meta: {
    name: "get",
    description: "Get a message by ID.",
    risk: "read",
    examples: [
      "curviate core message get 2-YTQ3ODU3Njgt MSG_ID",
    ],
  },
  args: {
    // Single-object read: READ_SINGLE_FLAGS omits pagination flags, keeps --fields
    ...readOnly(READ_SINGLE_FLAGS),
    chatId: { type: "positional", description: "Chat ID or LinkedIn messaging thread URL." },
    messageId: { type: "positional", description: "Message ID." },
  },
  async run({ args }) {
    const flags = args as MessageFlags;
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
    await runMessageGet(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const messageEditCommand = defineCommand({
  meta: {
    name: "edit",
    description: "Edit a message (within the allowed window).",
    risk: "write",
    rules: {
      changes: "Replaces the text of one of your messages.",
      visible_to: "The other participants of the chat.",
      budget_rows: [],
      retry: "Safe: the same text written again leaves the message the same.",
      undo: "Edit it again with the previous text, while LinkedIn still allows edits.",
    },
    errors: { ...AS_ACCOUNT, ...TARGET },
    examples: [
      "curviate core message edit 2-YTQ3ODU3Njgt MSG_ID \"Thanks, that makes sense to me.\"",
    ],
  },
  args: {
    // Write command: WRITE_FLAGS omits pagination/projection flags
    ...WRITE_FLAGS,
    chatId: { type: "positional", description: "Chat ID or LinkedIn messaging thread URL." },
    messageId: { type: "positional", description: "Message ID." },
    text: { type: "positional", stdinArg: true, description: "Replacement text. Pass - to read from stdin." },
  },
  async run({ args }) {
    const flags = args as MessageFlags;
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
    await runMessageEdit(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const messageDeleteCommand = defineCommand({
  meta: {
    name: "delete",
    description: "Delete a message.",
    risk: "high",
    rules: {
      changes: "Deletes one message from the chat.",
      visible_to: "The other participants no longer see it.",
      budget_rows: [],
      retry: "Safe: a deleted message is gone, so a repeat has nothing to delete.",
      undo: "Cannot be undone.",
      blast_radius: "One message.",
    },
    errors: { ...AS_ACCOUNT, ...TARGET },
    seeAlso: ["curviate core inbox messages"],
    examples: [
      "curviate core message delete 2-YTQ3ODU3Njgt MSG_ID",
    ],
  },
  args: {
    // Write command: WRITE_FLAGS omits pagination/projection flags
    ...WRITE_FLAGS,
    chatId: { type: "positional", description: "Chat ID or LinkedIn messaging thread URL." },
    messageId: { type: "positional", description: "Message ID." },
  },
  async run({ args }) {
    const flags = args as MessageFlags;
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
    await runMessageDelete(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const messageReactCommand = defineCommand({
  meta: {
    name: "react",
    description: "Add an emoji reaction to a message.",
    risk: "write",
    rules: {
      changes: "Adds your emoji reaction to the message.",
      visible_to: "The other participants of the chat.",
      budget_rows: ["post_likes"],
      retry: "Read the message first: a repeat with the same emoji may count against the budget again.",
      undo: "React again to change it; the CLI has no command to remove a reaction.",
    },
    errors: { ...AS_ACCOUNT, ...BUDGET, ...TARGET },
    examples: [
      "curviate core message react 2-YTQ3ODU3Njgt MSG_ID 👍",
    ],
    requires: [
      "The reaction: the <emoji> argument or --emoji.",
    ],
  },
  args: {
    // Write command: WRITE_FLAGS omits pagination/projection flags
    ...WRITE_FLAGS,
    chatId: { type: "positional", description: "Chat ID or LinkedIn messaging thread URL." },
    messageId: { type: "positional", description: "Message ID." },
    emoji: { type: "positional", required: false, description: "Native emoji reaction value (e.g. 👍)." },
    emojiAlias: {
      type: "string",
      alias: "emoji",
      description: "Deprecated: pass the emoji as the positional <emoji> instead. --emoji still works.",
    },
  },
  async run({ args }) {
    const flags = args as MessageFlags;
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
    await runMessageReact(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const messageAttachmentCommand = defineCommand({
  meta: {
    name: "attachment",
    description: "Download a message attachment.",
    risk: "read",
    examples: [
      "curviate core message attachment 2-YTQ3ODU3Njgt MSG_ID ATTACHMENT_ID -o attachment.pdf",
    ],
  },
  args: {
    // Single-object read: READ_SINGLE_FLAGS omits pagination flags, keeps --fields
    ...readOnly(READ_SINGLE_FLAGS),
    chatId: { type: "positional", description: "Chat ID or LinkedIn messaging thread URL." },
    messageId: { type: "positional", description: "Message ID." },
    attachmentId: { type: "positional", description: "Attachment ID." },
    output: { type: "string", alias: "o", description: "Path to write the file to." },
  },
  async run({ args }) {
    const flags = args as MessageFlags;
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
    await runMessageAttachment(
      client,
      { ...flags, account: flags.account ?? cfg.account },
      out,
      process.stdout.isTTY ?? false,
    );
  },
});

const messageInMailCommand = defineCommand({
  meta: {
    name: "inmail",
    description: "Send an InMail to a member.",
    risk: "write",
    rules: {
      changes: "Sends an InMail to the member.",
      visible_to: "The recipient.",
      budget_rows: ["inmail"],
      retry: "Not safe: requests carry no idempotency key, so a retry after a timeout can repeat it. Read `curviate core inbox list` first.",
      undo: "Cannot be undone.",
    },
    errors: { ...AS_ACCOUNT, ...BUDGET, ...TARGET, RECIPIENT_UNREACHABLE: "LinkedIn will not let the Account message this person." },
    examples: [
      "curviate core message inmail --to janesmith --subject \"Agent tooling\" \"Hi Jane, a quick question about your eval setup.\"",
    ],
  },
  args: {
    // Write command: WRITE_FLAGS omits pagination/projection flags
    ...WRITE_FLAGS,
    to: {
      type: "string",
      description:
        "Recipient: LinkedIn profile URL, bare slug, provider-id (ACoAAA...), or member URN (urn:li:member:<id>). URL and slug inputs resolve the provider ID automatically.",
      required: true,
    },
    subject: { type: "string", description: "InMail subject line.", required: true },
    text: { type: "positional", stdinArg: true, description: "InMail body text. Pass - to read from stdin." },
  },
  async run({ args }) {
    const flags = args as MessageFlags;
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
    await runMessageInMail(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

/**
 * `message send <chat_id> "<text>" [--attach <file>...]`, the documented
 * explicit-verb form for sending a message to an existing chat.
 *
 * This is a registered `send` subcommand so that `message send <chat_id> <text>`
 * routes here (chat_id positional, not "send" as chat_id). The bare form
 * `message <chat_id> <text>` is preserved for back-compat via the parent
 * command's own run() handler.
 */
const messageSendCommand = defineCommand({
  meta: {
    name: "send",
    description:
      "Send a message to an existing chat. Pass a COMPANY_ chat id (from `curviate core inboxes chats`) to send " +
      "as that company page instead of yourself, no separate flag needed. The output shows the acting " +
      "identity: a company-page send prints \"Sent as <name> (company page)\", a personal send prints " +
      "nothing new. See also: `curviate core inboxes chats` (discover a COMPANY_ chat id) and the Reply as a company " +
      "page guide.",
    risk: "write",
    rules: {
      changes: "Sends the text into the chat, as you, or as the page for a COMPANY_ chat id.",
      visible_to: "The other participants of the chat.",
      budget_rows: ["messages_first_degree"],
      retry: "Not safe: requests carry no idempotency key, so a retry after a timeout can repeat it. Read `curviate core inbox messages <chat_id>` first.",
      undo: "`curviate core message delete <chat_id> <message_id>`; it may already have been read.",
    },
    errors: { ...AS_ACCOUNT, ...BUDGET, ...TARGET, RECIPIENT_UNREACHABLE: "LinkedIn will not let the Account message this person.", CHAT_NOT_VISIBLE: "the chat is not visible to the Account." },
    examples: [
      "curviate core message send 2-YTQ3ODU3Njgt \"Thanks, that makes sense.\"",
      "curviate core message send 2-YTQ3ODU3Njgt --share-post 7380123456789012345 \"This is the post I meant.\" --preview",
    ],
  },
  args: {
    // Write command: WRITE_FLAGS omits pagination/projection flags
    ...WRITE_FLAGS,
    chatId: {
      type: "positional",
      description:
        "Chat ID or LinkedIn messaging thread URL. A COMPANY_ chat id sends as the company page; any other " +
        "chat id sends as the connected member.",
    },
    text: { type: "positional", stdinArg: true, description: "Message text. Pass - to read from stdin (e.g. via heredoc or pipe)." },
    attach: { type: "string", description: "File to attach (repeatable). Not with --share-post or --share-job." },
    ...SHARE_ARGS,
  },
  async run({ args }) {
    const flags = args as MessageFlags;
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
    await runMessageSend(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const messageInMailBalanceCommand = defineCommand({
  meta: {
    name: "inmail-balance",
    description: "Get InMail credit balance.",
    risk: "read",
    examples: [
      "curviate core message inmail-balance",
    ],
  },
  args: {
    // Single-object read: READ_SINGLE_FLAGS omits pagination flags, keeps --fields
    ...readOnly(READ_SINGLE_FLAGS),
  },
  async run({ args }) {
    const flags = args as MessageFlags;
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
    await runMessageInMailBalance(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

/**
 * The subcommands `message` registers. Kept as a literal so the bare-form guard
 * and the usage block can both name them, and so a new subcommand cannot be
 * added to the tree without appearing in the diagnostic.
 */
const MESSAGE_SUBCOMMANDS = [
  "new",
  "send",
  "get",
  "edit",
  "delete",
  "react",
  "attachment",
  "inmail",
  "inmail-balance",
] as const;

const MESSAGE_USAGE =
  "Usage: curviate core message new --to <attendee>... \"<text>\" [--subject <s>] [--attach <file>... | --share-post <id> | --share-job <id>]\n" +
  "       curviate core message send <chat_id> \"<text>\" [--attach <file>... | --share-post <id> | --share-job <id>]\n" +
  "       curviate core message <chat_id> \"<text>\" [--attach <file>... | --share-post <id> | --share-job <id>]\n" +
  "       curviate core message get <chat_id> <message_id>\n" +
  "       curviate core message edit <chat_id> <message_id> \"<text>\"\n" +
  "       curviate core message delete <chat_id> <message_id>\n" +
  "       curviate core message react <chat_id> <message_id> <emoji>\n" +
  "       curviate core message attachment <chat_id> <message_id> <attachment_id> [-o <file>]\n" +
  "       curviate core message inmail --to <id> --subject <s> \"<text>\"\n" +
  "       curviate core message inmail-balance\n";

/**
 * Refuse to treat a command-shaped first positional as a chat id.
 *
 * The bare form `message <chat_id> "<text>"` SENDS. Without this check, any
 * unregistered subcommand fell through to it: `message search "sophie"` bound
 * `chatId="search"`, `text="sophie"` and sent. A chat id is always `2-<base64>`,
 * `COMPANY_<n>_<suffix>`, or a thread URL, never a lowercase word, so a
 * command-shaped token here is a mistake every time.
 *
 * Runs BEFORE any config resolution or client construction, so a rejected
 * invocation cannot make a network call at all.
 *
 * Exported for direct unit coverage.
 */
export function guardBareMessageForm(
  chatId: string,
  out: OutputStreams,
): void {
  if (!looksLikeCommandWord(chatId)) return;

  const suggestion = nearestSubcommand(chatId, [...MESSAGE_SUBCOMMANDS]);
  out.stderr.write(
    `error: \`${chatId}\` is not a curviate core message subcommand, and it is not a chat id ` +
      `(a chat id looks like 2-... or COMPANY_..., or a linkedin.com/messaging/thread/... URL).\n`,
  );
  if (suggestion) {
    out.stderr.write(`hint: did you mean \`curviate core message ${suggestion}\`?\n`);
  } else if (chatId === "search") {
    out.stderr.write("hint: to search your messages, use `curviate core inbox search`.\n");
  }
  out.stderr.write(
    `hint: to send to a chat id this check does not recognise, name the action explicitly: ` +
      `curviate core message send <chat_id> "<text>".\n`,
  );
  out.stderr.write(MESSAGE_USAGE);
  // Refusing is the point: nothing was sent.
  process.exit(2);
}

export const messageCommand = defineCommand({
  meta: {
    name: "message",
    description: DESCRIPTIONS.message,
    risk: "write",
    rules: {
      changes: "Sends the text into the chat, as you, or as the page for a COMPANY_ chat id.",
      visible_to: "The other participants of the chat.",
      budget_rows: ["messages_first_degree"],
      retry: "Not safe: requests carry no idempotency key, so a retry after a timeout can repeat it. Read `curviate core inbox messages <chat_id>` first.",
      undo: "`curviate core message delete <chat_id> <message_id>`; it may already have been read.",
    },
    errors: { ...AS_ACCOUNT, ...BUDGET, ...TARGET, RECIPIENT_UNREACHABLE: "LinkedIn will not let the Account message this person.", CHAT_NOT_VISIBLE: "the chat is not visible to the Account." },
    examples: [
      "curviate core message 2-YTQ3ODU3Njgt \"Thanks, that makes sense.\"",
      "curviate core message 2-YTQ3ODU3Njgt \"See the attached brief.\" --attach brief.pdf",
    ],
  },
  args: {
    // Write command (message send): WRITE_FLAGS omits pagination/projection flags
    ...WRITE_FLAGS,
    chatId: {
      type: "positional",
      description: "Chat ID to send a message to. A COMPANY_ chat id sends as the company page.",
      required: false,
    },
    text: { type: "positional", stdinArg: true, description: "Message text. Pass - to read from stdin.", required: false },
    attach: { type: "string", description: "File to attach (repeatable). Not with --share-post or --share-job." },
    ...SHARE_ARGS,
  },
  subCommands: {
    new: messageNewCommand,
    send: messageSendCommand,
    get: messageGetCommand,
    edit: messageEditCommand,
    delete: messageDeleteCommand,
    react: messageReactCommand,
    attachment: messageAttachmentCommand,
    inmail: messageInMailCommand,
    "inmail-balance": messageInMailBalanceCommand,
  },
  async run({ args }) {
    const flags = args as MessageFlags;
    const out = buildOutputStreams();

    if (!flags.chatId) {
      out.stderr.write(MESSAGE_USAGE);
      // <chat_id> is functionally required for the bare form, a missing
      // required positional is a usage error (exit 2), not a silent success.
      // `required: false` on the citty arg def exists only so this richer
      // usage block can run instead of citty's generic one-liner.
      process.exit(2);
    }

    // An unknown subcommand must never become a send. Checked against the
    // NORMALIZED id so a thread URL is judged on the chat id it carries, and
    // before any client exists so a refusal cannot make a network call.
    guardBareMessageForm(normalizeChatId(flags.chatId), out);

    const cfg = await resolveEffectiveConfig({
      apiKey: flags["api-key"],
      baseUrl: flags["base-url"],
      timeout: flags.timeout,
      account: flags.account,
      profile: flags.profile,
    });
    if (!cfg.apiKey) {
      out.stderr.write("error: no API key, run `curviate login` or pass --api-key.\n");
      process.exit(3);
    }
    const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeout: cfg.timeout });
    await runMessageSend(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});
