/**
 * `curviate connect` — connection invitation operations.
 *
 * Subcommands:
 *   connect <id> [--note <text>]            — send invitation (write, --preview OK)
 *   connect sent                            — list sent invitations (read)
 *   connect received                        — list received invitations (read)
 *   connect accept <id>                     — accept a received invitation (write, --preview OK)
 *   connect decline <id>                    — decline a received invitation (write, --preview OK)
 *   connect cancel <id>                     — cancel sent invitation (write, --preview OK)
 *
 * <id> for `connect <id>` passes through resolveIdentifier (member URL/slug/URN).
 * <id> for `accept`, `decline`, and `cancel` is an invitation_id — passed
 * verbatim, NOT resolved. All subcommands are account-scoped.
 *
 * v2: the old combined `invites.respond(id, {action, shared_secret})` split
 * into two dedicated, BODYLESS ops — `invites.accept` / `invites.decline` —
 * surfaced here as the separate `connect accept` / `connect decline`
 * subcommands. The combined `respond --action` command is removed; the
 * accept/decline ops take no body at all.
 */

import { defineCommand } from "citty";
import { GLOBAL_FLAGS, WRITE_FLAGS } from "../lib/global-flags.js";
import { nearestSubcommand } from "../lib/bare-form-guard.js";
import { slimInviteSent, slimInviteReceived, slimInviteSentItem, slimInviteReceivedItem } from "../lib/slim.js";
import { resolveIdentifier } from "../lib/identifier.js";
import { resolveEffectiveConfig } from "../lib/resolve.js";
import { createClient } from "../lib/client.js";
import { renderSuccess, renderError, renderUnexpectedError } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { streamAll, pageDelayFromFlags } from "../lib/paginate.js";
import type { Curviate, CurviateError } from "@curviate/sdk";

type ConnectFlags = {
  id?: string;
  note?: string;
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

function resolveOutputOpts(flags: ConnectFlags) {
  return {
    json: (flags.json ?? false) || !process.stdout.isTTY,
    isTTY: process.stdout.isTTY ?? false,
    fields: flags.fields,
    verbose: flags.verbose ?? false,
  };
}

// ---------------------------------------------------------------------------
// Exported run functions (testable without citty)
// ---------------------------------------------------------------------------

/**
 * Run `connect <id> [--note <text>]`.
 * Write command — supports --preview.
 */
export async function runConnectSend(
  client: Curviate,
  flags: ConnectFlags,
  out: OutputStreams,
): Promise<void> {
  const accountId = requireAccount(flags.account, out);
  const rawId = flags.id ?? "";
  const resolvedId = resolveIdentifier(rawId);

  const body = {
    recipient_identifier: resolvedId,
    ...(flags.note ? { message: flags.note } : {}),
  };

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "invites.send",
      args: { id: resolvedId },
      body,
      account: accountId,
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.invites.send(body);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    const { CurviateError } = await import("@curviate/sdk");
    if (err instanceof CurviateError) {
      const { getExitCode } = await import("../lib/exit-codes.js");
      renderError(err as CurviateError, outOpts, out);
      process.exit(getExitCode(err.code));
    }
    renderUnexpectedError(err, out);
    process.exit(1);
  }
}

/**
 * Run `connect sent [--all] [--limit] [--cursor]`.
 * Read command — rejects --preview.
 */
