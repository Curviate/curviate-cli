/**
 * `curviate sales-nav` — Sales Navigator operations (tier: sn).
 *
 * Subcommands:
 *   sales-nav search people [--keywords <k>] [--all] [--limit] [--cursor]        — search people (POST)
 *   sales-nav search companies [--keywords <k>] [--all] [--limit] [--cursor]     — search companies (POST)
 *   sales-nav search parameters --type <t>                                        — get filter parameters (read)
 *   sales-nav message new --to <id> "<text>" [--attach <f>…] [--voice <f>] [--video <f>] — start chat (write, multipart)
 *   sales-nav profile <identifier>                                                — get profile (read, resolveIdentifier)
 *   sales-nav save-lead --list <id> <user_id>                                     — save lead into a list (write, v2)
 *
 * v2 list surface:
 *   sales-nav account-lists --account <id> [--all] [--limit] [--cursor]                              — list account lists (read)
 *   sales-nav lead-lists --account <id> [--all] [--limit] [--cursor]                                  — list lead lists (read)
 *   sales-nav browse-account-list <list_id> --account <id> [--filter --sort-by --sort-order]          — browse an account list (read)
 *   sales-nav browse-lead-list <list_id> --account <id> [--spotlight --sort-by --sort-order]          — browse a lead list (read)
 *   sales-nav save-account --list <id> <company_id> --account <id>                                    — save a company into a list (write)
 *
 * All subcommands are account-scoped.
 * Tier-gate: CLI never pre-checks — SDK call goes out; TIER_NOT_ACTIVE / LINKEDIN_FEATURE_NOT_SUBSCRIBED → exit 5.
 * Identifier resolution: applied to `profile <identifier>` only; user_id/company_id/list_id pass verbatim.
 *
 * BREAKING (2026-07-04): `save-lead` re-signed for the v2 save-lead surface —
 * the old `save-lead <user_id> [--list-id <id>]` (optional list) is retired,
 * no alias. The v2 op always saves into a specific list, so `--list` is now
 * required and the flag is renamed from `--list-id`.
 */

import { defineCommand } from "citty";
import { GLOBAL_FLAGS, WRITE_FLAGS, READ_SINGLE_FLAGS } from "../lib/global-flags.js";
import { resolveIdentifier } from "../lib/identifier.js";
import { resolveEffectiveConfig } from "../lib/resolve.js";
import { createClient } from "../lib/client.js";
import { renderSuccess, renderError, renderUnexpectedError } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { streamAll, pageDelayFromFlags } from "../lib/paginate.js";
import { readAttachment, AttachError, toAttachmentPayload } from "../lib/attach.js";
import {
  assembleFilters,
  splitCsv,
  splitCsvNumbers,
  DEFAULT_FILTER_READERS,
  type FilterReaders,
} from "../lib/search-filters.js";
import type { Curviate, CurviateError, paths } from "@curviate/sdk";

