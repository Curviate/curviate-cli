/**
 * `curviate feed`, the connected account's LinkedIn home feed (new
 * namespace).
 *
 * Subcommands:
 *   feed home [--sort recent|relevant] [--limit] [--cursor] [--all]: read the home feed
 *
 * GRAMMAR NOTE (dev's call, the spec allowed either a bare `feed` form or
 * `feed home`): `feed home` is the only callable form, a bare `feed <flags>` is NOT
 * wired to run the read directly. `feed` has no positional argument, so a
 * bare invocation carrying a VALUE flag (e.g. `feed --sort relevant`, `feed
 * --limit 20`) collides with the citty-0.1.6 workaround dispatcher's
 * positional-vs-subcommand pre-router (src/dispatch.ts): its top-level token
 * detection is positional-declaration-aware (mixing a bare positional with
 * subCommands, as `company`/`connect`/`profile` do), not value-flag-aware,
 * so the flag's VALUE token (`relevant`, `20`) is misread as an attempted
 * subcommand name and rejected with "unknown command" (exit 2), confirmed
 * via a direct resolveLeaf() probe. Fixing that would mean changing the
 * shared dispatcher's routing semantics for every command in the tree, out
 * of scope for this gap-closure change. `feed` (bare, no args) still prints
 * a usage pointer to `feed home`, matching the `webhook`/`account`/`inboxes`
 * pure-group convention.
 *
 * `--sort recent` (default) is reverse-chronological and always available.
 * `--sort relevant` is LinkedIn's ranked "top" feed, which draws on a shared,
 * throttled request budget and can rate-limit. When a `--cursor` is supplied
 * its carrier is authoritative and `--sort` is ignored (the cursor
 * self-describes its own sort).
 *
 * Account-scoped, read-only (no --preview support).
 */

import { requireAccount } from "../lib/account-arg.js";
import { defineCommand } from "citty";
import { GLOBAL_FLAGS } from "../lib/global-flags.js";
import { resolveEffectiveConfig } from "../lib/resolve.js";
import { createClient } from "../lib/client.js";
import { renderSuccess, renderError, renderUnexpectedError } from "../lib/output.js";
import { streamAll, pageDelayFromFlags } from "../lib/paginate.js";
import type { Curviate, CurviateError } from "@curviate/sdk";

type FeedFlags = {
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
  // feed home
  sort?: string;
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

function resolveOutputOpts(flags: FeedFlags) {
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
// Exported run function (testable without citty)
// ---------------------------------------------------------------------------

/**
 * Run `feed home [--sort recent|relevant] [--limit] [--cursor] [--all]`,
 * feed.home. Read command, rejects --preview. An empty feed is a valid
 * 200 (items:[], cursor:null), not an error.
 */
export async function runFeedHome(
  client: Curviate,
  flags: FeedFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = await requireAccount(client, flags, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;

  const params: Record<string, unknown> = {};
  if (flags.sort) params["sort"] = flags.sort;
  if (flags.limit) params["limit"] = parseInt(flags.limit, 10);
  if (flags.cursor) params["cursor"] = flags.cursor;

  try {
    if (all) {
      const fn = (p: Record<string, unknown>) =>
        ns.feed.home(p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.feed.home(params);
      renderSuccess(result, outOpts, out);
    }
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

// ---------------------------------------------------------------------------
// Citty command definitions
// ---------------------------------------------------------------------------

const FEED_ARGS = {
  ...GLOBAL_FLAGS,
  sort: {
    type: "string" as const,
    description: "Sort order: recent (default, reverse-chronological, always available) or relevant (LinkedIn's ranked 'top' feed, shared throttled budget). Ignored when --cursor is supplied.",
  },
};

const feedHomeCommand = defineCommand({
  meta: { name: "home", description: "Read the connected account's LinkedIn home feed as agent-actionable posts." },
  args: FEED_ARGS,
  async run({ args }) {
    const flags = args as FeedFlags;
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
    await runFeedHome(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

export const feedCommand = defineCommand({
  meta: { name: "feed", description: "Read the connected account's LinkedIn home feed as agent-actionable posts." },
  subCommands: {
    home: feedHomeCommand,
  },
  async run() {
    process.stderr.write(
      "Usage: curviate feed <subcommand>\n" +
      "  home [--sort recent|relevant] [--limit] [--cursor] [--all]\n",
    );
  },
});