export async function runConnectSent(
  client: Curviate,
  flags: ConnectFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = requireAccount(flags.account, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
  const limit = flags.limit ? parseInt(flags.limit, 10) : undefined;
  const cursor = flags.cursor;
  const params: Record<string, unknown> = {};
  if (limit !== undefined) params["limit"] = limit;
  if (cursor) params["cursor"] = cursor;

  try {
    if (all) {
      const fn = (p: Record<string, unknown>) => ns.invites.listSent(p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        // streamAll yields individual items; project per-item (the envelope
        // projector slimInviteSent expects a { items } wrapper and would erase
        // a bare item to an empty envelope).
        const projected = !flags.verbose ? slimInviteSentItem(item as Record<string, unknown>) : item;
        out.stdout.write(JSON.stringify(projected) + "\n");
      }
    } else {
      const result = await ns.invites.listSent(params);
      renderSuccess(result, { ...outOpts, slim: slimInviteSent }, out);
    }
  } catch (err: unknown) {
    const { CurviateError } = await import("@curviate/sdk");
    if (err instanceof CurviateError) {
      const { getExitCode } = await import("../lib/exit-codes.js");
      renderError(err as CurviateError, outOpts, out);
      process.exit(getExitCode(err.code));
    }
    renderUnexpectedError(err, out);
    process.exit(1);
  }
}

/**
 * Run `connect received [--all] [--limit] [--cursor]`.
 * Read command — rejects --preview.
 */
export async function runConnectReceived(
  client: Curviate,
  flags: ConnectFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = requireAccount(flags.account, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
  const limit = flags.limit ? parseInt(flags.limit, 10) : undefined;
  const cursor = flags.cursor;
  const params: Record<string, unknown> = {};
  if (limit !== undefined) params["limit"] = limit;
  if (cursor) params["cursor"] = cursor;

  try {
    if (all) {
      const fn = (p: Record<string, unknown>) => ns.invites.listReceived(p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        // streamAll yields individual items; project per-item (the envelope
        // projector slimInviteReceived expects a { items } wrapper and would
        // erase a bare item to an empty envelope).
        const projected = !flags.verbose ? slimInviteReceivedItem(item as Record<string, unknown>) : item;
        out.stdout.write(JSON.stringify(projected) + "\n");
      }
    } else {
      const result = await ns.invites.listReceived(params);
      renderSuccess(result, { ...outOpts, slim: slimInviteReceived }, out);
    }
  } catch (err: unknown) {
    const { CurviateError } = await import("@curviate/sdk");
    if (err instanceof CurviateError) {
      const { getExitCode } = await import("../lib/exit-codes.js");
      renderError(err as CurviateError, outOpts, out);
      process.exit(getExitCode(err.code));
    }
    renderUnexpectedError(err, out);
    process.exit(1);
  }
}

/**
 * Run `connect accept <invitation_id>` — invites.accept (bodyless).
 * Write command — supports --preview.
 * invitation_id is NOT passed through resolveIdentifier.
 */
export async function runConnectAccept(
  client: Curviate,
  flags: ConnectFlags,
  out: OutputStreams,
): Promise<void> {
  const accountId = requireAccount(flags.account, out);
  // invitation_id passes verbatim — NOT URL-normalized
  const invitationId = flags.id ?? "";

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "invites.accept",
      args: { invitation_id: invitationId },
      body: {},
      account: accountId,
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.invites.accept(invitationId);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    const { CurviateError } = await import("@curviate/sdk");
    if (err instanceof CurviateError) {
      const { getExitCode } = await import("../lib/exit-codes.js");
      renderError(err as CurviateError, outOpts, out);
      process.exit(getExitCode(err.code));
    }
    renderUnexpectedError(err, out);
    process.exit(1);
  }
}

/**
 * Run `connect decline <invitation_id>` — invites.decline (bodyless).
 * Write command — supports --preview.
 * invitation_id is NOT passed through resolveIdentifier.
 */
export async function runConnectDecline(
  client: Curviate,
  flags: ConnectFlags,
  out: OutputStreams,
): Promise<void> {
  const accountId = requireAccount(flags.account, out);
  // invitation_id passes verbatim — NOT URL-normalized
  const invitationId = flags.id ?? "";

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "invites.decline",
      args: { invitation_id: invitationId },
      body: {},
      account: accountId,
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.invites.decline(invitationId);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    const { CurviateError } = await import("@curviate/sdk");
    if (err instanceof CurviateError) {
      const { getExitCode } = await import("../lib/exit-codes.js");
      renderError(err as CurviateError, outOpts, out);
      process.exit(getExitCode(err.code));
    }
    renderUnexpectedError(err, out);
    process.exit(1);
  }
}

/**
 * Run `connect cancel <invitation_id>`.
 * Write command — supports --preview.
 * invitation_id is NOT passed through resolveIdentifier.
 */