/** `GET /v1/{account_id}/sales-navigator/search/parameters` query — `type` required, `keywords` optional. */
type SNGetParametersQuery = paths["/v1/{account_id}/sales-navigator/search/parameters"]["get"]["parameters"]["query"];
/** `POST /v1/{account_id}/sales-navigator/search` body — `url` is the only accepted field. */
type SNSearchFromUrlBody = paths["/v1/{account_id}/sales-navigator/search"]["post"]["requestBody"]["content"]["application/json"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SalesNavFlags = {
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
  // Subcommand-specific
  to?: string;
  text?: string;
  subject?: string;
  attach?: string | string[];
  voice?: string;
  video?: string;
  type?: string;
  keywords?: string;
  url?: string;
  // search filter escape hatch + curated named flags
  filters?: string;
  "filters-file"?: string;
  "first-name"?: string;
  "last-name"?: string;
  groups?: string;
  "profile-language"?: string;
  technologies?: string;
  "recent-activities"?: string;
  "network-distance"?: string;
  identifier?: string;
  userId?: string;
  // v2 list surface
  listId?: string;
  companyId?: string;
  list?: string;
  filter?: string;
  spotlight?: string;
  "sort-by"?: string;
  "sort-order"?: string;
};

type OutputStreams = {
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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

function resolveOutputOpts(flags: SalesNavFlags) {
  return {
    json: (flags.json ?? false) || !process.stdout.isTTY,
    isTTY: process.stdout.isTTY ?? false,
    fields: flags.fields,
  };
}

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
 * Run `sales-nav search people [filters…]`.
 * POST search — read-classified (returns data), rejects --preview.
 * Supports --all / --limit / --cursor pagination.
 */
export async function runSalesNavSearchPeople(
  client: Curviate,
  flags: SalesNavFlags,
  out: OutputStreams,
  readers: FilterReaders = DEFAULT_FILTER_READERS,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = requireAccount(flags.account, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
  const limit = flags.limit ? parseInt(flags.limit, 10) : undefined;
  const cursor = flags.cursor;

  // --filters base body, then --keywords and the curated named flags over it.
  // The rich Sales Navigator filters are mostly nested objects, reachable via --filters.
  const assembled = await assembleFilters(flags, readers);
  if ("error" in assembled) {
    out.stderr.write(`error: ${assembled.error}\n`);
    process.exit(2);
  }
  const body = assembled.body;
  if (flags.keywords) body["keywords"] = flags.keywords;
  if (flags["first-name"]) body["first_name"] = flags["first-name"];
  if (flags["last-name"]) body["last_name"] = flags["last-name"];
  if (flags.groups) body["groups"] = splitCsv(flags.groups);
  if (flags["profile-language"]) body["profile_language"] = splitCsv(flags["profile-language"]);

  const params: Record<string, unknown> = {};
  if (limit !== undefined) params["limit"] = limit;
  if (cursor) params["cursor"] = cursor;

  try {
    if (all) {
      const fn = (p: Record<string, unknown>) => {
        const mergedBody = { ...body };
        // Extract pagination params from the merged params
        const { cursor: c, limit: l, ...restP } = p;
        const callParams: Record<string, unknown> = {};
        if (c) callParams["cursor"] = c;
        if (l) callParams["limit"] = l;
        void restP;
        return ns.salesNavigator.searchPeople(mergedBody, callParams) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      };
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.salesNavigator.searchPeople(body, Object.keys(params).length > 0 ? params : undefined);
      renderSuccess(result, outOpts, out);
    }
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `sales-nav search companies [filters…]`.
 * POST search — read-classified, rejects --preview.
 * Supports --all / --limit / --cursor pagination.
 */
export async function runSalesNavSearchCompanies(
  client: Curviate,
  flags: SalesNavFlags,
  out: OutputStreams,
  readers: FilterReaders = DEFAULT_FILTER_READERS,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = requireAccount(flags.account, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
  const limit = flags.limit ? parseInt(flags.limit, 10) : undefined;
  const cursor = flags.cursor;

  // --filters base body, then --keywords and the curated named flags over it.
  const assembled = await assembleFilters(flags, readers);
  if ("error" in assembled) {
    out.stderr.write(`error: ${assembled.error}\n`);
    process.exit(2);
  }
  const body = assembled.body;
  if (flags.keywords) body["keywords"] = flags.keywords;
  if (flags.technologies) body["technologies"] = splitCsv(flags.technologies);
  if (flags["recent-activities"]) body["recent_activities"] = splitCsv(flags["recent-activities"]);
  if (flags["network-distance"]) body["network_distance"] = splitCsvNumbers(flags["network-distance"]);

  const params: Record<string, unknown> = {};
  if (limit !== undefined) params["limit"] = limit;
  if (cursor) params["cursor"] = cursor;

  try {
    if (all) {
      const fn = (p: Record<string, unknown>) => {
        const mergedBody = { ...body };
        const { cursor: c, limit: l, ...restP } = p;
        const callParams: Record<string, unknown> = {};
        if (c) callParams["cursor"] = c;
        if (l) callParams["limit"] = l;
        void restP;
        return ns.salesNavigator.searchCompanies(mergedBody, callParams) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      };
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.salesNavigator.searchCompanies(body, Object.keys(params).length > 0 ? params : undefined);
      renderSuccess(result, outOpts, out);
    }
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `sales-nav search parameters --type <t>`.
 * Read command — rejects --preview.
 */
export async function runSalesNavGetParameters(
  client: Curviate,
  flags: SalesNavFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  if (!flags.type) {
    out.stderr.write("error: --type is required.\n");
    process.exit(2);
  }

  const accountId = requireAccount(flags.account, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  // `type` is a free-form CLI string flag validated against the served enum
  // server-side — a narrow cast here is the pragmatic alternative to
  // hand-duplicating the enum union client-side.
  const params: SNGetParametersQuery = { type: flags.type as SNGetParametersQuery["type"] };
  if (flags.keywords) params.keywords = flags.keywords;
  if (flags.limit) params.limit = parseInt(flags.limit, 10);

  try {
    const result = await ns.salesNavigator.getParameters(params);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `sales-nav search <url> [--all] [--limit] [--cursor]`.
 * Read command — rejects --preview. Paginated. Runs a pasted Sales Navigator
 * search/list URL directly; the response is polymorphic (discriminated by
 * its own `object`) and rendered verbatim, no client-side branching.
 */
export async function runSalesNavSearchFromUrl(
  client: Curviate,
  flags: SalesNavFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = requireAccount(flags.account, out);
  const url = flags.url ?? "";
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
  const limit = flags.limit ? parseInt(flags.limit, 10) : undefined;
  const cursor = flags.cursor;

  const body: SNSearchFromUrlBody = { url };
  const params: Record<string, unknown> = {};
  if (limit !== undefined) params["limit"] = limit;
  if (cursor) params["cursor"] = cursor;

  try {
    if (all) {
      const fn = (p: Record<string, unknown>) => {
        const { cursor: c, limit: l, ...restP } = p;
        const callParams: Record<string, unknown> = {};
        if (c) callParams["cursor"] = c;
        if (l) callParams["limit"] = l;
        void restP;
        return ns.salesNavigator.searchFromUrl(body, callParams) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      };
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.salesNavigator.searchFromUrl(body, Object.keys(params).length > 0 ? params : undefined);
      renderSuccess(result, outOpts, out);
    }
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `sales-nav message new --to <id> --subject <s> "<text>" [--attach <f>…] [--voice <f>] [--video <f>]`.
 * Write command — supports --preview.
 *
 * v2: JSON-only (no multipart); `subject` is REQUIRED (unlike the classic
 * messaging surface, where it's optional). There is no separate
 * voice_message/video_message body field — every attachment (file, voice,
 * or video) rides the single `attachments[]` array as a base64 object;
 * voice/video use `send_mode: "native"` for a platform-native bubble
 * (`metadata.duration` is not computed client-side and is left unset).
 */
export async function runSalesNavMessageNew(
  client: Curviate,
  flags: SalesNavFlags,
  out: OutputStreams,
): Promise<void> {
  const accountId = requireAccount(flags.account, out);
  const to = flags.to ?? "";
  const text = flags.text ?? "";
  const subject = flags.subject ?? "";
  const attachPaths = normalizeAttachPaths(flags.attach);
  const voicePath = flags.voice;
  const videoPath = flags.video;

  if (!subject) {
    out.stderr.write("error: --subject is required (v2: REQUIRED for Sales Navigator messaging).\n");
    process.exit(2);
  }

  // Load all file attachments before preview or SDK call.
  let attachBuffers: Buffer[] = [];
  let voiceBuffer: Buffer | undefined;
  let videoBuffer: Buffer | undefined;

  try {
    attachBuffers = await Promise.all(attachPaths.map((p) => readAttachment(p)));
    if (voicePath) voiceBuffer = await readAttachment(voicePath);
    if (videoPath) videoBuffer = await readAttachment(videoPath);
  } catch (err: unknown) {
    if (err instanceof AttachError) {
      out.stderr.write(`error: ${err.message}\n`);
      process.exit(err.exitCode);
    }
    throw err;
  }

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "salesNavigator.startChat",
      args: { attendees_ids: [to] },
      body: { attendees_ids: [to], text, subject },
      account: accountId,
      attachments: [
        ...attachBuffers.map((buf, i) => ({
          name: attachPaths[i] ? (attachPaths[i].split("/").pop() ?? attachPaths[i]) : `attachment_${i}`,
          buffer: buf,
        })),
        ...(voiceBuffer ? [{ name: voicePath ? (voicePath.split("/").pop() ?? voicePath) : "voice", buffer: voiceBuffer }] : []),
        ...(videoBuffer ? [{ name: videoPath ? (videoPath.split("/").pop() ?? videoPath) : "video", buffer: videoBuffer }] : []),
      ],
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const attachments = [
    ...attachPaths.map((p, i) => toAttachmentPayload(p, attachBuffers[i]!)),
    ...(voiceBuffer && voicePath ? [{ ...toAttachmentPayload(voicePath, voiceBuffer), send_mode: "native" as const }] : []),
    ...(videoBuffer && videoPath ? [{ ...toAttachmentPayload(videoPath, videoBuffer), send_mode: "native" as const }] : []),
  ];

  const body = {
    attendees_ids: [to],
    text,
    subject,
    ...(attachments.length > 0 ? { attachments } : {}),
  };

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.salesNavigator.startChat(body);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `sales-nav profile <identifier>`.
 * Read command — rejects --preview. Identifier resolved via resolveIdentifier.
 */
export async function runSalesNavProfile(
  client: Curviate,
  flags: SalesNavFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = requireAccount(flags.account, out);
  const rawId = flags.identifier ?? "";
  const resolvedId = resolveIdentifier(rawId);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.salesNavigator.getProfile(resolvedId, {});
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `sales-nav save-lead --list <id> <user_id>`.
 * Write command — supports --preview. user_id passes verbatim (NOT URL-resolved).
 *
 * BREAKING (2026-07-04): re-signed for the v2 save-lead surface — `--list` is
 * now required (v2 always saves into a specific list; the v1 optional
 * `--list-id` semantics do not exist in v2).
 */
export async function runSalesNavSaveLead(
  client: Curviate,
  flags: SalesNavFlags,
  out: OutputStreams,
): Promise<void> {
  const accountId = requireAccount(flags.account, out);
  const userId = flags.userId ?? "";
  const listId = flags.list ?? "";
  const outOpts = resolveOutputOpts(flags);

  const body: Record<string, unknown> = { user_id: userId };

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "salesNavigator.saveLead",
      args: { list_id: listId, user_id: userId },
      body,
      account: accountId,
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);

  try {
    const result = await ns.salesNavigator.saveLead({ list_id: listId, user_id: userId });
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

// ---------------------------------------------------------------------------
// v2 list surface — exported run functions
// ---------------------------------------------------------------------------

/**
 * Run `sales-nav account-lists --account <id> [--limit] [--cursor] [--all]`.
 * Read command — rejects --preview. Lists the operator's saved-account lists.
 */
export async function runSalesNavAccountLists(
  client: Curviate,
  flags: SalesNavFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = requireAccount(flags.account, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;

  const params: Record<string, unknown> = {};
  if (flags.limit) params["limit"] = parseInt(flags.limit, 10);
  if (flags.cursor) params["cursor"] = flags.cursor;

  try {
    if (all) {
      const fn = (p: Record<string, unknown>) =>
        ns.salesNavigator.accountLists(p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
      return;
    }
    const result = await ns.salesNavigator.accountLists(Object.keys(params).length > 0 ? params : undefined);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `sales-nav lead-lists --account <id> [--limit] [--cursor] [--all]`.
 * Read command — rejects --preview. Lists the operator's saved-lead lists.
 */
export async function runSalesNavLeadLists(
  client: Curviate,
  flags: SalesNavFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = requireAccount(flags.account, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;

  const params: Record<string, unknown> = {};
  if (flags.limit) params["limit"] = parseInt(flags.limit, 10);
  if (flags.cursor) params["cursor"] = flags.cursor;

  try {
    if (all) {
      const fn = (p: Record<string, unknown>) =>
        ns.salesNavigator.leadLists(p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
      return;
    }
    const result = await ns.salesNavigator.leadLists(Object.keys(params).length > 0 ? params : undefined);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `sales-nav browse-account-list <list_id> --account <id> [--filter --sort-by --sort-order] [--limit] [--cursor] [--all]`.
 * Read command (POST-with-body-filters) — rejects --preview.
 */
export async function runSalesNavBrowseAccountList(
  client: Curviate,
  flags: SalesNavFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = requireAccount(flags.account, out);
  const listId = flags.listId ?? "";
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;

  const body: Record<string, unknown> = {};
  if (flags.filter) body["filter"] = flags.filter;
  if (flags["sort-by"]) body["sort_by"] = flags["sort-by"];
  if (flags["sort-order"]) body["sort_order"] = flags["sort-order"];

  const params: Record<string, unknown> = {};
  if (flags.limit) params["limit"] = parseInt(flags.limit, 10);
  if (flags.cursor) params["cursor"] = flags.cursor;

  try {
    if (all) {
      const fn = (p: Record<string, unknown>) =>
        ns.salesNavigator.browseAccountList(listId, body, p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
      return;
    }
    const result = await ns.salesNavigator.browseAccountList(listId, body, Object.keys(params).length > 0 ? params : undefined);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `sales-nav browse-lead-list <list_id> --account <id> [--spotlight --sort-by --sort-order] [--limit] [--cursor] [--all]`.
 * Read command (POST-with-body-filters) — rejects --preview.
 */
export async function runSalesNavBrowseLeadList(
  client: Curviate,
  flags: SalesNavFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = requireAccount(flags.account, out);
  const listId = flags.listId ?? "";
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;

  const body: Record<string, unknown> = {};
  if (flags.spotlight) body["spotlight"] = flags.spotlight;
  if (flags["sort-by"]) body["sort_by"] = flags["sort-by"];
  if (flags["sort-order"]) body["sort_order"] = flags["sort-order"];

  const params: Record<string, unknown> = {};
  if (flags.limit) params["limit"] = parseInt(flags.limit, 10);
  if (flags.cursor) params["cursor"] = flags.cursor;

  try {
    if (all) {
      const fn = (p: Record<string, unknown>) =>
        ns.salesNavigator.browseLeadList(listId, body, p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
      return;
    }
    const result = await ns.salesNavigator.browseLeadList(listId, body, Object.keys(params).length > 0 ? params : undefined);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `sales-nav save-account --list <id> <company_id> --account <id>`.
 * Write command — supports --preview. company_id passes verbatim.
 */
export async function runSalesNavSaveAccount(
  client: Curviate,
  flags: SalesNavFlags,
  out: OutputStreams,
): Promise<void> {
  const accountId = requireAccount(flags.account, out);
  const listId = flags.list ?? "";
  const companyId = flags.companyId ?? "";
  const outOpts = resolveOutputOpts(flags);

  const body: Record<string, unknown> = { company_id: companyId };

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "salesNavigator.saveAccount",
      args: { list_id: listId, company_id: companyId },
      body,
      account: accountId,
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);

  try {
    const result = await ns.salesNavigator.saveAccount({ list_id: listId, company_id: companyId });
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

// ---------------------------------------------------------------------------
// Citty command definitions
// ---------------------------------------------------------------------------

const salesNavMessageNewCommand = defineCommand({
  meta: { name: "new", description: "Start a new Sales Navigator chat." },
  args: {
    // Write command: WRITE_FLAGS omits pagination/projection flags
    ...WRITE_FLAGS,
    to: {
      type: "string",
      description:
        "Recipient's LinkedIn provider ID (ACw… format, e.g. from a Sales Navigator search result or profile). Not resolved from a URL/slug. Pass the provider ID directly.",
      required: true,
    },
    subject: { type: "string", description: "Message subject line (required for Sales Navigator messaging).", required: true },
    text: { type: "positional", description: "Opening message text." },
    attach: { type: "string", description: "File to attach (repeatable, max 7 MiB each)." },
    voice: { type: "string", description: "Voice message file (max 7 MiB)." },
    video: { type: "string", description: "Video message file (max 7 MiB)." },
  },
  async run({ args }) {
    const flags = args as SalesNavFlags;
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
    await runSalesNavMessageNew(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const salesNavMessageCommand = defineCommand({
  meta: { name: "message", description: "Sales Navigator messaging operations." },
  args: { ...GLOBAL_FLAGS },
  subCommands: {
    new: salesNavMessageNewCommand,
  },
  async run() {
    process.stderr.write("Usage: curviate sales-nav message new --to <id> \"<text>\" [--attach <file>…]\n");
  },
});

const salesNavSearchPeopleCommand = defineCommand({
  meta: { name: "people", description: "Search Sales Navigator member profiles." },
  args: {
    ...GLOBAL_FLAGS,
    keywords: { type: "string", description: "Keyword search string." },
    filters: { type: "string", stdinArg: true, description: "Filter body as a JSON object (escape hatch for the full filter surface); '-' reads JSON from stdin." },
    "filters-file": { type: "string", description: "Path to a JSON file with the filter body." },
    "first-name": { type: "string", description: "First name to match." },
    "last-name": { type: "string", description: "Last name to match." },
    groups: { type: "string", description: "Group ids (comma-separated)." },
    "profile-language": { type: "string", description: "Profile language codes (comma-separated)." },
  },
  async run({ args }) {
    const flags = args as SalesNavFlags;
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
    await runSalesNavSearchPeople(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const salesNavSearchCompaniesCommand = defineCommand({
  meta: { name: "companies", description: "Search Sales Navigator companies." },
  args: {
    ...GLOBAL_FLAGS,
    keywords: { type: "string", description: "Keyword search string." },
    filters: { type: "string", stdinArg: true, description: "Filter body as a JSON object (escape hatch for the full filter surface); '-' reads JSON from stdin." },
    "filters-file": { type: "string", description: "Path to a JSON file with the filter body." },
    technologies: { type: "string", description: "Technology tags (comma-separated)." },
    "recent-activities": { type: "string", description: "Recent activity ids (comma-separated)." },
    "network-distance": { type: "string", description: "Network distance, 1-3 (comma-separated)." },
  },
  async run({ args }) {
    const flags = args as SalesNavFlags;
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
    await runSalesNavSearchCompanies(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const salesNavSearchParametersCommand = defineCommand({
  meta: { name: "parameters", description: "Resolve Sales Navigator filter parameter IDs." },
  args: {
    ...GLOBAL_FLAGS,
    type: {
      type: "string",
      description:
        "Parameter type to resolve. One of: GROUPS, SALES_INDUSTRY, DEPARTMENT, PERSONA, ACCOUNT_LISTS, LEAD_LISTS, TECHNOLOGIES, SAVED_ACCOUNTS, SAVED_SEARCHES, RECENT_SEARCHES, REGION, POSTAL_CODE.",
      required: true,
    },
    keywords: { type: "string", description: "Human term to resolve (e.g. Berlin)." },
  },
  async run({ args }) {
    const flags = args as SalesNavFlags;
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
    await runSalesNavGetParameters(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const salesNavSearchCommand = defineCommand({
  meta: { name: "search", description: "Sales Navigator search operations. Also runs a pasted Sales Navigator search/list URL directly." },
  args: {
    ...GLOBAL_FLAGS,
    url: {
      type: "positional",
      required: false,
      description: "A pasted Sales Navigator search or list URL. Runs it directly (salesNavigator.searchFromUrl).",
    },
  },
  subCommands: {
    people: salesNavSearchPeopleCommand,
    companies: salesNavSearchCompaniesCommand,
    parameters: salesNavSearchParametersCommand,
  },
  async run({ args }) {
    const flags = args as SalesNavFlags;

    // Bare form: `sales-nav search <url>` runs the URL directly. No url → print usage.
    if (!flags.url) {
      process.stderr.write(
        "Usage: curviate sales-nav search <url>\n" +
        "       curviate sales-nav search people [--keywords <k>]\n" +
        "       curviate sales-nav search companies [--keywords <k>]\n" +
        "       curviate sales-nav search parameters --type <t>\n",
      );
      return;
    }

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
    await runSalesNavSearchFromUrl(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const salesNavProfileCommand = defineCommand({
  meta: { name: "profile", description: "Get a Sales Navigator enriched member profile." },
  args: {
    // Single-object read: READ_SINGLE_FLAGS omits pagination flags, keeps --fields
    ...READ_SINGLE_FLAGS,
    identifier: { type: "positional", description: "LinkedIn URL, slug, or native id." },
  },
  async run({ args }) {
    const flags = args as SalesNavFlags;
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
    await runSalesNavProfile(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const salesNavSaveLeadCommand = defineCommand({
  meta: { name: "save-lead", description: "Save a Sales Navigator member into a lead list." },
  args: {
    // Write command: WRITE_FLAGS omits pagination/projection flags
    ...WRITE_FLAGS,
    userId: { type: "positional", description: "Sales Navigator member ID (ACw… format)." },
    list: { type: "string", description: "Lead list ID to save the member into (required; the v2 save always targets a specific list).", required: true },
  },
  async run({ args }) {
    const flags = args as SalesNavFlags;
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
    await runSalesNavSaveLead(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

// ---------------------------------------------------------------------------
// v2 list surface — citty command definitions
// ---------------------------------------------------------------------------

const salesNavAccountListsCommand = defineCommand({
  meta: { name: "account-lists", description: "List the saved-account (company) lists on the operator's Sales Navigator seat." },
  args: { ...GLOBAL_FLAGS },
  async run({ args }) {
    const flags = args as SalesNavFlags;
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
    await runSalesNavAccountLists(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const salesNavLeadListsCommand = defineCommand({
  meta: { name: "lead-lists", description: "List the saved-lead (member) lists on the operator's Sales Navigator seat." },
  args: { ...GLOBAL_FLAGS },
  async run({ args }) {
    const flags = args as SalesNavFlags;
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
    await runSalesNavLeadLists(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const salesNavBrowseAccountListCommand = defineCommand({
  meta: { name: "browse-account-list", description: "Browse the saved accounts (companies) in one account list." },
  args: {
    ...GLOBAL_FLAGS,
    listId: { type: "positional", description: "The account-list id (from `sales-nav account-lists`)." },
    filter: { type: "string", description: "Restrict to a saved-account subset: STARRED, GROWTH_ALERTS, or RISK_ALERTS." },
    "sort-by": { type: "string", description: "Sort field: DATE_ADDED or NAME. Defaults to NAME." },
    "sort-order": { type: "string", description: "Sort direction: ASCENDING or DESCENDING. Defaults to ASCENDING." },
  },
  async run({ args }) {
    const flags = args as SalesNavFlags;
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
    await runSalesNavBrowseAccountList(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const salesNavBrowseLeadListCommand = defineCommand({
  meta: { name: "browse-lead-list", description: "Browse the saved leads (members) in one lead list." },
  args: {
    ...GLOBAL_FLAGS,
    listId: { type: "positional", description: "The lead-list id (from `sales-nav lead-lists`)." },
    spotlight: { type: "string", description: "Restrict to a spotlighted lead subset: RECENT_POSITION_CHANGE, RECENTLY_POSTED_ON_LINKEDIN, FOLLOW_YOUR_COMPANY, or SHARE_EXPERIENCE." },
    "sort-by": { type: "string", description: "Sort field: DATE_ADDED, ACCOUNT, NAME, or OUTREACH_ACTIVITY. Defaults to DATE_ADDED." },
    "sort-order": { type: "string", description: "Sort direction: ASCENDING or DESCENDING. Defaults to DESCENDING." },
  },
  async run({ args }) {
    const flags = args as SalesNavFlags;
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
    await runSalesNavBrowseLeadList(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const salesNavSaveAccountCommand = defineCommand({
  meta: { name: "save-account", description: "Save a LinkedIn company into an account list." },
  args: {
    // Write command: WRITE_FLAGS omits pagination/projection flags
    ...WRITE_FLAGS,
    companyId: { type: "positional", description: "The LinkedIn company id to save into the account list." },
    list: { type: "string", description: "The target account-list id to save the company into (required).", required: true },
  },
  async run({ args }) {
    const flags = args as SalesNavFlags;
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
    await runSalesNavSaveAccount(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

export const salesNavCommand = defineCommand({
  meta: { name: "sales-nav", description: "Sales Navigator operations (requires the Sales Navigator add-on)." },
  args: { ...GLOBAL_FLAGS },
  subCommands: {
    message: salesNavMessageCommand,
    search: salesNavSearchCommand,
    profile: salesNavProfileCommand,
    "save-lead": salesNavSaveLeadCommand,
    "account-lists": salesNavAccountListsCommand,
    "lead-lists": salesNavLeadListsCommand,
    "browse-account-list": salesNavBrowseAccountListCommand,
    "browse-lead-list": salesNavBrowseLeadListCommand,
    "save-account": salesNavSaveAccountCommand,
  },
  async run() {
    process.stderr.write(
      "Usage: curviate sales-nav search people [--keywords <k>]\n" +
      "       curviate sales-nav search companies [--keywords <k>]\n" +
      "       curviate sales-nav search parameters --type <t>\n" +
      "       curviate sales-nav search <url>\n" +
      "       curviate sales-nav message new --to <id> \"<text>\"\n" +
      "       curviate sales-nav profile <identifier>\n" +
      "       curviate sales-nav save-lead --list <id> <user_id>\n" +
      "       curviate sales-nav account-lists --account <id>\n" +
      "       curviate sales-nav lead-lists --account <id>\n" +
      "       curviate sales-nav browse-account-list <list_id> --account <id>\n" +
      "       curviate sales-nav browse-lead-list <list_id> --account <id>\n" +
      "       curviate sales-nav save-account --list <id> <company_id> --account <id>\n",
    );
  },
});
