/**
 * `curviate notification`, LinkedIn notification operations (new namespace).
 *
 * Subcommands:
 *   notification list [--filter <f>] [--limit] [--cursor] [--all]: list notification cards
 *   notification delete <card_urn>: delete a notification card (write)
 *   notification show-less <card_urn>: "show less like this" (write)
 *
 * `<card_urn>` is the `card_urn` field of a `notification list` item (raw,
 * unencoded, the SDK percent-encodes it internally), NOT `object_urn`,
 * which targets the wrong notification.
 *
 * Both writes are self-actions (no third party is notified), idempotent
 * (a repeat succeeds, not an error), and cannot be undone. For
 * network-activity cards, `show-less` has the same removing effect as
 * `delete`, LinkedIn exposes no separate softer signal for those cards.
 *
 * `notification list` is read-only (rejects --preview). The two writes
 * support --preview (local render, zero network calls, no server param sent).
 */

import { requireAccount } from "../lib/account-arg.js";
import { defineCommand } from "citty";
import { GLOBAL_FLAGS, WRITE_SINGLE_FLAGS } from "../lib/global-flags.js";
import { resolveEffectiveConfig } from "../lib/resolve.js";
import { createClient } from "../lib/client.js";
import { renderSuccess, renderError, renderUnexpectedError } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { streamAll, pageDelayFromFlags } from "../lib/paginate.js";
import type { Curviate, CurviateError } from "@curviate/sdk";

type NotificationFlags = {
  cardUrn?: string;
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
  // notification list
  filter?: string;
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

function resolveOutputOpts(flags: NotificationFlags) {
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

// ---------------------------------------------------------------------------
// Exported run functions (testable without citty)
// ---------------------------------------------------------------------------

/**
 * Run `notification list [--filter <f>] [--limit] [--cursor] [--all]`,
 * notifications.list. Read command, rejects --preview. `unread_count` is
 * the account-level unread badge, NOT a count of the returned `items`.
 */
export async function runNotificationList(
  client: Curviate,
  flags: NotificationFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = await requireAccount(client, flags, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;

  const params: Record<string, unknown> = {};
  if (flags.filter) params["filter"] = flags.filter;
  if (flags.limit) params["limit"] = parseInt(flags.limit, 10);
  if (flags.cursor) params["cursor"] = flags.cursor;

  try {
    if (all) {
      const fn = (p: Record<string, unknown>) =>
        ns.notifications.list(p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.notifications.list(params);
      renderSuccess(result, outOpts, out);
    }
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `notification delete <card_urn>`, notifications.delete. Write
 * command, supports --preview. Idempotent, self-action, cannot be undone.
 */
export async function runNotificationDelete(
  client: Curviate,
  flags: NotificationFlags,
  out: OutputStreams,
): Promise<void> {
  const accountId = await requireAccount(client, flags, out);
  const cardUrn = flags.cardUrn ?? "";

  if (flags.preview) {
    const preview = buildPreviewOutput({ method: "notifications.delete", args: { card_urn: cardUrn }, body: {}, account: accountId });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  try {
    const result = await ns.notifications.delete(cardUrn);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `notification show-less <card_urn>`, notifications.showLess. Write
 * command, supports --preview. For network-activity cards this has the
 * same removing effect as `delete`. Idempotent, self-action, cannot be undone.
 */
export async function runNotificationShowLess(
  client: Curviate,
  flags: NotificationFlags,
  out: OutputStreams,
): Promise<void> {
  const accountId = await requireAccount(client, flags, out);
  const cardUrn = flags.cardUrn ?? "";

  if (flags.preview) {
    const preview = buildPreviewOutput({ method: "notifications.showLess", args: { card_urn: cardUrn }, body: {}, account: accountId });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  try {
    const result = await ns.notifications.showLess(cardUrn);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

// ---------------------------------------------------------------------------
// Citty command definitions
// ---------------------------------------------------------------------------

const notificationListCommand = defineCommand({
  meta: { name: "list", description: "List the connected account's notification cards, newest first, plus the unread badge and a poll watermark." },
  args: {
    ...GLOBAL_FLAGS,
    filter: {
      type: "string" as const,
      description: "Which notification stream to read (default all): all | jobs | mentions | my_posts | my_posts_comments | my_posts_reactions | my_posts_reposts.",
    },
  },
  async run({ args }) {
    const flags = args as NotificationFlags;
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
    await runNotificationList(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const notificationDeleteCommand = defineCommand({
  meta: { name: "delete", description: "Delete one of your notification cards by its card urn. Self-action, idempotent, cannot be undone." },
  args: {
    ...WRITE_SINGLE_FLAGS,
    cardUrn: { type: "positional", description: "The card_urn field of a `notification list` item (not object_urn)." },
  },
  async run({ args }) {
    const flags = args as NotificationFlags;
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
    await runNotificationDelete(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const notificationShowLessCommand = defineCommand({
  meta: {
    name: "show-less",
    description:
      "Apply 'show less like this' to the source of one of your notification cards. For network-activity cards " +
      "this removes the card, same as delete. Self-action, idempotent, cannot be undone.",
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    cardUrn: { type: "positional", description: "The card_urn field of a `notification list` item (not object_urn)." },
  },
  async run({ args }) {
    const flags = args as NotificationFlags;
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
    await runNotificationShowLess(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

export const notificationCommand = defineCommand({
  meta: { name: "notification", description: "Read and act on LinkedIn notification cards." },
  subCommands: {
    list: notificationListCommand,
    delete: notificationDeleteCommand,
    "show-less": notificationShowLessCommand,
  },
  async run() {
    process.stderr.write(
      "Usage: curviate notification <subcommand>\n" +
      "  list [--filter <f>]\n" +
      "  delete <card_urn>\n" +
      "  show-less <card_urn>\n",
    );
  },
});
