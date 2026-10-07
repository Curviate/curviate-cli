/**
 * `curviate draft`: stored, editable, unpublished posts, optionally scheduled
 * (root-scoped; methods live on `curviate.drafts.*`).
 *
 * Subcommands:
 *   draft list [--status] [--account] [--from] [--to] [--all]
 *   draft get <id>
 *   draft create ["<text>"] [--account] [--schedule-at] [--attach <file>...]
 *   draft update <id> [--text] [--account] [--schedule-at | --unschedule] [--attach <file>...]
 *   draft delete <id>
 *   draft publish <id>
 *
 * `--account` is never defaulted from config or "the only connected account":
 * a Draft with no account is valid, so an omitted flag means none.
 * `--schedule-at` is passed to the API unchanged (ISO 8601 with offset); the
 * API owns the bounds and answers with its own message.
 */

import { defineCommand } from "citty";
import { GLOBAL_FLAGS, READ_SINGLE_FLAGS, WRITE_SINGLE_FLAGS, readOnly } from "../lib/global-flags.js";
import { resolveEffectiveConfig } from "../lib/resolve.js";
import { createClient } from "../lib/client.js";
import { renderSuccess, renderError, renderUnexpectedError, writeNdjsonItem } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import {
  streamAll,
  pageDelayFromFlags,
  readCursorFlag,
  readMaxPagesFlag,
  readablePage,
  readableObject,
  rejectPaginationModifiersWithoutAll,
} from "../lib/paginate.js";
import { resolveTextOrStdin } from "../lib/stdin.js";
import { readAttachment, AttachError, toAttachmentPayload, guessContentType } from "../lib/attach.js";
import { basename } from "node:path";
import type { Curviate, CurviateError, DraftAttachmentContentType } from "@curviate/sdk";

/** A file up to this size may ride inline (base64) in create/update. Mirrors the API's `/posts` cap. */
export const INLINE_FILE_BYTES = 5 * 1024 * 1024;
/** An image over this is refused by the API on every route, so the CLI refuses it before creating anything. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** The JSON body an inline create/update may carry, base64 included. Mirrors the API. */
export const INLINE_BODY_BYTES = 9 * 1024 * 1024;

const LIST_STATUSES = ["draft", "scheduled", "failed", "published"];

