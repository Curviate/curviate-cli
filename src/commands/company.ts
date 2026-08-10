/**
 * `curviate company`, company profile + sub-resource reads + follow-invite write.
 *
 * Subcommands:
 *   company <id>: retrieve (routes to companies.get)
 *   company employees <id> [--keywords] [--location]: list employees (facade)
 *   company posts <id>: list posts (facade)
 *   company jobs <id> [--keywords]: list open jobs (facade)
 *   company invitable-followers <id> [--limit] [--cursor]: list invitable connections (facade)
 *   company follow-invite <id> --invitee <AC...> [...]: invite connections to follow (write)
 *   company reply <id> <chat_id> "<text>" [--attach]: reply as the page (write)
 *   company managed: list pages the account administers (read)
 *   company followers <id>: list a page's followers (read)
 *   company chats <id>: list a page's admin-inbox conversations (read, Beta)
 *   company chat <id> <chat_id>: get one admin-inbox conversation (read, Beta)
 *   company messages <id> <chat_id>: list a conversation's messages (read, Beta)
 *   company message <id> <chat_id> <message_id>: get one message (read, Beta)
 *   company search-chats <id> [<query>] [--topic] [--unread]: search/filter the admin inbox (read, Beta)
 *
 * All but `follow-invite`/`reply` are read commands: --preview is a usage
 * error (exit 2). `follow-invite` and `reply` are writes: --preview renders
 * the resolved request without sending.
 *
 * `company message` (GET one message) is distinct from `company reply`
 * (POST a reply, via companies.sendMessage); the SDK has two separate
 * company-inbox methods with adjacent names; do not confuse them.
 *
 * `reply` sends into an existing company-inbox conversation AS THE PAGE.
 * `<chat_id>` is the normal `2-...` conversation id from `company chats`. It
 * passes through verbatim (no client-side pre-check); the endpoint resolves
 * the page mailbox internally from the company identifier. Because a
 * `company reply` is always a page reply, --preview prints a "Will send as
 * company page <id>" notice derived from the identifier, and on a successful
 * send it prints the `sentAsNotice` acting-identity line (reused from
 * `message.ts`).
 *
 * Retrieve keeps its broader identifier contract (URL, slug, or numeric id,
 * `resolveIdentifier` handles company URLs). The sub-resource endpoints
 * require the company's NUMERIC provider_id, but the CLI accepts the same
 * broad identifier as the bare retrieve: a URL/slug is normalized then resolved
 * to the numeric id via `companies.get` (the `id` field the retrieve returns)
 * before the sub-resource call, so `company employees <slug>` works the same as
 * `company <slug>`. A numeric id passes straight through with no extra call; a
 * genuinely unresolvable identifier surfaces `companies.get`'s CurviateError.
 * `follow-invite` resolves the identifier the same way, even under --preview
 * (the preview renders the request that would actually be sent, the resolved
 * numeric id, not the raw slug/URL).
 *
 * citty 0.1.6 cannot express a node that mixes a bare positional (`company
 * <id>`) with `subCommands`, see src/dispatch.ts for the pre-router that
 * makes this coexistence work (first-token-is-a-known-subcommand -> descend;
 * otherwise -> run the bare form). This command relies on that dispatcher;
 * DO NOT invoke citty's own `runCommand`/`runMain` directly on this tree.
 */

import { requireAccount } from "../lib/account-arg.js";
import { defineCommand } from "citty";
import { GLOBAL_FLAGS, WRITE_FLAGS } from "../lib/global-flags.js";
import { streamAll, pageDelayFromFlags } from "../lib/paginate.js";
import { resolveIdentifier } from "../lib/identifier.js";
import { resolveEffectiveConfig } from "../lib/resolve.js";
import { createClient } from "../lib/client.js";
import { renderSuccess, renderError, renderUnexpectedError } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { resolveTextOrStdin } from "../lib/stdin.js";
import { readAttachment, AttachError, toAttachmentPayload } from "../lib/attach.js";
import { sentAsNotice } from "./message.js";
import {
  slimCompany,
  slimSearchPeople,
  slimSearchPosts,
  slimSearchJobs,
  slimCompanyInvitableFollowers,
  reencodeInvitableFollowers,
  reencodeInviteTokenItem,
} from "../lib/slim.js";
import type { Curviate, CurviateError } from "@curviate/sdk";

