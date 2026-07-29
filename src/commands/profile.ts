/**
 * `curviate profile` — member profile operations.
 *
 * Subcommands:
 *   profile me                                   — own profile
 *   profile <id>                                 — get member profile
 *   profile <id> --posts [--is-company]          — list posts
 *   profile <id> --comments                      — list comments
 *   profile <id> --reactions                     — list reactions
 *   profile <id> --followers                     — list followers
 *   profile relations                            — list 1st-degree connections
 *   profile endorse <id> --endorsement-id <id>   — endorse a skill (write; slug/URL auto-resolved to provider id)
 *   profile subscription                         — read your premium subscription (read)
 *   profile analytics                            — read your performance headline metrics (read)
 *   profile visitors                             — list who recently viewed your profile (paginated, read)
 *   profile ssi                                  — read your Social Selling Index (read)
 *
 * All subcommands are account-scoped. `<id>` passes through resolveIdentifier.
 * Read commands reject --preview (exit 2). Write commands render --preview.
 * List reads support --all NDJSON streaming; profile me rejects --all (exit 2).
 *
 * Slim projection (default): profile me and profile <id> return a compact
 * subset of fields. Pass --verbose to get the full SDK response.
 *
 * --sections: comma-separated LinkedIn sections to fetch (profile me and
 * profile <id> only). Empty string is a usage error (exit 2). A bare value
 * is auto-prefixed to the server's linkedin_-prefixed vocabulary (skills →
 * linkedin_skills, D9); an unknown section (after prefixing) is a usage
 * error (exit 2) naming the bad value — see lib/sections.ts. On profile
 * <id>, a slug/URL is first resolved to the provider id (D7, lib/member-id.ts)
 * since the sections-enriched read 400s on a raw slug.
 *
 * Company slug resolution (--posts --is-company): when the resolved id is
 * non-numeric, getCompany is called first to obtain the numeric company id
 * which listPosts requires for company pages.
 */

import { defineCommand } from "citty";
import { GLOBAL_FLAGS, WRITE_SINGLE_FLAGS, READ_SINGLE_FLAGS } from "../lib/global-flags.js";
import { resolveIdentifier } from "../lib/identifier.js";
import { resolveMemberProviderId, resolveMemberOrMeProviderId } from "../lib/member-id.js";
import { parseSectionsFlag } from "../lib/sections.js";
import { resolveEffectiveConfig } from "../lib/resolve.js";
import { createClient } from "../lib/client.js";
import { renderSuccess, renderError, renderUnexpectedError } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { streamAll, pageDelayFromFlags } from "../lib/paginate.js";
import { readAttachment, AttachError, toAttachmentPayload } from "../lib/attach.js";
import { slimProfileMe, slimProfile } from "../lib/slim.js";
import type { Curviate, CurviateError } from "@curviate/sdk";

// Body type derived from the real SDK signature — a shape drift is a compile
// error, not a latent runtime break.
type UserUpdateBody = Parameters<ReturnType<Curviate["account"]>["users"]["update"]>[1];

// ---------------------------------------------------------------------------
// Types (minimal — enough for the run functions to be testable standalone)
// ---------------------------------------------------------------------------

type ProfileFlags = {
  id?: string;
  posts?: boolean;
  comments?: boolean;
  reactions?: boolean;
  followers?: boolean;
  "is-company"?: boolean;
  "endorsement-id"?: string;
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
  sections?: string;
  verbose?: boolean;
};

type SubFlags = {
  id?: string;
  "endorsement-id"?: string;
  account?: string;
  json?: boolean;
  all?: boolean;
  "max-pages"?: string;
  "page-delay"?: string;
  preview?: boolean;
  fields?: string;
  limit?: string;
  cursor?: string;
  verbose?: boolean;
  // profile update body flags (no --description — the v2 op has no such key)
  headline?: string;
  bio?: string;
  "first-name"?: string;
  "last-name"?: string;
  skills?: string;
  picture?: string;
  "background-picture"?: string;
};

type OutputStreams = {
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
};

// Pagination-query shape shared by the profile list reads (limit + cursor).
type ListQuery = { limit?: number; cursor?: string };

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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