type DraftFlags = {
  id?: string;
  text?: string;
  status?: string;
  account?: string;
  from?: string;
  to?: string;
  order?: string;
  "schedule-at"?: string;
  unschedule?: boolean;
  attach?: string | string[];
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

function resolveOutputOpts(flags: DraftFlags) {
  return {
    json: (flags.json ?? false) || !process.stdout.isTTY,
    isTTY: process.stdout.isTTY ?? false,
    fields: flags.fields,
  };
}

function rejectAllOnNonPaginated(all: boolean | undefined, out: OutputStreams): void {
  if (all) {
    out.stderr.write("error: --all is not supported on non-paginated commands.\n");
    process.exit(2);
  }
}

async function handleError(err: unknown, outOpts: ReturnType<typeof resolveOutputOpts>, out: OutputStreams): Promise<never> {
  const { CurviateError } = await import("@curviate/sdk");
  if (err instanceof CurviateError) {
    const { getExitCode } = await import("../lib/exit-codes.js");
    renderError(err as CurviateError, outOpts, out);
    process.exit(getExitCode(err));
  }
  renderUnexpectedError(err, out);
  process.exit(1);
}

/** `--account ""` is a value, not an omission: refuse it rather than create an accountless Draft. */
function readAccount(flags: DraftFlags, out: OutputStreams): string | undefined {
  if (flags.account === undefined) return undefined;
  if (flags.account.trim() === "") {
    out.stderr.write("error: --account was given an empty value. Pass an acc_... id, or omit the flag for a Draft with no account.\n");
    process.exit(2);
  }
  return flags.account;
}

/** `--schedule-at` and `--unschedule` together are contradictory. The time itself is passed through unchanged. */
function readSchedule(flags: DraftFlags, out: OutputStreams): { scheduled_at?: string | null } {
  if (flags["schedule-at"] !== undefined && flags.unschedule) {
    out.stderr.write("error: --schedule-at and --unschedule cannot be combined.\n");
    process.exit(2);
  }
  if (flags["schedule-at"] !== undefined) {
    if (flags["schedule-at"].trim() === "") {
      out.stderr.write("error: --schedule-at was given an empty value. Pass an ISO 8601 time with an offset, e.g. 2026-10-12T09:00:00+02:00, or use --unschedule.\n");
      process.exit(2);
    }
    return { scheduled_at: flags["schedule-at"] };
  }
  if (flags.unschedule) return { scheduled_at: null };
  return {};
}

function attachPaths(attach: string | string[] | undefined): string[] {
  if (!attach) return [];
  return Array.isArray(attach) ? attach : [attach];
}

type LoadedFile = { path: string; buf: Buffer };

async function loadFiles(paths: string[], out: OutputStreams): Promise<LoadedFile[]> {
  try {
    return await Promise.all(paths.map(async (path) => ({ path, buf: await readAttachment(path) })));
  } catch (err) {
    if (err instanceof AttachError) {
      out.stderr.write(`error: ${err.message}\n`);
      process.exit(err.exitCode);
    }
    throw err;
  }
}

/**
 * An image over MAX_IMAGE_BYTES would be refused by the API after the Draft already exists
 * (create, then a 413 on upload), and a retry would then make a second Draft. Refuse it first.
 */
function refuseOversizeImages(files: LoadedFile[], out: OutputStreams): void {
  for (const f of files) {
    if (guessContentType(f.path).startsWith("image/") && f.buf.byteLength > MAX_IMAGE_BYTES) {
      out.stderr.write(
        `error: ${basename(f.path)} is an image over 5 MiB (${f.buf.byteLength} bytes). Images are capped at 5 MiB; resize it. Nothing was sent.\n`,
      );
      process.exit(2);
    }
  }
}

/**
 * Split files into an inline prefix and an upload tail. A file is inline while
 * it is at most INLINE_FILE_BYTES and the base64 body so far stays within
 * INLINE_BODY_BYTES; from the first file that is not, every later file uploads,
 * so the attachments keep the order the caller gave them.
 */
export function planAttachments(files: LoadedFile[]): { inline: LoadedFile[]; upload: LoadedFile[] } {
  let bodyBytes = 0;
  let i = 0;
  for (; i < files.length; i++) {
    const size = files[i]!.buf.byteLength;
    const encoded = Math.ceil(size / 3) * 4;
    if (size > INLINE_FILE_BYTES || bodyBytes + encoded > INLINE_BODY_BYTES) break;
    bodyBytes += encoded;
  }
  return { inline: files.slice(0, i), upload: files.slice(i) };
}

function previewAttachments(files: LoadedFile[]) {
  return files.map((f) => ({ name: basename(f.path), buffer: f.buf }));
}

async function uploadAll(
  client: Curviate,
  draftId: string,
  files: LoadedFile[],
  out: OutputStreams,
): Promise<unknown> {
  let last: unknown;
  for (const f of files) {
    try {
      last = await client.drafts.uploadAttachment(draftId, f.buf, {
        filename: basename(f.path),
        contentType: guessContentType(f.path) as DraftAttachmentContentType,
      });
    } catch (err) {
      out.stderr.write(`error: uploading ${basename(f.path)} to draft ${draftId} failed; the Draft exists with the files before it. Fix the cause and add the rest with \`curviate draft update ${draftId} --attach <file>\`.\n`);
      throw err; // the caller's catch renders it
    }
  }
  return last;
}

// ---------------------------------------------------------------------------
// Run functions
// ---------------------------------------------------------------------------

/** `draft list`: Drafts, and with `--status published` publish records. */
export async function runDraftList(client: Curviate, flags: DraftFlags, out: OutputStreams): Promise<void> {
  rejectPaginationModifiersWithoutAll(flags, out);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = readMaxPagesFlag(flags, out);
  const cursor = readCursorFlag(flags, out);

  const params: Record<string, unknown> = {};
  if (flags.status !== undefined) {
    const status = flags.status.split(",").map((s) => s.trim()).filter(Boolean);
    const bad = status.filter((s) => !LIST_STATUSES.includes(s));
    if (status.length === 0 || bad.length > 0) {
      out.stderr.write(`error: --status takes a comma list of ${LIST_STATUSES.join(", ")}${bad.length ? `. Got: ${bad.join(", ")}` : ""}.\n`);
      process.exit(2);
    }
    params["status"] = status;
  }
  const account = readAccount(flags, out);
  if (account !== undefined) params["account_id"] = account;
  if (flags.from !== undefined) params["from"] = flags.from;
  if (flags.to !== undefined) params["to"] = flags.to;
  if (flags.order !== undefined) {
    if (flags.order !== "asc" && flags.order !== "desc") {
      out.stderr.write("error: --order takes asc or desc.\n");
      process.exit(2);
    }
    params["order"] = flags.order;
  }
  if (flags.limit !== undefined) params["limit"] = parseInt(flags.limit, 10);
  if (cursor) params["cursor"] = cursor;

  try {
    if (all) {
      const fn = (p: Record<string, unknown>) =>
        client.drafts.list(p as Parameters<Curviate["drafts"]["list"]>[0]) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, params, { maxPages, out, pageDelayMs: pageDelayFromFlags(flags) })) {
        writeNdjsonItem(out, item, outOpts.fields);
      }
    } else {
      const result = await client.drafts.list(params as Parameters<Curviate["drafts"]["list"]>[0]);
      readablePage(result);
      renderSuccess(result, outOpts, out);
    }
  } catch (err) {
    await handleError(err, outOpts, out);
  }
}