type CompanyFlags = {
  id?: string;
  account?: string;
  json?: boolean;
  fields?: string;
  preview?: boolean;
  all?: boolean;
  limit?: string;
  cursor?: string;
  "max-pages"?: string;
  "page-delay"?: string;
  "api-key"?: string;
  "base-url"?: string;
  timeout?: string;
  profile?: string;
  verbose?: boolean;
  sections?: string;
  keywords?: string;
  location?: string;
  invitee?: string | string[];
  chatId?: string;
  messageId?: string;
  text?: string;
  attach?: string | string[];
  // company search-chats
  query?: string;
  topic?: string;
  unread?: boolean;
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

function rejectPreviewOnRead(preview: boolean | undefined, out: OutputStreams): void {
  if (preview) {
    out.stderr.write("error: --preview is only valid on write commands (mutations). Reads just run.\n");
    process.exit(2);
  }
}

function resolveOutputOpts(flags: CompanyFlags) {
  return {
    json: (flags.json ?? false) || !process.stdout.isTTY,
    isTTY: process.stdout.isTTY ?? false,
    fields: flags.fields,
    verbose: flags.verbose ?? false,
  };
}

/**
 * Normalize the repeatable `--invitee` flag to an array of member ids.
 * citty 0.1.6 has no native array arg type; a `type: "string"` arg that is
 * passed more than once (`--invitee A --invitee B`) accumulates into a
 * string[] at the parser level, while a single occurrence stays a bare
 * string; this collapses both shapes to a string[] (empty when omitted).
 */
function normalizeInviteeIds(invitee: string | string[] | undefined): string[] {
  if (!invitee) return [];
  return Array.isArray(invitee) ? invitee : [invitee];
}

/** Normalize --attach flag to an array of paths (same shape as message.ts). */
function normalizeAttachPaths(attach: string | string[] | undefined): string[] {
  if (!attach) return [];
  return Array.isArray(attach) ? attach : [attach];
}

/**
 * Resolve a company identifier to the numeric provider_id the sub-resource
 * endpoints (employees/posts/jobs/invitable-followers/follow-invite) require.
 * A bare numeric id passes through with no extra call; a URL/slug/URN is
 * normalized then resolved via `companies.get`, mirroring how the bare
 * `company <slug>` retrieve auto-resolves, so `company employees acme` works
 * the same as `company acme`. A genuinely unresolvable identifier surfaces
 * `companies.get`'s own CurviateError (404 -> exit 4, 400 -> exit 2) to the
 * caller, which routes it through `handleSdkError`. Must be called inside
 * the handler's try block.
 */
async function resolveCompanyId(
  ns: ReturnType<Curviate["account"]>,
  raw: string,
): Promise<string> {
  const normalized = resolveIdentifier(raw);
  if (/^\d+$/.test(normalized)) return normalized;
  const company = await ns.companies.get(normalized);
  return String(company.id);
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
 * Run `company <id>`.
 * Routes to `companies.get(identifier)` (hard-moved from the retired
 * `profiles.getCompany`). `identifier` accepts a public handle or numeric id;
 * `resolveIdentifier` normalizes a full company URL to its slug; a bare
 * slug or numeric id passes through unchanged.
 */
export async function runCompanyGet(
  client: Curviate,
  flags: CompanyFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);
  if (flags.all) {
    out.stderr.write("error: --all is not supported on non-paginated commands.\n");
    process.exit(2);
  }
  if (flags.sections !== undefined) {
    out.stderr.write("error: --sections is not supported on company commands.\n");
    process.exit(2);
  }

  const accountId = await requireAccount(client, flags, out);
  const rawId = flags.id ?? "";
  const resolvedId = resolveIdentifier(rawId);

  const outOpts = { ...resolveOutputOpts(flags), slim: slimCompany };

  try {
    const result = await client.account(accountId).companies.get(resolvedId);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `company employees <id> [--keywords] [--location] [--limit] [--cursor] [--all]`.
 * A facade over people search with the company filter applied.
 * `<id>` accepts a URL/slug/numeric id, a URL/slug is resolved to the
 * numeric provider_id via companies.get before the sub-resource call.
 */
export async function runCompanyEmployees(
  client: Curviate,
  flags: CompanyFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = await requireAccount(client, flags, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  const params: Record<string, unknown> = {};
  if (flags.limit) params["limit"] = parseInt(flags.limit, 10);
  if (flags.cursor) params["cursor"] = flags.cursor;
  if (flags.keywords) params["keywords"] = flags.keywords;
  if (flags.location) params["location"] = flags.location;

  try {
    const identifier = await resolveCompanyId(ns, flags.id ?? "");
    if (flags.all) {
      const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
      const fn = (p: Record<string, unknown>) =>
        ns.companies.employees(identifier, p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
      return;
    }
    const result = await ns.companies.employees(identifier, params);
    renderSuccess(result, { ...outOpts, slim: slimSearchPeople }, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `company posts <id> [--limit] [--cursor] [--all]`.
 * A facade over posts search with the company filter applied. Post text
 * passes through verbatim (content pass-through, never stored).
 */
export async function runCompanyPosts(
  client: Curviate,
  flags: CompanyFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = await requireAccount(client, flags, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  const params: Record<string, unknown> = {};
  if (flags.limit) params["limit"] = parseInt(flags.limit, 10);
  if (flags.cursor) params["cursor"] = flags.cursor;

  try {
    const identifier = await resolveCompanyId(ns, flags.id ?? "");
    if (flags.all) {
      const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
      const fn = (p: Record<string, unknown>) =>
        ns.companies.posts(identifier, p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
      return;
    }
    const result = await ns.companies.posts(identifier, params);
    renderSuccess(result, { ...outOpts, slim: slimSearchPosts }, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `company jobs <id> [--keywords] [--limit] [--cursor] [--all]`.
 * A facade over jobs search with the company filter applied. An empty
 * `items[]` (no open postings) is a valid result, not an error.
 */
export async function runCompanyJobs(
  client: Curviate,
  flags: CompanyFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = await requireAccount(client, flags, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  const params: Record<string, unknown> = {};
  if (flags.limit) params["limit"] = parseInt(flags.limit, 10);
  if (flags.cursor) params["cursor"] = flags.cursor;
  if (flags.keywords) params["keywords"] = flags.keywords;

  try {
    const identifier = await resolveCompanyId(ns, flags.id ?? "");
    if (flags.all) {
      const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
      const fn = (p: Record<string, unknown>) =>
        ns.companies.jobs(identifier, p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
      return;
    }
    const result = await ns.companies.jobs(identifier, params);
    renderSuccess(result, { ...outOpts, slim: slimSearchJobs }, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `company invitable-followers <id> [--limit] [--cursor] [--all]`.
 * A facade over the connections eligible to be invited to follow the page,
 * the read that seeds `company follow-invite`. `<id>` accepts a URL/slug/
 * numeric id, resolved to the numeric provider_id via companies.get before
 * the sub-resource call, same as employees/posts/jobs. `invite_token` is
 * always re-encoded as base64 (raw bytes are JSON/terminal-unsafe), in
 * every output mode, including --verbose and --all/NDJSON.
 */
export async function runCompanyInvitableFollowers(
  client: Curviate,
  flags: CompanyFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = await requireAccount(client, flags, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  const params: Record<string, unknown> = {};
  if (flags.limit) params["limit"] = parseInt(flags.limit, 10);
  if (flags.cursor) params["cursor"] = flags.cursor;

  try {
    const identifier = await resolveCompanyId(ns, flags.id ?? "");
    if (flags.all) {
      const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
      const fn = (p: Record<string, unknown>) =>
        ns.companies.invitableFollowers(identifier, p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(reencodeInviteTokenItem(item as Record<string, unknown>)) + "\n");
      }
      return;
    }
    const result = await ns.companies.invitableFollowers(identifier, params);
    const safeResult = reencodeInvitableFollowers(result);
    renderSuccess(safeResult, { ...outOpts, slim: slimCompanyInvitableFollowers }, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `company follow-invite <id> --invitee <AC...> [--invitee <AC...> ...]`.
 * Write command, supports --preview. Invites one or more of the connected
 * account's 1st-degree connections (the `id` field from
 * `company invitable-followers`) to follow the administered page.
 * `<id>` accepts a URL/slug/numeric id, resolved to the numeric provider_id
 * the same way as the other company sub-resources, even under --preview,
 * so the preview renders the actual request that would be sent.
 */
export async function runCompanyFollowInvite(
  client: Curviate,
  flags: CompanyFlags,
  out: OutputStreams,
): Promise<void> {
  const accountId = await requireAccount(client, flags, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  const inviteeIds = normalizeInviteeIds(flags.invitee);
  if (inviteeIds.length === 0) {
    out.stderr.write("error: at least one --invitee is required.\n");
    process.exit(2);
    return;
  }

  try {
    const identifier = await resolveCompanyId(ns, flags.id ?? "");
    const body = { invitee_ids: inviteeIds };

    if (flags.preview) {
      const preview = buildPreviewOutput({
        method: "companies.followInvite",
        args: { identifier },
        body,
        account: accountId,
      });
      out.stdout.write(JSON.stringify(preview) + "\n");
      return;
    }

    const result = await ns.companies.followInvite(identifier, body);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `company managed [--limit] [--cursor] [--all]`.
 * A facade over the company pages the connected account administers, the
 * seed read for `company followers`/`chats`/`follow-invite`/etc. Unlike the
 * other company sub-resources this takes no `<id>`; there is no company
 * identifier to resolve.
 */
export async function runCompanyManaged(
  client: Curviate,
  flags: CompanyFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = await requireAccount(client, flags, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  const params: Record<string, unknown> = {};
  if (flags.limit) params["limit"] = parseInt(flags.limit, 10);
  if (flags.cursor) params["cursor"] = flags.cursor;

  try {
    if (flags.all) {
      const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
      const fn = (p: Record<string, unknown>) =>
        ns.companies.managed(p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
      return;
    }
    const result = await ns.companies.managed(params);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `company followers <id> [--limit] [--cursor] [--all]`.
 * The account must administer the page (see `company managed`). `<id>`
 * accepts a URL/slug/numeric id, resolved to the numeric provider_id the
 * same way as the other company sub-resources.
 */
export async function runCompanyFollowers(
  client: Curviate,
  flags: CompanyFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = await requireAccount(client, flags, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  const params: Record<string, unknown> = {};
  if (flags.limit) params["limit"] = parseInt(flags.limit, 10);
  if (flags.cursor) params["cursor"] = flags.cursor;

  try {
    const identifier = await resolveCompanyId(ns, flags.id ?? "");
    if (flags.all) {
      const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
      const fn = (p: Record<string, unknown>) =>
        ns.companies.followers(identifier, p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
      return;
    }
    const result = await ns.companies.followers(identifier, params);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `company chats <id> [--limit] [--cursor] [--all]`.
 * List the conversations in a company page's admin message inbox,
 * newest-activity-first. The account must administer the page. Beta,
 * deep pagination against a busier inbox is still being validated.
 */
export async function runCompanyChats(
  client: Curviate,
  flags: CompanyFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = await requireAccount(client, flags, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  const params: Record<string, unknown> = {};
  if (flags.limit) params["limit"] = parseInt(flags.limit, 10);
  if (flags.cursor) params["cursor"] = flags.cursor;

  try {
    const identifier = await resolveCompanyId(ns, flags.id ?? "");
    if (flags.all) {
      const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
      const fn = (p: Record<string, unknown>) =>
        ns.companies.chats(identifier, p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
      return;
    }
    const result = await ns.companies.chats(identifier, params);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `company chat <id> <chat_id>`.
 * Retrieve one conversation from a company page's admin inbox. Read
 * command, rejects --preview and --all. `<chat_id>` is the normal `2-...`
 * conversation id from `company chats`, passed through verbatim.
 */
export async function runCompanyChat(
  client: Curviate,
  flags: CompanyFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);
  if (flags.all) {
    out.stderr.write("error: --all is not supported on non-paginated commands.\n");
    process.exit(2);
  }

  const accountId = await requireAccount(client, flags, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const chatId = flags.chatId ?? "";

  try {
    const identifier = await resolveCompanyId(ns, flags.id ?? "");
    const result = await ns.companies.chat(identifier, chatId);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `company messages <id> <chat_id> [--limit] [--cursor] [--all]`.
 * List a company-inbox conversation's messages, newest first. The account
 * must administer the page. `<chat_id>` passes through verbatim.
 */
export async function runCompanyMessages(
  client: Curviate,
  flags: CompanyFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = await requireAccount(client, flags, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const chatId = flags.chatId ?? "";

  const params: Record<string, unknown> = {};
  if (flags.limit) params["limit"] = parseInt(flags.limit, 10);
  if (flags.cursor) params["cursor"] = flags.cursor;

  try {
    const identifier = await resolveCompanyId(ns, flags.id ?? "");
    if (flags.all) {
      const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
      const fn = (p: Record<string, unknown>) =>
        ns.companies.messages(identifier, chatId, p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
      return;
    }
    const result = await ns.companies.messages(identifier, chatId, params);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `company message <id> <chat_id> <message_id>`.
 * Retrieve one message from a company-inbox conversation. Read command,
 * rejects --preview and --all.
 *
 * NOTE (SDK-signature-wins deviation from the original spec grammar):
 * `companies.message` is a single-message READ (GET one message by id), not
 * a write. The company-inbox SEND op is `companies.sendMessage`, already
 * covered by `company reply` (a pre-existing command); this command is a
 * distinct, additional method the original proposed grammar mis-described
 * as a write named the same as the read.
 */
export async function runCompanyMessage(
  client: Curviate,
  flags: CompanyFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);
  if (flags.all) {
    out.stderr.write("error: --all is not supported on non-paginated commands.\n");
    process.exit(2);
  }

  const accountId = await requireAccount(client, flags, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const chatId = flags.chatId ?? "";
  const messageId = flags.messageId ?? "";

  try {
    const identifier = await resolveCompanyId(ns, flags.id ?? "");
    const result = await ns.companies.message(identifier, chatId, messageId);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `company search-chats <id> [<query>] [--topic <t>] [--unread] [--limit] [--cursor] [--all]`.
 * Search or filter a company page's admin inbox. Exactly one mode per call:
 * free-text `<query>`, a `--topic` card, or `--unread`-only, mutually
 * exclusive, enforced server-side. The account must administer the page.
 */
export async function runCompanySearchChats(
  client: Curviate,
  flags: CompanyFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = await requireAccount(client, flags, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  const params: Record<string, unknown> = {};
  if (flags.query) params["query"] = flags.query;
  if (flags.topic) params["topic"] = flags.topic;
  if (flags.unread !== undefined) params["unread"] = flags.unread;
  if (flags.limit) params["limit"] = parseInt(flags.limit, 10);
  if (flags.cursor) params["cursor"] = flags.cursor;

  try {
    const identifier = await resolveCompanyId(ns, flags.id ?? "");
    if (flags.all) {
      const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
      const fn = (p: Record<string, unknown>) =>
        ns.companies.searchChats(identifier, p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
      return;
    }
    const result = await ns.companies.searchChats(identifier, params);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `company reply <id> <chat_id> "<text>" [--attach <file>...]`.
 * Write command, supports --preview. Replies to an existing company-inbox
 * conversation AS THE PAGE, via `companies.sendMessage`.
 *
 * `<id>` accepts a URL/slug/numeric id, resolved to the numeric provider_id
 * the same way as the other company sub-resources, even under --preview.
 * `<chat_id>` is the normal `2-...` conversation id from `company chats`; it
 * passes through verbatim (no client-side pre-check), and the endpoint
 * resolves the page mailbox internally from the (resolved) identifier.
 * Because every `company reply` is a page reply, --preview prints a
 * "Will send as company page <identifier>" notice derived from the
 * identifier (never "personal", never silent), and on success it prints the
 * `sentAsNotice` acting-identity line (reused from `message.ts`).
 */
export async function runCompanyReply(
  client: Curviate,
  flags: CompanyFlags,
  out: OutputStreams,
  _readStdin?: () => Promise<string>,
): Promise<void> {
  const accountId = await requireAccount(client, flags, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  const chatId = flags.chatId ?? "";
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

  try {
    const identifier = await resolveCompanyId(ns, flags.id ?? "");

    if (flags.preview) {
      const preview = buildPreviewOutput({
        method: "companies.sendMessage",
        args: { identifier, chat_id: chatId },
        body: { text },
        account: accountId,
        attachments: attachBuffers.map((buf, i) => ({
          name: attachPaths[i] ? attachPaths[i].split("/").pop() ?? attachPaths[i] : `attachment_${i}`,
          buffer: buf,
        })),
      });
      out.stdout.write(JSON.stringify(preview) + "\n");
      // A `company reply` is always a page reply, so the will-send-as notice is
      // derived from the (resolved) company identifier, not the chat-id prefix
      // (the normal 2-... id carries no COMPANY_ marker). Never "personal", never silent.
      out.stderr.write(`Will send as company page ${identifier}\n`);
      return;
    }

    const attachmentPayloads = attachBuffers.map((buf, i) => toAttachmentPayload(attachPaths[i]!, buf));
    const body = {
      text,
      ...(attachmentPayloads.length > 0 ? { attachments: attachmentPayloads } : {}),
    };

    const result = await ns.companies.sendMessage(identifier, chatId, body);
    renderSuccess(result, outOpts, out);
    const notice = sentAsNotice((result as Record<string, unknown> | null)?.["sent_as"]);
    if (notice) out.stderr.write(notice);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

// ---------------------------------------------------------------------------
// Citty command definitions
// ---------------------------------------------------------------------------

const companyEmployeesCommand = defineCommand({
  meta: { name: "employees", description: "List people who currently work at the company." },
  args: {
    ...GLOBAL_FLAGS,
    id: { type: "positional", description: "Company identifier (URL, slug, or numeric id), a slug/URL is resolved to the numeric id first." },
    keywords: { type: "string", description: "Free-text keyword filter across employee profile fields." },
    location: { type: "string", description: "Opaque location id from `search parameters --type LOCATION`." },
  },
  async run({ args }) {
    const flags = args as CompanyFlags;
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
    await runCompanyEmployees(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const companyPostsCommand = defineCommand({
  meta: { name: "posts", description: "List the company's posts." },
  args: {
    ...GLOBAL_FLAGS,
    id: { type: "positional", description: "Company identifier (URL, slug, or numeric id), a slug/URL is resolved to the numeric id first." },
  },
  async run({ args }) {
    const flags = args as CompanyFlags;
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
    await runCompanyPosts(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const companyJobsCommand = defineCommand({
  meta: { name: "jobs", description: "List the company's open job postings." },
  args: {
    ...GLOBAL_FLAGS,
    id: { type: "positional", description: "Company identifier (URL, slug, or numeric id), a slug/URL is resolved to the numeric id first." },
    keywords: { type: "string", description: "Free-text keyword filter across job postings." },
  },
  async run({ args }) {
    const flags = args as CompanyFlags;
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
    await runCompanyJobs(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const companyInvitableFollowersCommand = defineCommand({
  meta: {
    name: "invitable-followers",
    description:
      "List the account's 1st-degree connections who are eligible to be invited to follow the company page. " +
      "This is the read that seeds `company follow-invite`. Items carry no name or headline (a wire limitation), " +
      "so hydrate a candidate via `profile <id>` before deciding who to invite. " +
      "`invite_token` is always returned as base64 (the raw value can carry binary bytes unsafe to print).",
  },
  args: {
    ...GLOBAL_FLAGS,
    id: { type: "positional", description: "Company identifier (URL, slug, or numeric id), resolved to the numeric id first." },
  },
  async run({ args }) {
    const flags = args as CompanyFlags;
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
    await runCompanyInvitableFollowers(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const companyFollowInviteCommand = defineCommand({
  meta: {
    name: "follow-invite",
    description:
      "Invite the account's 1st-degree connections to follow the administered company page. " +
      "Write, admin-gated (the account must administer the page with invite rights). " +
      "Pass the AC... member ids from `company invitable-followers`, one --invitee per invitee. " +
      "All-or-nothing: for an all-valid request you get one outcome per invitee, in request order (invited/already_invited/ineligible/not_found); if any invitee id is invalid the whole request rejects with a 404, not a partial result. " +
      "Re-inviting an already-invited member is a safe no-op (the same invitation id, never a duplicate).",
  },
  args: {
    ...WRITE_FLAGS,
    id: { type: "positional", description: "Company identifier (URL, slug, or numeric id), resolved to the numeric id first, including under --preview." },
    invitee: {
      type: "string",
      description: "AC... member id to invite (from `company invitable-followers`). Repeatable, at least one required, max 50 per request.",
    },
  },
  async run({ args }) {
    const flags = args as CompanyFlags;
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
    await runCompanyFollowInvite(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const companyManagedCommand = defineCommand({
  meta: { name: "managed", description: "List the company pages the connected account administers. An empty result is valid, the account administers no pages." },
  args: { ...GLOBAL_FLAGS },
  async run({ args }) {
    const flags = args as CompanyFlags;
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
    await runCompanyManaged(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const companyFollowersCommand = defineCommand({
  meta: { name: "followers", description: "List a company page's followers, newest first. Admin-gated: the account must administer the page (see `company managed`)." },
  args: {
    ...GLOBAL_FLAGS,
    id: { type: "positional", description: "Company identifier (URL, slug, or numeric id), a slug/URL is resolved to the numeric id first." },
  },
  async run({ args }) {
    const flags = args as CompanyFlags;
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
    await runCompanyFollowers(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const companyChatsCommand = defineCommand({
  meta: {
    name: "chats",
    description:
      "List the conversations in a company page's admin message inbox, newest-activity-first. Admin-gated. Beta.",
  },
  args: {
    ...GLOBAL_FLAGS,
    id: { type: "positional", description: "Company identifier (URL, slug, or numeric id), a slug/URL is resolved to the numeric id first." },
  },
  async run({ args }) {
    const flags = args as CompanyFlags;
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
    await runCompanyChats(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const companyChatCommand = defineCommand({
  meta: {
    name: "chat",
    description: "Retrieve one conversation from a company page's admin inbox. Admin-gated. Beta.",
  },
  args: {
    ...GLOBAL_FLAGS,
    id: { type: "positional", description: "Company identifier (URL, slug, or numeric id), a slug/URL is resolved to the numeric id first." },
    chatId: { type: "positional", description: "The 2-... chat id from `company chats`, passed through verbatim." },
  },
  async run({ args }) {
    const flags = args as CompanyFlags;
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
    await runCompanyChat(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const companyMessagesCommand = defineCommand({
  meta: {
    name: "messages",
    description: "List a company-inbox conversation's messages, newest first. Admin-gated.",
  },
  args: {
    ...GLOBAL_FLAGS,
    id: { type: "positional", description: "Company identifier (URL, slug, or numeric id), a slug/URL is resolved to the numeric id first." },
    chatId: { type: "positional", description: "The 2-... chat id from `company chats`, passed through verbatim." },
  },
  async run({ args }) {
    const flags = args as CompanyFlags;
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
    await runCompanyMessages(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const companyMessageCommand = defineCommand({
  meta: {
    name: "message",
    description: "Retrieve one message from a company-inbox conversation. Admin-gated. See also: `company reply` (send).",
  },
  args: {
    ...GLOBAL_FLAGS,
    id: { type: "positional", description: "Company identifier (URL, slug, or numeric id), a slug/URL is resolved to the numeric id first." },
    chatId: { type: "positional", description: "The 2-... chat id from `company chats`, passed through verbatim." },
    messageId: { type: "positional", description: "The message id from `company messages`, passed through verbatim." },
  },
  async run({ args }) {
    const flags = args as CompanyFlags;
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
    await runCompanyMessage(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const companySearchChatsCommand = defineCommand({
  meta: {
    name: "search-chats",
    description:
      "Search or filter a company page's admin inbox. Exactly one mode per call: free-text <query>, --topic, " +
      "or --unread; mutually exclusive, enforced server-side. Admin-gated.",
  },
  args: {
    ...GLOBAL_FLAGS,
    id: { type: "positional", description: "Company identifier (URL, slug, or numeric id), a slug/URL is resolved to the numeric id first." },
    query: { type: "positional", required: false, description: "Free-text term, matches participant names and message content." },
    topic: { type: "string", description: "Filter mode, one inbox topic card: 1-5 or its name (Service request, Request a demo, Support, Careers, Other)." },
    unread: { type: "boolean", description: "Filter mode, unread conversations only." },
  },
  async run({ args }) {
    const flags = args as CompanyFlags;
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
    await runCompanySearchChats(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const companyReplyCommand = defineCommand({
  meta: {
    name: "reply",
    description:
      "Reply to a company-inbox conversation, as the page (write, admin-gated: the account must administer " +
      "the page). Takes the normal 2-... chat id from `company chats`; the endpoint resolves the page mailbox " +
      "internally from the company id. Reply-only, this cannot start a new conversation on the page's behalf. " +
      "See also: `company chats` (the read that returns the chat id) and `message send` (the personal equivalent).",
  },
  args: {
    ...WRITE_FLAGS,
    id: { type: "positional", description: "Company identifier (URL, slug, or numeric id), resolved to the numeric id first, including under --preview." },
    chatId: {
      type: "positional",
      description: "The 2-... chat id from `company chats`, passed through verbatim (no client-side check).",
    },
    text: { type: "positional", stdinArg: true, description: "Reply text. Pass - to read from stdin (e.g. via heredoc or pipe)." },
    attach: { type: "string", description: "File to attach (repeatable)." },
  },
  async run({ args }) {
    const flags = args as CompanyFlags;
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
    await runCompanyReply(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

export const companyCommand = defineCommand({
  meta: { name: "company", description: "Fetch a company profile by URL, slug, or numeric id, and its sub-resources." },
  args: {
    ...GLOBAL_FLAGS,
    id: { type: "positional", description: "Company identifier (URL, slug, or native id)." },
    sections: { type: "string" as const, description: "Not supported on company commands; a usage error (exit 2) if supplied." },
  },
  subCommands: {
    employees: companyEmployeesCommand,
    posts: companyPostsCommand,
    jobs: companyJobsCommand,
    "invitable-followers": companyInvitableFollowersCommand,
    "follow-invite": companyFollowInviteCommand,
    reply: companyReplyCommand,
    managed: companyManagedCommand,
    followers: companyFollowersCommand,
    chats: companyChatsCommand,
    chat: companyChatCommand,
    messages: companyMessagesCommand,
    message: companyMessageCommand,
    "search-chats": companySearchChatsCommand,
  },
  async run({ args }) {
    const flags = args as CompanyFlags;
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
    await runCompanyGet(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});