export async function runConnectCancel(
  client: Curviate,
  flags: ConnectFlags,
  out: OutputStreams,
): Promise<void> {
  const accountId = requireAccount(flags.account, out);
  // invitation_id passes verbatim — NOT URL-normalized
  const invitationId = flags.id ?? "";

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "invites.cancel",
      args: { invitation_id: invitationId },
      body: {},
      account: accountId,
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.invites.cancel(invitationId);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    const { CurviateError } = await import("@curviate/sdk");
    if (err instanceof CurviateError) {
      const { getExitCode } = await import("../lib/exit-codes.js");
      renderError(err as CurviateError, outOpts, out);
      process.exit(getExitCode(err.code));
    }
    renderUnexpectedError(err, out);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Citty command definitions
// ---------------------------------------------------------------------------

const connectSentCommand = defineCommand({
  meta: {
    name: "sent",
    description:
      "Returns pending sent invitations only — accepted and declined invitations are not returned (LinkedIn API limitation). " +
      "Use `id` with `connect cancel`; use `user.id` (native member URN — the sent-variant carries no public slug) to identify the recipient. " +
      "`created_at` is the platform's own ISO-8601 timestamp (not an approximation). " +
      "No total count is available; use `connect sent --all` and count client-side. " +
      "A very recently sent invitation may take a few minutes to appear here (LinkedIn-side indexing).",
  },
  args: { ...GLOBAL_FLAGS },
  async run({ args }) {
    const flags = args as ConnectFlags;
    const cfg = await resolveEffectiveConfig({
      apiKey: flags["api-key"],
      baseUrl: flags["base-url"],
      timeout: flags.timeout,
      account: flags.account,
      profile: flags.profile,
    });
    if (!cfg.apiKey) {
      process.stderr.write("error: no API key — run `curviate login` or pass --api-key.\n");
      process.exit(3);
    }
    const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeout: cfg.timeout });
    const out = buildOutputStreams();
    await runConnectSent(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const connectReceivedCommand = defineCommand({
  meta: {
    name: "received",
    description:
      "Returns pending received invitations only — already-handled invitations are not returned. " +
      "The `user.*` fields (`public_identifier`, `display_name`, `first_name`, `last_name`) identify who sent the request. " +
      "Use the `id` field with `connect accept` or `connect decline`. " +
      "A very recently received invitation may take a few minutes to appear here (LinkedIn-side indexing).",
  },
  args: { ...GLOBAL_FLAGS },
  async run({ args }) {
    const flags = args as ConnectFlags;
    const cfg = await resolveEffectiveConfig({
      apiKey: flags["api-key"],
      baseUrl: flags["base-url"],
      timeout: flags.timeout,
      account: flags.account,
      profile: flags.profile,
    });
    if (!cfg.apiKey) {
      process.stderr.write("error: no API key — run `curviate login` or pass --api-key.\n");
      process.exit(3);
    }
    const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeout: cfg.timeout });
    const out = buildOutputStreams();
    await runConnectReceived(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const connectAcceptCommand = defineCommand({
  meta: { name: "accept", description: "Accept a received invitation." },
  args: {
    ...WRITE_FLAGS,
    id: {
      type: "positional",
      description: "Invitation id to accept — use the `id` field from `connect received`.",
    },
  },
  async run({ args }) {
    const flags = args as ConnectFlags;
    const cfg = await resolveEffectiveConfig({
      apiKey: flags["api-key"],
      baseUrl: flags["base-url"],
      timeout: flags.timeout,
      account: flags.account,
      profile: flags.profile,
    });
    if (!cfg.apiKey) {
      process.stderr.write("error: no API key — run `curviate login` or pass --api-key.\n");
      process.exit(3);
    }
    const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeout: cfg.timeout });
    const out = buildOutputStreams();
    await runConnectAccept(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const connectDeclineCommand = defineCommand({
  meta: { name: "decline", description: "Decline a received invitation." },
  args: {
    ...WRITE_FLAGS,
    id: {
      type: "positional",
      description: "Invitation id to decline — use the `id` field from `connect received`.",
    },
  },
  async run({ args }) {
    const flags = args as ConnectFlags;
    const cfg = await resolveEffectiveConfig({
      apiKey: flags["api-key"],
      baseUrl: flags["base-url"],
      timeout: flags.timeout,
      account: flags.account,
      profile: flags.profile,
    });
    if (!cfg.apiKey) {
      process.stderr.write("error: no API key — run `curviate login` or pass --api-key.\n");
      process.exit(3);
    }
    const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeout: cfg.timeout });
    const out = buildOutputStreams();
    await runConnectDecline(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const connectCancelCommand = defineCommand({
  meta: { name: "cancel", description: "Cancel a sent invitation." },
  args: {
    ...WRITE_FLAGS,
    id: { type: "positional", description: "Invitation id to cancel." },
  },
  async run({ args }) {
    const flags = args as ConnectFlags;
    const cfg = await resolveEffectiveConfig({
      apiKey: flags["api-key"],
      baseUrl: flags["base-url"],
      timeout: flags.timeout,
      account: flags.account,
      profile: flags.profile,
    });
    if (!cfg.apiKey) {
      process.stderr.write("error: no API key — run `curviate login` or pass --api-key.\n");
      process.exit(3);
    }
    const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeout: cfg.timeout });
    const out = buildOutputStreams();
    await runConnectCancel(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

/** The subcommands `connect` registers, named once for the guard and the usage block. */
const CONNECT_SUBCOMMANDS = ["sent", "received", "accept", "decline", "cancel"] as const;

const CONNECT_USAGE =
  "Usage: curviate connect <id> [--note <text>]\n" +
  "       curviate connect sent\n" +
  "       curviate connect received\n" +
  "       curviate connect accept <invitation_id>\n" +
  "       curviate connect decline <invitation_id>\n" +
  "       curviate connect cancel <invitation_id>\n";

/**
 * Refuse a bare `<id>` that is almost certainly a mistyped subcommand.
 *
 * The bare form `connect <id>` SENDS a connection invitation, so a token meant
 * as `sent` but typed `snet` would invite whoever owns the slug `snet`. Unlike
 * `message`, a shape test is not available here: a LinkedIn public slug is a
 * lowercase word, indistinguishable from a command name, so the test is
 * proximity to this group's own subcommand names instead.
 *
 * A URL, provider id, or URN is never a near-miss of a subcommand, so those
 * always pass; and the full profile URL is the escape hatch if a real slug ever
 * does land near one. Refusing costs a retype, sending costs an unwanted
 * connection request to a stranger.
 *
 * Exported for direct unit coverage.
 */
export function guardBareConnectForm(id: string, out: OutputStreams): void {
  const suggestion = nearestSubcommand(id, [...CONNECT_SUBCOMMANDS]);
  if (suggestion === null) return;

  out.stderr.write(
    `error: \`${id}\` looks like a mistyped \`${suggestion}\` subcommand, and \`curviate connect <id>\` ` +
      `SENDS a connection invitation, so this is refused rather than guessed.\n`,
  );
  out.stderr.write(`hint: did you mean \`curviate connect ${suggestion}\`?\n`);
  out.stderr.write(
    `hint: if \`${id}\` really is the profile you meant, pass the full profile URL ` +
      `(https://www.linkedin.com/in/${id}) or the provider id instead.\n`,
  );
  out.stderr.write(CONNECT_USAGE);
  process.exit(2);
}

export const connectCommand = defineCommand({
  meta: {
    name: "connect",
    description:
      "Send or manage connection invitations. " +
      "Connection requests may take 10–30 seconds to appear in the recipient's received list (LinkedIn propagation delay).",
  },
  args: {
    ...WRITE_FLAGS,
    id: {
      type: "positional",
      description:
        "Recipient's LinkedIn URL, public slug, or provider_id (ACoAAA… from `curviate profile`). " +
        "LinkedIn URN (`urn:li:member:N`) also accepted but the numeric member ID is not exposed by this API.",
      required: false,
    },
    note: {
      type: "string",
      description:
        "Personalized message shown to the recipient alongside the connection request (≤300 chars; LinkedIn cap). " +
        "Omit to send a generic note. Personalized messages increase acceptance rates.",
    },
  },
  subCommands: {
    sent: connectSentCommand,
    received: connectReceivedCommand,
    accept: connectAcceptCommand,
    decline: connectDeclineCommand,
    cancel: connectCancelCommand,
  },
  async run({ args }) {
    const flags = args as ConnectFlags;

    if (!flags.id) {
      process.stderr.write(CONNECT_USAGE);
      // <id> is functionally required for the bare form (there is no valid
      // "connect to nothing" action) — a missing required positional is a
      // usage error, not a silent success. `required: false` on the citty
      // arg def above exists only so this richer usage block can run instead
      // of citty's generic one-liner; it does not make the id optional.
      process.exit(2);
    }

    // A mistyped subcommand must never send an invitation. Runs before any
    // client exists, so a refusal cannot make a network call.
    guardBareConnectForm(flags.id, buildOutputStreams());

    const cfg = await resolveEffectiveConfig({
      apiKey: flags["api-key"],
      baseUrl: flags["base-url"],
      timeout: flags.timeout,
      account: flags.account,
      profile: flags.profile,
    });
    if (!cfg.apiKey) {
      process.stderr.write("error: no API key — run `curviate login` or pass --api-key.\n");
      process.exit(3);
    }
    const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeout: cfg.timeout });
    const out = buildOutputStreams();
    await runConnectSend(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});