/** `draft get <id>`. */
export async function runDraftGet(client: Curviate, flags: DraftFlags, out: OutputStreams): Promise<void> {
  rejectAllOnNonPaginated(flags.all, out);
  const outOpts = resolveOutputOpts(flags);
  try {
    const result = await client.drafts.get(flags.id ?? "");
    readableObject(result);
    renderSuccess(result, outOpts, out);
  } catch (err) {
    await handleError(err, outOpts, out);
  }
}

/** `draft create ["<text>"] [--account] [--schedule-at] [--attach <file>...]`. */
export async function runDraftCreate(
  client: Curviate,
  flags: DraftFlags,
  out: OutputStreams,
  readStdin?: () => Promise<string>,
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags.unschedule) {
    out.stderr.write("error: --unschedule applies to `draft update`; a new Draft is unscheduled unless you pass --schedule-at.\n");
    process.exit(2);
  }
  const account = readAccount(flags, out);
  if (account !== undefined) body["account_id"] = account;
  if (flags.text !== undefined) body["text"] = await resolveTextOrStdin(flags.text, out, readStdin);
  Object.assign(body, readSchedule(flags, out));

  const files = await loadFiles(attachPaths(flags.attach), out);
  refuseOversizeImages(files, out);
  const { inline, upload } = planAttachments(files);
  if (inline.length > 0) body["attachments"] = inline.map((f) => toAttachmentPayload(f.path, f.buf));

  const outOpts = resolveOutputOpts(flags);
  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "drafts.create",
      args: {},
      body: { ...body, attachments: undefined },
      attachments: previewAttachments(inline),
    });
    out.stdout.write(JSON.stringify({ ...preview, ...(upload.length ? { uploads: upload.map((f) => `${basename(f.path)} (${f.buf.byteLength} bytes)`) } : {}) }) + "\n");
    return;
  }

  try {
    const created = (await client.drafts.create(body as Parameters<Curviate["drafts"]["create"]>[0])) as { id: string };
    const result = upload.length > 0 ? await uploadAll(client, created.id, upload, out) : created;
    renderSuccess(result, outOpts, out);
  } catch (err) {
    await handleError(err, outOpts, out);
  }
}

/** `draft update <id> [--text] [--account] [--schedule-at | --unschedule] [--attach <file>...]`. */
export async function runDraftUpdate(
  client: Curviate,
  flags: DraftFlags,
  out: OutputStreams,
  readStdin?: () => Promise<string>,
): Promise<void> {
  const id = flags.id ?? "";
  const body: Record<string, unknown> = {};
  const account = readAccount(flags, out);
  if (account !== undefined) body["account_id"] = account;
  if (flags.text !== undefined) body["text"] = await resolveTextOrStdin(flags.text, out, readStdin);
  Object.assign(body, readSchedule(flags, out));

  const files = await loadFiles(attachPaths(flags.attach), out);
  refuseOversizeImages(files, out);
  const { inline, upload } = planAttachments(files);

  const outOpts = resolveOutputOpts(flags);
  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "drafts.update",
      args: { id },
      body,
      attachments: previewAttachments(inline),
    });
    out.stdout.write(JSON.stringify({ ...preview, ...(upload.length ? { uploads: upload.map((f) => `${basename(f.path)} (${f.buf.byteLength} bytes)`) } : {}) }) + "\n");
    return;
  }

  try {
    if (inline.length > 0) {
      // `attachments` replaces the whole list, so keep what the Draft already has.
      const current = (await client.drafts.get(id)) as { attachments?: Array<{ id: string }> };
      body["attachments"] = [
        ...(current.attachments ?? []).map((a) => ({ id: a.id })),
        ...inline.map((f) => toAttachmentPayload(f.path, f.buf)),
      ];
    }
    let result: unknown = await client.drafts.update(id, body as Parameters<Curviate["drafts"]["update"]>[1]);
    if (upload.length > 0) result = await uploadAll(client, id, upload, out);
    renderSuccess(result, outOpts, out);
  } catch (err) {
    await handleError(err, outOpts, out);
  }
}

