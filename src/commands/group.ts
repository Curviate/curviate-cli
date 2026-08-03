/**
 * `curviate group` — LinkedIn group operations (new namespace).
 *
 * Subcommands:
 *   group list [--target <slug>] [--limit] [--cursor] [--all]  — list groups (own by default)
 *   group get <group_id>                                          — get one group's full detail
 *   group members <group_id> [--name] [--limit] [--cursor] [--all] — list (or search) a group's members
 *
 * `group list` enumerates the connected account's own groups by default (a
 * complete read, real total_count); pass `--target <slug>` to read another
 * LinkedIn user's groups instead (a documented partial read of that target's
 * interests-groups section only, total_count always null).
 *
 * `<group_id>` on `group get`/`group members` accepts a numeric group id or a
 * full LinkedIn group URL (e.g. https://www.linkedin.com/groups/9123014/) —
 * passed through verbatim; the server extracts the numeric id from either
 * form. This is NOT the same normalization as `resolveIdentifier` (which
 * targets member/company slugs, not group URLs) — no client-side extraction
 * is performed.
 *
 * `group members --name <filter>` folds member search into the same
 * endpoint — not a separate operation.
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

type GroupFlags = {
  groupId?: string;
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
  // group list
  target?: string;
  // group members
  name?: string;
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

function resolveOutputOpts(flags: GroupFlags) {
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
 * Run `group list [--target <slug>] [--limit] [--cursor] [--all]`.
 * Read command — rejects --preview. Own groups by default (complete
 * enumeration); `--target <slug>` reads another member's groups instead
 * (a documented partial read — total_count always null there).
 */
export async function runGroupList(
  client: Curviate,
  flags: GroupFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = requireAccount(flags.account, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;

  const params: Record<string, unknown> = {};
  if (flags.target) params["profile"] = flags.target;
  if (flags.limit) params["limit"] = parseInt(flags.limit, 10);
  if (flags.cursor) params["cursor"] = flags.cursor;

  try {
    if (all) {
      const fn = (p: Record<string, unknown>) =>
        ns.groups.list(p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.groups.list(params);
      renderSuccess(result, outOpts, out);
    }
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `group get <group_id>`.
 * Read command — rejects --preview and --all. `<group_id>` accepts a
 * numeric id or a full LinkedIn group URL, passed through verbatim.
 */
export async function runGroupGet(
  client: Curviate,
  flags: GroupFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);
  rejectAllOnNonPaginated(flags.all, out);

  const accountId = requireAccount(flags.account, out);
  const groupId = flags.groupId ?? "";
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.groups.get(groupId);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `group members <group_id> [--name] [--limit] [--cursor] [--all]`.
 * Read command — rejects --preview. Requires the connected account be a
 * member of the group. `--name` folds in member search as the SAME endpoint.
 */
export async function runGroupMembers(
  client: Curviate,
  flags: GroupFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = requireAccount(flags.account, out);
  const groupId = flags.groupId ?? "";
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;

  const params: Record<string, unknown> = {};
  if (flags.name) params["name"] = flags.name;
  if (flags.limit) params["limit"] = parseInt(flags.limit, 10);
  if (flags.cursor) params["cursor"] = flags.cursor;

  try {
    if (all) {
      const fn = (p: Record<string, unknown>) =>
        ns.groups.members(groupId, p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.groups.members(groupId, params);
      renderSuccess(result, outOpts, out);
    }
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

// ---------------------------------------------------------------------------
// Citty command definitions
// ---------------------------------------------------------------------------

const groupListCommand = defineCommand({
  meta: { name: "list", description: "List the groups the connected account belongs to. Pass --target to enumerate another member's groups instead (a partial, interests-only read)." },
  args: {
    ...GLOBAL_FLAGS,
    target: {
      type: "string" as const,
      description: "Target another LinkedIn member's groups instead of your own: a vanity slug or full /in/{vanity} URL. Omit to enumerate your own groups (a complete read).",
    },
  },
  async run({ args }) {
    const flags = args as GroupFlags;
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
    await runGroupList(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const groupGetCommand = defineCommand({
  meta: { name: "get", description: "Get one LinkedIn group's full detail: name, member count, description, admin contact, and write-feasibility gates." },
  args: {
    ...READ_SINGLE_FLAGS,
    groupId: { type: "positional", description: "Numeric group id, or a full group URL (e.g. https://www.linkedin.com/groups/9123014/)." },
  },
  async run({ args }) {
    const flags = args as GroupFlags;
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
    await runGroupGet(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const groupMembersCommand = defineCommand({
  meta: {
    name: "members",
    description: "List (or search by name) a group's members: id, profile URL, name, headline, and relationship signal. Requires the connected account be a member of the group.",
  },
  args: {
    ...GLOBAL_FLAGS,
    groupId: { type: "positional", description: "Numeric group id, or a full group URL." },
    name: {
      type: "string" as const,
      description: "Filter the roster by member name: prefix/substring, multi-word, case-insensitive. Omit for the full roster.",
    },
  },
  async run({ args }) {
    const flags = args as GroupFlags;
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
    await runGroupMembers(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

export const groupCommand = defineCommand({
  meta: { name: "group", description: "Read LinkedIn groups: your own membership list, one group's detail, and its member roster." },
  subCommands: {
    list: groupListCommand,
    get: groupGetCommand,
    members: groupMembersCommand,
  },
  async run() {
    process.stderr.write(
      "Usage: curviate group <subcommand>\n" +
      "  list [--target <slug>]\n" +
      "  get <group_id>\n" +
      "  members <group_id> [--name <filter>]\n",
    );
  },
});