function buildOutputStreams(): OutputStreams {
  return {
    stdout: { write: (s: string) => process.stdout.write(s) },
    stderr: { write: (s: string) => process.stderr.write(s) },
  };
}

function resolveOutputOpts(flags: ProfileFlags | SubFlags) {
  return {
    json: (flags.json ?? false) || !process.stdout.isTTY,
    isTTY: process.stdout.isTTY ?? false,
    fields: (flags as ProfileFlags).fields,
    verbose: flags.verbose ?? false,
  };
}

// ---------------------------------------------------------------------------
// Exported run functions (testable without citty)
// ---------------------------------------------------------------------------

/**
 * Run `profile me [--posts|--comments|--reactions|--followers]`.
 * Exported for unit-testing.
 *
 * No activity flag → users.get("me") with optional --sections (base behavior).
 * Activity flag set → the self-scoped list method for the "me" sentinel, via a
 * precedence chain (posts > comments > reactions > followers). v2 accepts the
 * "me" sentinel directly, so there is no getMe pre-call to resolve a slug.
 * Multiple activity flags silently use the first in precedence — no exit 2.
 */
export async function runProfileMe(
  client: Curviate,
  flags: ProfileFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const hasActivityFlag = !!(flags.posts || flags.comments || flags.reactions || flags.followers);

  // --all is only valid when an activity flag is set (list command).
  // On the base users.get path, reject it (a single profile is not paginated).
  if (!hasActivityFlag) {
    rejectAllOnNonPaginated(flags.all, out);
  }

  // --sections "" is always a usage error regardless of activity flags.
  if (flags.sections === "") {
    out.stderr.write("error: --sections must not be empty. Omit the flag or provide section names.\n");
    process.exit(2);
    return;
  }

  const accountId = requireAccount(flags.account, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  if (hasActivityFlag) {
    // Self-scoped activity — "me" is passed straight through to the list method.
    const all = flags.all ?? false;
    const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
    const params: ListQuery = {};
    if (flags.limit) params.limit = parseInt(flags.limit, 10);
    if (flags.cursor) params.cursor = flags.cursor;

    try {
      // Precedence chain: posts > comments > reactions > followers
      if (flags.posts) {
        if (all) {
          const fn = (p: ListQuery) => ns.posts.listUserPosts("me", p);
          for await (const item of streamAll(fn, params, {
            maxPages,
            out,
            pageDelayMs: pageDelayFromFlags(flags),
          })) {
            out.stdout.write(JSON.stringify(item) + "\n");
          }
        } else {
          const result = await ns.posts.listUserPosts("me", params);
          renderSuccess(result, outOpts, out);
        }
      } else if (flags.comments) {
        if (all) {
          const fn = (p: ListQuery) => ns.comments.listUserComments("me", p);
          for await (const item of streamAll(fn, params, {
            maxPages,
            out,
            pageDelayMs: pageDelayFromFlags(flags),
          })) {
            out.stdout.write(JSON.stringify(item) + "\n");
          }
        } else {
          const result = await ns.comments.listUserComments("me", params);
          renderSuccess(result, outOpts, out);
        }
      } else if (flags.reactions) {
        if (all) {
          const fn = (p: ListQuery) => ns.posts.listUserReactions("me", p);
          for await (const item of streamAll(fn, params, {
            maxPages,
            out,
            pageDelayMs: pageDelayFromFlags(flags),
          })) {
            out.stdout.write(JSON.stringify(item) + "\n");
          }
        } else {
          const result = await ns.posts.listUserReactions("me", params);
          renderSuccess(result, outOpts, out);
        }
      } else if (flags.followers) {
        if (all) {
          const fn = (p: ListQuery) => ns.users.listFollowers("me", p);
          for await (const item of streamAll(fn, params, {
            maxPages,
            out,
            pageDelayMs: pageDelayFromFlags(flags),
          })) {
            out.stdout.write(JSON.stringify(item) + "\n");
          }
        } else {
          const result = await ns.users.listFollowers("me", params);
          renderSuccess(result, outOpts, out);
        }
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
    return;
  }

  // Base behavior: no activity flag → users.get("me") with optional sections.
  // D9: auto-prefix bare section values (skills → linkedin_skills) and
  // validate against the served vocabulary — an unknown section is a usage
  // error (exit 2) here, before any network call, not a raw 400 from the API.
  const params: { linkedin_sections?: string[] } = {};
  if (flags.sections) {
    const parsedSections = parseSectionsFlag(flags.sections);
    if (!parsedSections.ok) {
      out.stderr.write(parsedSections.error);
      process.exit(2);
      return;
    }
    params.linkedin_sections = parsedSections.sections;
  }

  try {
    const result = await ns.users.get("me", params);
    const slimOutOpts = { ...outOpts, slim: slimProfileMe };
    renderSuccess(result, slimOutOpts, out);
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
 * Run `profile <id> [--posts|--comments|--reactions|--followers]`.
 * Exported for unit-testing.
 */
export async function runProfileGet(
  client: Curviate,
  flags: ProfileFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  // --sections is a usage error on the default (users.get) branch when
  // empty, or when it contains an unknown section (D9 — validated/prefixed
  // by parseSectionsFlag). Validate early (before the try block) so the
  // mock-throw from process.exit(2) doesn't get swallowed by the catch-all
  // error handler below.
  const isListCommand = flags.posts || flags.comments || flags.reactions || flags.followers;
  if (!isListCommand && flags.sections === "") {
    out.stderr.write("error: --sections must not be empty. Omit the flag or provide section names.\n");
    process.exit(2);
    return;
  }

  let parsedSections: string[] | undefined;
  if (!isListCommand && flags.sections) {
    const result = parseSectionsFlag(flags.sections);
    if (!result.ok) {
      out.stderr.write(result.error);
      process.exit(2);
      return;
    }
    parsedSections = result.sections;
  }

  const accountId = requireAccount(flags.account, out);
  const rawId = flags.id ?? "";
  const resolvedId = resolveIdentifier(rawId);
  const ns = client.account(accountId);

  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
  const limit = flags.limit ? parseInt(flags.limit, 10) : undefined;
  const cursor = flags.cursor;

  try {
    // Select list method by flag
    if (flags.posts) {
      const params: ListQuery = {};
      if (limit !== undefined) params.limit = limit;
      if (cursor) params.cursor = cursor;

      // Company slug resolution: when --is-company and the id is non-numeric
      // (a slug or URL-derived slug), resolve the numeric company id via
      // companies.get before listing posts (the retained v2 retrieve method —
      // the pre-v2 profiles.getCompany was removed upstream).
      let postId = resolvedId;
      if (flags["is-company"]) {
        const isNumericId = /^\d+$/.test(resolvedId);
        if (!isNumericId) {
          const companyData = await ns.companies.get(resolvedId);
          postId = companyData.id;
        }
      }

      if (all) {
        const fn = (p: ListQuery) => ns.posts.listUserPosts(postId, p);
        for await (const item of streamAll(fn, params, {
          maxPages,
          out,
          pageDelayMs: pageDelayFromFlags(flags),
        })) {
          out.stdout.write(JSON.stringify(item) + "\n");
        }
      } else {
        const result = await ns.posts.listUserPosts(postId, params);
        renderSuccess(result, outOpts, out);
      }
    } else if (flags.comments) {
      const params: ListQuery = {};
      if (limit !== undefined) params.limit = limit;
      if (cursor) params.cursor = cursor;

      if (all) {
        const fn = (p: ListQuery) => ns.comments.listUserComments(resolvedId, p);
        for await (const item of streamAll(fn, params, {
          maxPages,
          out,
          pageDelayMs: pageDelayFromFlags(flags),
        })) {
          out.stdout.write(JSON.stringify(item) + "\n");
        }
      } else {
        const result = await ns.comments.listUserComments(resolvedId, params);
        renderSuccess(result, outOpts, out);
      }
    } else if (flags.reactions) {
      const params: ListQuery = {};
      if (limit !== undefined) params.limit = limit;
      if (cursor) params.cursor = cursor;

      if (all) {
        const fn = (p: ListQuery) => ns.posts.listUserReactions(resolvedId, p);
        for await (const item of streamAll(fn, params, {
          maxPages,
          out,
          pageDelayMs: pageDelayFromFlags(flags),
        })) {
          out.stdout.write(JSON.stringify(item) + "\n");
        }
      } else {
        const result = await ns.posts.listUserReactions(resolvedId, params);
        renderSuccess(result, outOpts, out);
      }
    } else if (flags.followers) {
      const params: ListQuery = {};
      if (limit !== undefined) params.limit = limit;
      if (cursor) params.cursor = cursor;

      if (all) {
        const fn = (p: ListQuery) => ns.users.listFollowers(resolvedId, p);
        for await (const item of streamAll(fn, params, {
          maxPages,
          out,
          pageDelayMs: pageDelayFromFlags(flags),
        })) {
          out.stdout.write(JSON.stringify(item) + "\n");
        }
      } else {
        const result = await ns.users.listFollowers(resolvedId, params);
        renderSuccess(result, outOpts, out);
      }
    } else {
      // Default: users.get (accepts a member id/slug/URL, or the "me" sentinel).
      rejectAllOnNonPaginated(flags.all, out);

      // v2 users.get exposes only `linkedin_sections`; the pre-v2 signal-a-view
      // request has no home on this op, so the command carries no such flag.
      // D9: parsedSections is already auto-prefixed and validated above.
      const params: { linkedin_sections?: string[] } = {};
      if (parsedSections) {
        params.linkedin_sections = parsedSections;
      }

      // D7: the sections-enriched users.get call 400s on a raw slug/URL,
      // unlike the plain profile fetch — resolve to the provider id first
      // when --sections is set. "me"/provider-id inputs pass straight
      // through with zero extra calls; the plain (no-sections) fetch is
      // untouched (resolvedId, as before) since that form already works.
      const getId = flags.sections ? await resolveMemberOrMeProviderId(ns, rawId) : resolvedId;

      const result = await ns.users.get(getId, params);
      const getOutOpts = { ...outOpts, slim: slimProfile };
      renderSuccess(result, getOutOpts, out);
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
 * Run `profile relations [--all] [--limit] [--cursor]`.
 * Exported for unit-testing.
 */
export async function runProfileRelations(
  client: Curviate,
  flags: SubFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = requireAccount(flags.account, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
  const limit = flags.limit ? parseInt(flags.limit, 10) : undefined;
  const cursor = (flags as ProfileFlags).cursor;
  const params: ListQuery = {};
  if (limit !== undefined) params.limit = limit;
  if (cursor) params.cursor = cursor;

  try {
    if (all) {
      const fn = (p: ListQuery) => ns.users.listRelations(p);
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.users.listRelations(params);
      renderSuccess(result, outOpts, out);
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
 * Run `profile endorse <id> --endorsement-id <endorsement_id>`.
 * Write command — supports --preview.
 * Exported for unit-testing.
 */
export async function runProfileEndorse(
  client: Curviate,
  flags: SubFlags,
  out: OutputStreams,
): Promise<void> {
  const accountId = requireAccount(flags.account, out);
  const ns = client.account(accountId);
  const skillId = flags["endorsement-id"] ?? "";
  const outOpts = resolveOutputOpts(flags);

  // The endorse write path accepts only a provider id — a slug/URL 404s
  // upstream (same class as follow/unfollow, D6). Resolve to the provider id
  // via a users.get READ (contact-safe — notifies no one, so it runs even
  // under --preview and the preview renders the resolved id). A provider-id
  // input passes straight through with no extra call.
  let providerId: string;
  try {
    providerId = await resolveMemberProviderId(ns, flags.id ?? "");
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
    return; // unreachable: handleSdkError always exits
  }

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "users.endorseSkill",
      args: { id: providerId },
      body: { endorsement_id: skillId },
      account: accountId,
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  try {
    const result = await ns.users.endorseSkill(providerId, { endorsement_id: skillId });
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

// Shared error handler for the new subcommands.
async function handleSdkError(
  err: unknown,
  outOpts: ReturnType<typeof resolveOutputOpts>,
  out: OutputStreams,
): Promise<never> {
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
 * Run `profile subscription` — profile.subscription. Read command — rejects
 * --preview and --all (zero-arg call, no pagination). A free account is a
 * valid, non-error result (has_premium:false, plan_title:null).
 */
export async function runProfileSubscription(
  client: Curviate,
  flags: SubFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);
  rejectAllOnNonPaginated(flags.all, out);

  const accountId = requireAccount(flags.account, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.profile.subscription();
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `profile analytics` — profile.analytics. Read command — rejects
 * --preview and --all (zero-arg call, no pagination). A metric `count` of 0
 * is a real zero; a per-metric null means that card was unavailable.
 */
export async function runProfileAnalytics(
  client: Curviate,
  flags: SubFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);
  rejectAllOnNonPaginated(flags.all, out);

  const accountId = requireAccount(flags.account, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.profile.analytics();
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `profile visitors [--all] [--limit] [--cursor]` — profile.visitors.
 * Read command — rejects --preview. Cursor-paginated (unlike subscription/
 * analytics/ssi, which are single zero-arg reads).
 */
export async function runProfileVisitors(
  client: Curviate,
  flags: SubFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = requireAccount(flags.account, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
  const limit = flags.limit ? parseInt(flags.limit, 10) : undefined;
  const cursor = (flags as ProfileFlags).cursor;
  const params: ListQuery = {};
  if (limit !== undefined) params.limit = limit;
  if (cursor) params.cursor = cursor;

  try {
    if (all) {
      const fn = (p: ListQuery) => ns.profile.visitors(p);
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.profile.visitors(params);
      renderSuccess(result, outOpts, out);
    }
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `profile ssi` — profile.ssi. Read command — rejects --preview and
 * --all (zero-arg call, no pagination). A genuine zero-activity account
 * returns all scalars null with active_seat:false — a valid 200, not an error.
 */
export async function runProfileSsi(
  client: Curviate,
  flags: SubFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);
  rejectAllOnNonPaginated(flags.all, out);

  const accountId = requireAccount(flags.account, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.profile.ssi();
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `profile update` — users.update (own profile only).
 * Write command — supports --preview. Only the provided fields change. The v2
 * op has NO `description` key; `--description` is not defined or forwarded.
 * `--picture`/`--background-picture` take a file path and travel as base64.
 * `--skills` is a comma list of skill names (add-only).
 */
export async function runProfileUpdate(
  client: Curviate,
  flags: SubFlags,
  out: OutputStreams,
): Promise<void> {
  const accountId = requireAccount(flags.account, out);

  const body: Record<string, unknown> = {};
  if (flags["first-name"]) body.first_name = flags["first-name"];
  if (flags["last-name"]) body.last_name = flags["last-name"];
  if (flags.headline) body.headline = flags.headline;
  if (flags.bio) body.bio = flags.bio;
  if (flags.skills) {
    body.skills = flags.skills.split(",").map((s) => s.trim()).filter(Boolean).map((name) => ({ name }));
  }

  // Load picture files (if any) before any SDK call so a bad path fails fast.
  try {
    if (flags.picture) {
      const buf = await readAttachment(flags.picture);
      body.picture = toAttachmentPayload(flags.picture, buf);
    }
    if (flags["background-picture"]) {
      const buf = await readAttachment(flags["background-picture"]);
      body.background_picture = toAttachmentPayload(flags["background-picture"], buf);
    }
  } catch (err: unknown) {
    if (err instanceof AttachError) {
      out.stderr.write(`error: ${err.message}\n`);
      process.exit(err.exitCode);
    }
    throw err;
  }

  if (Object.keys(body).length === 0) {
    out.stderr.write("error: nothing to update — pass at least one of --first-name, --last-name, --headline, --bio, --skills, --picture, --background-picture.\n");
    process.exit(2);
  }

  if (flags.preview) {
    // Render picture fields as a shape marker, never the raw base64 bytes.
    const previewBody: Record<string, unknown> = { ...body };
    if (previewBody.picture) previewBody.picture = "<base64 image>";
    if (previewBody.background_picture) previewBody.background_picture = "<base64 image>";
    const preview = buildPreviewOutput({ method: "users.update", args: { user_id: "me" }, body: previewBody, account: accountId });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  try {
    // Narrow cast at the body-argument call site: skills/picture are shaped to
    // the generated body above.
    const result = await ns.users.update("me", body as UserUpdateBody);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `profile follow <id>` — users.follow (bodyless write, supports --preview).
 * The follow endpoint accepts only a provider id (a slug 404s, D6), so the raw
 * identifier is resolved to a provider id via a users.get READ first — the same
 * auto-resolution `profile`/`connect`/`message` give. The read runs even under
 * --preview (it notifies no one) so the preview renders the resolved id.
 */
export async function runProfileFollow(
  client: Curviate,
  flags: SubFlags,
  out: OutputStreams,
): Promise<void> {
  const accountId = requireAccount(flags.account, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  let providerId: string;
  try {
    providerId = await resolveMemberProviderId(ns, flags.id ?? "");
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
    return; // unreachable: handleSdkError always exits
  }

  if (flags.preview) {
    const preview = buildPreviewOutput({ method: "users.follow", args: { user_id: providerId }, body: {}, account: accountId });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  try {
    const result = await ns.users.follow(providerId);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `profile unfollow <id>` — users.unfollow (bodyless write, supports
 * --preview). Same provider-id resolution as `profile follow` (D6).
 */
export async function runProfileUnfollow(
  client: Curviate,
  flags: SubFlags,
  out: OutputStreams,
): Promise<void> {
  const accountId = requireAccount(flags.account, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  let providerId: string;
  try {
    providerId = await resolveMemberProviderId(ns, flags.id ?? "");
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
    return; // unreachable: handleSdkError always exits
  }

  if (flags.preview) {
    const preview = buildPreviewOutput({ method: "users.unfollow", args: { user_id: providerId }, body: {}, account: accountId });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  try {
    const result = await ns.users.unfollow(providerId);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/** Run `profile followers <id>` — users.listFollowers (paginated read). */
export async function runProfileFollowers(
  client: Curviate,
  flags: SubFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);
  const accountId = requireAccount(flags.account, out);
  const resolvedId = resolveIdentifier(flags.id ?? "");
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
  const params: ListQuery = {};
  if (flags.limit) params.limit = parseInt(flags.limit, 10);
  if (flags.cursor) params.cursor = flags.cursor;

  try {
    if (all) {
      const fn = (p: ListQuery) => ns.users.listFollowers(resolvedId, p);
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.users.listFollowers(resolvedId, params);
      renderSuccess(result, outOpts, out);
    }
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/** Run `profile following <id>` — users.listFollowing (paginated read). */
export async function runProfileFollowing(
  client: Curviate,
  flags: SubFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);
  const accountId = requireAccount(flags.account, out);
  const resolvedId = resolveIdentifier(flags.id ?? "");
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
  const params: ListQuery = {};
  if (flags.limit) params.limit = parseInt(flags.limit, 10);
  if (flags.cursor) params.cursor = flags.cursor;

  try {
    if (all) {
      const fn = (p: ListQuery) => ns.users.listFollowing(resolvedId, p);
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.users.listFollowing(resolvedId, params);
      renderSuccess(result, outOpts, out);
    }
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

// ---------------------------------------------------------------------------
// Citty command definitions
// ---------------------------------------------------------------------------

const profileMeCommand = defineCommand({
  meta: { name: "me", description: "Get your own profile, or list own activity with --posts/--comments/--reactions/--followers." },
  args: {
    ...GLOBAL_FLAGS,
    sections: {
      type: "string",
      description:
        "Comma-separated LinkedIn sections to fetch — linkedin_experience, linkedin_education, linkedin_languages, " +
        "linkedin_skills, linkedin_certifications, linkedin_volunteer_experience, linkedin_projects, linkedin_recommendations, " +
        "linkedin_interests, or linkedin_* for all (each also has a _preview variant). A bare value (e.g. skills) is " +
        "auto-prefixed to linkedin_skills. Only applies to the base getMe call (no activity flag).",
    },
    posts: {
      type: "boolean",
      description: "List own activity feed (posts + reposts). For authored-only posts, use 'post list'.",
      default: false,
    },
    comments: {
      type: "boolean",
      description: "List own comments.",
      default: false,
    },
    reactions: {
      type: "boolean",
      description: "List own reactions.",
      default: false,
    },
    followers: {
      type: "boolean",
      description: "List own followers.",
      default: false,
    },
  },
  async run({ args }) {
    const flags = args as ProfileFlags;
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
    await runProfileMe(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const profileRelationsCommand = defineCommand({
  meta: { name: "relations", description: "List your 1st-degree connections." },
  args: { ...GLOBAL_FLAGS },
  async run({ args }) {
    const flags = args as ProfileFlags;
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
    await runProfileRelations(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const profileEndorseCommand = defineCommand({
  meta: { name: "endorse", description: "Endorse a skill on a member's profile." },
  args: {
    ...GLOBAL_FLAGS,
    id: { type: "positional", description: "Member identifier (URL, slug, or provider id). A URL/slug is resolved to the provider id automatically (a slug is not accepted directly by the endorse endpoint)." },
    "endorsement-id": {
      type: "string",
      description: "Endorsement ID to endorse — get it from the target's skills section via `profile <id> --sections linkedin_skills`.",
      required: true,
    },
  },
  async run({ args }) {
    const flags = args as SubFlags;
    const cfg = await resolveEffectiveConfig({
      apiKey: (args as ProfileFlags)["api-key"],
      baseUrl: (args as ProfileFlags)["base-url"],
      timeout: (args as ProfileFlags).timeout,
      account: flags.account,
      profile: (args as ProfileFlags).profile,
    });
    if (!cfg.apiKey) {
      process.stderr.write("error: no API key — run `curviate login` or pass --api-key.\n");
      process.exit(3);
    }
    const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeout: cfg.timeout });
    const out = buildOutputStreams();
    await runProfileEndorse(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

/** Shared config/client boilerplate for a subcommand's run(). */
async function withClient(
  flags: SubFlags & { "api-key"?: string; "base-url"?: string; timeout?: string; profile?: string },
  fn: (client: Curviate, flags: SubFlags, out: OutputStreams) => Promise<void>,
): Promise<void> {
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
  await fn(client, { ...flags, account: flags.account ?? cfg.account }, out);
}

const profileUpdateCommand = defineCommand({
  meta: { name: "update", description: "Update your own profile (headline, bio, name, skills, photos)." },
  args: {
    ...WRITE_SINGLE_FLAGS,
    headline: { type: "string", description: "New headline." },
    bio: { type: "string", description: "New about/bio text." },
    "first-name": { type: "string", description: "New first name." },
    "last-name": { type: "string", description: "New last name." },
    skills: { type: "string", description: "Comma-separated skill names to add (add-only)." },
    picture: { type: "string", description: "New profile photo — path to an image file." },
    "background-picture": { type: "string", description: "New cover/banner photo — path to an image file." },
  },
  async run({ args }) {
    await withClient(args as SubFlags, runProfileUpdate);
  },
});

const profileFollowCommand = defineCommand({
  meta: { name: "follow", description: "Follow a member (sends a connect request if their profile is private)." },
  args: {
    ...WRITE_SINGLE_FLAGS,
    id: { type: "positional", description: "Member identifier (URL, slug, provider id)." },
  },
  async run({ args }) {
    await withClient(args as SubFlags, runProfileFollow);
  },
});

const profileUnfollowCommand = defineCommand({
  meta: { name: "unfollow", description: "Unfollow a member (idempotent)." },
  args: {
    ...WRITE_SINGLE_FLAGS,
    id: { type: "positional", description: "Member identifier (URL, slug, provider id)." },
  },
  async run({ args }) {
    await withClient(args as SubFlags, runProfileUnfollow);
  },
});

const profileFollowersCommand = defineCommand({
  meta: { name: "followers", description: "List a member's followers (accepts 'me')." },
  args: {
    ...GLOBAL_FLAGS,
    id: { type: "positional", description: "Member identifier (URL, slug, provider id, or 'me')." },
  },
  async run({ args }) {
    await withClient(args as SubFlags, runProfileFollowers);
  },
});

const profileFollowingCommand = defineCommand({
  meta: { name: "following", description: "List who a member follows (accepts 'me')." },
  args: {
    ...GLOBAL_FLAGS,
    id: { type: "positional", description: "Member identifier (URL, slug, provider id, or 'me')." },
  },
  async run({ args }) {
    await withClient(args as SubFlags, runProfileFollowing);
  },
});

const profileSubscriptionCommand = defineCommand({
  meta: { name: "subscription", description: "Read your premium subscription: entitlements, primary plan, and LinkedIn management links. A free account is a valid result (has_premium:false)." },
  args: { ...READ_SINGLE_FLAGS },
  async run({ args }) {
    await withClient(args as SubFlags, runProfileSubscription);
  },
});

const profileAnalyticsCommand = defineCommand({
  meta: { name: "analytics", description: "Read your performance headline metrics: profile viewers, followers, post impressions, and search appearances (fixed LinkedIn reporting windows, no window selector)." },
  args: { ...READ_SINGLE_FLAGS },
  async run({ args }) {
    await withClient(args as SubFlags, runProfileAnalytics);
  },
});

const profileVisitorsCommand = defineCommand({
  meta: { name: "visitors", description: "List people who recently viewed your profile, classified by disclosure fidelity (identified, semi-anonymous, or aggregate; Premium sees more identified viewers)." },
  args: { ...GLOBAL_FLAGS },
  async run({ args }) {
    await withClient(args as SubFlags, runProfileVisitors);
  },
});

const profileSsiCommand = defineCommand({
  meta: { name: "ssi", description: "Read your Social Selling Index: the overall score, its four pillar breakdowns, and industry/network percentile ranks." },
  args: { ...READ_SINGLE_FLAGS },
  async run({ args }) {
    await withClient(args as SubFlags, runProfileSsi);
  },
});

export const profileCommand = defineCommand({
  meta: { name: "profile", description: "LinkedIn profile operations." },
  args: {
    ...GLOBAL_FLAGS,
    id: { type: "positional", description: "Member identifier (URL, slug, or URN). Optional for subcommands.", required: false },
    posts: { type: "boolean", description: "List the profile's posts.", default: false },
    comments: { type: "boolean", description: "List the profile's comments.", default: false },
    reactions: { type: "boolean", description: "List the profile's reactions.", default: false },
    followers: { type: "boolean", description: "List the profile's followers.", default: false },
    "is-company": { type: "boolean", description: "When listing posts, treat the profile as a company page.", default: false },
    sections: {
      type: "string",
      description:
        "Comma-separated LinkedIn sections to fetch — linkedin_experience, linkedin_education, linkedin_languages, " +
        "linkedin_skills, linkedin_certifications, linkedin_volunteer_experience, linkedin_projects, linkedin_recommendations, " +
        "linkedin_interests, or linkedin_* for all (each also has a _preview variant). A bare value (e.g. skills) is " +
        "auto-prefixed to linkedin_skills.",
    },
  },
  subCommands: {
    me: profileMeCommand,
    relations: profileRelationsCommand,
    endorse: profileEndorseCommand,
    update: profileUpdateCommand,
    follow: profileFollowCommand,
    unfollow: profileUnfollowCommand,
    followers: profileFollowersCommand,
    following: profileFollowingCommand,
    subscription: profileSubscriptionCommand,
    analytics: profileAnalyticsCommand,
    visitors: profileVisitorsCommand,
    ssi: profileSsiCommand,
  },
  async run({ args }) {
    const flags = args as ProfileFlags;

    // If an <id> positional was given, we treat this as `profile <id> [flags]`.
    if (!flags.id) {
      process.stderr.write(
        "Usage: curviate profile <id> [--posts|--comments|--reactions|--followers]\n" +
        "       curviate profile me\n" +
        "       curviate profile relations\n" +
        "       curviate profile followers <id> | following <id>\n" +
        "       curviate profile follow <id> | unfollow <id>\n" +
        "       curviate profile update [--headline|--bio|--first-name|--last-name|--skills|--picture]\n" +
        "       curviate profile endorse <id> --endorsement-id <id>\n",
      );
      // <id> is functionally required for the bare form — a missing required
      // positional is a usage error (exit 2), not a silent success.
      // `required: false` on the citty arg def exists only so this richer
      // usage block can run instead of citty's generic one-liner.
      process.exit(2);
    }

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
    await runProfileGet(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});