/** `draft delete <id>`. */
export async function runDraftDelete(client: Curviate, flags: DraftFlags, out: OutputStreams): Promise<void> {
  const id = flags.id ?? "";
  const outOpts = resolveOutputOpts(flags);
  if (flags.preview) {
    out.stdout.write(JSON.stringify(buildPreviewOutput({ method: "drafts.delete", args: { id }, body: {} })) + "\n");
    return;
  }
  try {
    const result = await client.drafts.delete(id);
    renderSuccess(result, outOpts, out);
  } catch (err) {
    await handleError(err, outOpts, out);
  }
}

/** `draft publish <id>`: publish now. */
export async function runDraftPublish(client: Curviate, flags: DraftFlags, out: OutputStreams): Promise<void> {
  const id = flags.id ?? "";
  const outOpts = resolveOutputOpts(flags);
  if (flags.preview) {
    out.stdout.write(JSON.stringify(buildPreviewOutput({ method: "drafts.publish", args: { id }, body: {} })) + "\n");
    return;
  }
  try {
    const result = await client.drafts.publish(id);
    renderSuccess(result, outOpts, out);
  } catch (err) {
    await handleError(err, outOpts, out);
  }
}

// ---------------------------------------------------------------------------
// citty definitions
// ---------------------------------------------------------------------------

async function withClient(
  flags: DraftFlags,
  fn: (client: Curviate, flags: DraftFlags, out: OutputStreams) => Promise<void>,
): Promise<void> {
  // No `account` here: a configured default account must not leak into a Draft.
  const cfg = await resolveEffectiveConfig({
    apiKey: flags["api-key"],
    baseUrl: flags["base-url"],
    timeout: flags.timeout,
    profile: flags.profile,
  });
  if (!cfg.apiKey) {
    process.stderr.write("error: no API key, run `curviate login` or pass --api-key.\n");
    process.exit(3);
  }
  const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeout: cfg.timeout });
  await fn(client, flags, buildOutputStreams());
}

const ACCOUNT_DESC =
  "Account the Draft publishes as (acc_...). Never defaulted: omit it for a Draft with no account yet.";
const SCHEDULE_DESC =
  "Publish at this time: ISO 8601 with an offset (e.g. 2026-10-12T09:00:00+02:00), passed through unchanged. " +
  "Between 5 minutes and 365 days ahead, at least 5 minutes from another scheduled Draft on the same account. Needs an account and text.";
const ATTACH_DESC =
  "File to attach, repeatable; keeps the order given. Files up to 5 MiB go inline, larger ones upload separately. " +
  "Up to 20 images (JPEG, PNG, GIF, WEBP, each up to 5 MiB), or one MP4 video, or one PDF (each up to 50 MiB), never mixed.";

const draftListCommand = defineCommand({
  meta: {
    name: "list",
    description:
      "List Drafts, newest first. With --status published it lists publish records instead (post id, account, time; never Drafts).",
    examples: [
      "curviate draft list",
      "curviate draft list --status scheduled --account acc_YOUR_ACCOUNT_ID --order asc",
      "curviate draft list --status scheduled,published --from 2026-10-01T00:00:00Z --to 2026-11-01T00:00:00Z",
    ],
  },
  args: {
    ...readOnly(GLOBAL_FLAGS),
    status: { type: "string", description: "Comma list of draft, scheduled, failed, published (default draft,scheduled,failed)." },
    account: { type: "string", description: "Only this account's items (acc_...), or none for Drafts with no account. Omit for all of yours." },
    from: { type: "string", description: "Only items dated at or after this ISO 8601 time (each item's own date: scheduled_at, failure.failed_at, published_at or updated_at)." },
    to: { type: "string", description: "Only items dated before this ISO 8601 time (exclusive)." },
    order: { type: "string", description: "desc (default) or asc, by the item's own date." },
  },
  async run({ args }) {
    await withClient(args as DraftFlags, runDraftList);
  },
});

