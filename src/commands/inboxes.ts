/**
 * `curviate inboxes`, inbox discovery + per-inbox conversation listing (Beta).
 *
 * Subcommands:
 *   inboxes list [--kind personal|company] [--company-id <id>]: discover inboxes
 *   inboxes chats <inbox_id> [--limit] [--cursor] [--all]: list an inbox's conversations
 *
 * Distinct from the existing `inbox` command (a friendlier front door to the
 * account's own message thread inbox, `messaging.listChats`/`getChat`/
 * `markChatRead`/`messages`). `inboxes` (plural) wraps the newer discovery
 * surface: personal inbox plus, when the company product is attached, one
 * entry per company page. Every chat id `inboxes chats` returns is send-ready;
 * reply with the EXISTING `message send <chat_id> "<text>"`; a company
 * inbox's chat id (e.g. `COMPANY_83734124_2-...`) sends AS THE PAGE, no
 * separate parameter needed. Company inboxes are reply-only; they cannot
 * start a new conversation (`message new` requires a personal, `CLASSIC_`,
 * chat).
 *
 * Beta: single-page listing is verified; deep pagination against a busier
 * inbox is still being validated.
 *
 * All subcommands are account-scoped, read-only (no --preview support).
 */

import { defineCommand } from "citty";
import { GLOBAL_FLAGS, READ_SINGLE_FLAGS } from "../lib/global-flags.js";
import { resolveEffectiveConfig } from "../lib/resolve.js";
import { createClient } from "../lib/client.js";
import { renderSuccess, renderError, renderUnexpectedError } from "../lib/output.js";
import { streamAll, pageDelayFromFlags } from "../lib/paginate.js";
import type { Curviate, CurviateError } from "@curviate/sdk";

type InboxesFlags = {
  inboxId?: string;
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
  // inboxes list filters
  kind?: string;
  "company-id"?: string;
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

function resolveOutputOpts(flags: InboxesFlags) {
  return {
    json: (flags.json ?? false) || !process.stdout.isTTY,
    isTTY: process.stdout.isTTY ?? false,
    fields: flags.fields,
    verbose: flags.verbose ?? false,
  };
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

/**
 * Validate --limit against the server's accepted range (1-25 for this
 * endpoint) before any SDK call, a clear, specific message beats a
 * round-tripped generic 400. A non-numeric value is left to the server's own
 * validation (out of scope for this range-only guard); an unset value is a no-op.
 */
function validateLimitRange(raw: string | undefined, out: OutputStreams): void {
  if (raw === undefined) return;
  const n = Number(raw);
  if (!Number.isFinite(n)) return;
  if (n < 1 || n > 25) {
    out.stderr.write(`error: --limit must be between 1 and 25 (default 20); got ${raw}.\n`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Exported run functions (testable without citty)
// ---------------------------------------------------------------------------

/**
 * Run `inboxes list [--kind personal|company] [--company-id <id>]`.
 * Read command, rejects --preview and --all (a flat, non-paginated list,
 * no `cursor` on the response).
 */
export async function runInboxesList(
  client: Curviate,
  flags: InboxesFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);
  rejectAllOnNonPaginated(flags.all, out);

  const accountId = requireAccount(flags.account, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  const params: Record<string, unknown> = {};
  if (flags.kind) params["kind"] = flags.kind;
  if (flags["company-id"]) params["company_id"] = flags["company-id"];

  try {
    const result = await ns.inboxes.list(params);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `inboxes chats <inbox_id> [--limit] [--cursor] [--all]`.
 * Read command, rejects --preview. Cursor-paginated: supports --all like
 * every other list command.
 *
 * <inbox_id> comes from `inboxes list` (e.g. `CLASSIC_PRIMARY` or
 * `COMPANY_83734124_PRIMARY`). Every returned chat's `id` is send-ready,
 * reply with `message send <chat_id> "<text>"`.
 */
export async function runInboxesChats(
  client: Curviate,
  flags: InboxesFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = requireAccount(flags.account, out);
  const inboxId = flags.inboxId ?? "";
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;

  validateLimitRange(flags.limit, out);
  const params: Record<string, unknown> = {};
  if (flags.limit) params["limit"] = parseInt(flags.limit, 10);
  if (flags.cursor) params["cursor"] = flags.cursor;

  try {
    if (all) {
      const fn = (p: Record<string, unknown>) =>
        ns.inboxes.listChats(inboxId, p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.inboxes.listChats(inboxId, params);
      renderSuccess(result, outOpts, out);
    }
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

// ---------------------------------------------------------------------------
// Citty command definitions
// ---------------------------------------------------------------------------

const inboxesListCommand = defineCommand({
  meta: { name: "list", description: "Discover the account's inboxes (personal + company pages)." },
  args: {
    // Single-object-shaped read: READ_SINGLE_FLAGS omits pagination flags
    // (this response carries no cursor, every inbox comes back in one call).
    ...READ_SINGLE_FLAGS,
    kind: {
      type: "string" as const,
      description: "Filter to only personal or only company inboxes: personal | company. Omit to list both.",
    },
    "company-id": {
      type: "string" as const,
      description: "Filter to the one company inbox correlated to this managed-company id (e.g. 112013061).",
    },
  },
  async run({ args }) {
    const flags = args as InboxesFlags;
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
    await runInboxesList(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const inboxesChatsCommand = defineCommand({
  meta: {
    name: "chats",
    description:
      "List an inbox's conversations. Each chat id is send-ready: reply with `message send <chat_id> \"<text>\"`. " +
      "A company inbox's chat id (e.g. COMPANY_83734124_2-...) sends AS THE PAGE, no separate flag needed. " +
      "Company inboxes are reply-only and cannot start a new conversation.",
  },
  args: {
    ...GLOBAL_FLAGS,
    limit: { type: "string" as const, description: "Number of items to return per page (1-25, default 20)." },
    inboxId: { type: "positional", description: "Inbox id from `inboxes list` (e.g. CLASSIC_PRIMARY or COMPANY_83734124_PRIMARY)." },
  },
  async run({ args }) {
    const flags = args as InboxesFlags;
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
    await runInboxesChats(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

export const inboxesCommand = defineCommand({
  meta: {
    name: "inboxes",
    description:
      "Discover LinkedIn inboxes (personal + company pages) and list their conversations. Beta. " +
      "See also: `inbox` (the account's own message-thread inbox), `message send` (reply to a chat).",
  },
  subCommands: {
    list: inboxesListCommand,
    chats: inboxesChatsCommand,
  },
  async run() {
    process.stderr.write(
      "Usage: curviate inboxes <subcommand>\n" +
      "  list [--kind personal|company] [--company-id <id>]\n" +
      "  chats <inbox_id> [--limit] [--cursor] [--all]\n",
    );
  },
});