const draftGetCommand = defineCommand({
  meta: {
    name: "get",
    description: "Get one Draft, with a fresh signed link (valid 1 hour) for each attachment.",
    examples: ["curviate draft get drf_YOUR_DRAFT_ID"],
  },
  args: {
    ...readOnly(READ_SINGLE_FLAGS),
    id: { type: "positional", description: "Draft id (drf_...)." },
  },
  async run({ args }) {
    await withClient(args as DraftFlags, runDraftGet);
  },
});

const draftCreateCommand = defineCommand({
  meta: {
    name: "create",
    description:
      "Store a Draft. Every part is optional. With --schedule-at (and an account and text) Curviate publishes it at that time. " +
      "Up to 50 Drafts and 2 GiB of media per account, and per no-account. A retry creates a second Draft.",
    examples: [
      "curviate draft create \"Three things we learned shipping our first agent integration.\"",
      "curviate draft create \"Launch day.\" --account acc_YOUR_ACCOUNT_ID --schedule-at 2026-10-12T09:00:00+02:00",
      "curviate draft create \"Demo.\" --account acc_YOUR_ACCOUNT_ID --attach screenshot.png",
    ],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    text: { type: "positional", required: false, stdinArg: true, description: "Post text (up to 3000 characters). Pass - to read from stdin." },
    account: { type: "string", description: ACCOUNT_DESC },
    "schedule-at": { type: "string", description: SCHEDULE_DESC },
    attach: { type: "string", description: ATTACH_DESC },
  },
  async run({ args }) {
    await withClient(args as DraftFlags, runDraftCreate);
  },
});

const draftUpdateCommand = defineCommand({
  meta: {
    name: "update",
    description:
      "Change a Draft: only the parts you pass change. --attach appends files; --schedule-at schedules or reschedules, --unschedule cancels. " +
      "Any update to a failed Draft clears its failure. A Draft being published answers DRAFT_PUBLISHING: read it again in a few seconds.",
    examples: [
      "curviate draft update drf_YOUR_DRAFT_ID --text \"New wording.\"",
      "curviate draft update drf_YOUR_DRAFT_ID --schedule-at 2026-10-12T09:00:00+02:00",
      "curviate draft update drf_YOUR_DRAFT_ID --unschedule",
    ],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    id: { type: "positional", description: "Draft id (drf_...)." },
    text: { type: "string", stdinArg: true, description: "Replace the text (up to 3000 characters). Pass - to read from stdin." },
    account: { type: "string", description: "Move the Draft to another of your accounts (acc_...)." },
    "schedule-at": { type: "string", description: SCHEDULE_DESC },
    unschedule: { type: "boolean", description: "Cancel the schedule; the Draft stays a Draft." },
    attach: { type: "string", description: ATTACH_DESC },
  },
  async run({ args }) {
    await withClient(args as DraftFlags, runDraftUpdate);
  },
});

const draftDeleteCommand = defineCommand({
  meta: {
    name: "delete",
    description: "Delete a Draft and its stored media.",
    examples: ["curviate draft delete drf_YOUR_DRAFT_ID"],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    id: { type: "positional", description: "Draft id (drf_...)." },
  },
  async run({ args }) {
    await withClient(args as DraftFlags, runDraftDelete);
  },
});

const draftPublishCommand = defineCommand({
  meta: {
    name: "publish",
    description:
      "Publish a Draft now, under the same rules and safety limits as `post create`. Success deletes the Draft and prints the post id; a known failure leaves the Draft unchanged. " +
      "If the error says the outcome is unknown, the post may be live: check the account's posts before retrying.",
    examples: ["curviate draft publish drf_YOUR_DRAFT_ID"],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    id: { type: "positional", description: "Draft id (drf_...)." },
  },
  async run({ args }) {
    await withClient(args as DraftFlags, runDraftPublish);
  },
});

export const draftCommand = defineCommand({
  meta: { name: "draft", description: "Drafts and scheduled posts." },
  subCommands: {
    list: draftListCommand,
    get: draftGetCommand,
    create: draftCreateCommand,
    update: draftUpdateCommand,
    delete: draftDeleteCommand,
    publish: draftPublishCommand,
  },
  async run() {
    process.stderr.write(
      "Usage: curviate draft <subcommand>\n" +
        "  list | get <id> | create [\"<text>\"] | update <id> | delete <id> | publish <id>\n",
    );
  },
});
