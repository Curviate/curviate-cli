/**
 * `curviate job`, classic job-posting operations (own postings + public read).
 *
 * Subcommands:
 *   job get <url|id>: retrieve one public job posting (read)
 *   job list --state <s|ALL>: list own postings by state (ALL = client-side union, read, paginated)
 *   job create <flags>: create a draft posting (write)
 *   job update <id> <flags>: partial update of a posting (write)
 *   job budget <id>: price a publish before committing money (read)
 *   job publish <id> --mode <m>: publish a draft (write; PROMOTED* spends money)
 *   job close <id>: stop accepting applications (write, bodyless)
 *   job applicants <id>: list applicants (read, POST-as-search)
 *   job applicant get <id> <app_id>: one applicant's full detail (read)
 *   job applicant resume <id> <app_id> -o <f>: download an applicant's résumé (binary)
 *
 * Account-scoped. Read commands reject --preview (exit 2); write commands render
 * --preview and never touch the network under it. A paid publish
 * (PROMOTED/PROMOTED_PLUS) requires an explicit budget, supplying it IS the
 * opt-in to spend real money on the connected account's LinkedIn payment method.
 *
 * D10: `job list --state` is best-effort upstream (LinkedIn, not this CLI,
 * decides how strictly to honor it), every returned page is re-filtered
 * against each item's own `state` before reaching output (a stderr note
 * reports dropped items); the upstream pagination cursor is unaffected, so
 * `--all` still walks the same unfiltered upstream pages. See
 * `filterJobsByState`/`requestStateToItemState` below.
 */

import { requireAccount } from "../lib/account-arg.js";
import { defineCommand } from "citty";
import { READ_SINGLE_FLAGS, WRITE_SINGLE_FLAGS, GLOBAL_FLAGS } from "../lib/global-flags.js";
import { resolveJobIdentifier } from "../lib/identifier.js";
import { resolveEffectiveConfig } from "../lib/resolve.js";
import { createClient } from "../lib/client.js";
import { renderSuccess, renderError, renderUnexpectedError } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { streamAll, pageDelayFromFlags, ndjsonModeNotice, DEFAULT_PAGE_DELAY_MS } from "../lib/paginate.js";
import { writeBinaryOutput, BinaryOutputError } from "../lib/binary.js";
import { slimJob } from "../lib/slim.js";
import type { Curviate, CurviateError } from "@curviate/sdk";

// ---------------------------------------------------------------------------
// Types, request bodies/queries derived from the real SDK method signatures
// so a shape drift is a compile error, not a latent runtime break.
// ---------------------------------------------------------------------------

type AccountNs = ReturnType<Curviate["account"]>;
type CreateJobBody = Parameters<AccountNs["jobs"]["create"]>[0];
type UpdateJobBody = Parameters<AccountNs["jobs"]["update"]>[1];
type PublishJobBody = Parameters<AccountNs["jobs"]["publish"]>[1];
type JobListQuery = Parameters<AccountNs["jobs"]["list"]>[0];
type JobListPage = Awaited<ReturnType<AccountNs["jobs"]["list"]>>;
type JobListItem = JobListPage["items"][number];
type ListApplicantsParams = NonNullable<Parameters<AccountNs["jobs"]["listApplicants"]>[1]>;

type JobFlags = {
  id?: string;
  applicantId?: string;
  // list
  state?: string;
  // create / update
  "job-title"?: string;
  "job-title-id"?: string;
  company?: string;
  "company-id"?: string;
  "workplace-type"?: string;
  location?: string;
  "employment-status"?: string;
  description?: string;
  "apply-method"?: string;
  "notification-email"?: string;
  "website-url"?: string;
  skills?: string;
  // publish
  mode?: string;
  "budget-currency"?: string;
  "budget-amount"?: string;
  "budget-scope"?: string;
  // applicants
  ratings?: string;
  // binary
  output?: string;
  // global
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


const JOB_STATES = ["DRAFT", "OPEN", "CLOSED", "REVIEW", "SUSPENDED"] as const;
const WORKPLACE_TYPES = ["ON_SITE", "HYBRID", "REMOTE"] as const;
const EMPLOYMENT_STATUSES = ["FULL_TIME", "PART_TIME", "CONTRACT", "TEMPORARY", "OTHER", "VOLUNTEER", "INTERNSHIP"] as const;
const APPLY_METHODS = ["linkedin", "external"] as const;
const PUBLISH_MODES = ["FREE", "PROMOTED", "PROMOTED_PLUS"] as const;
const BUDGET_SCOPES = ["DAILY", "TOTAL"] as const;
const RATINGS = ["UNRATED", "NOT_A_FIT", "MAYBE", "GOOD_FIT"] as const;

// ---------------------------------------------------------------------------
// D10: `job list --state` client-side re-filter.
//
// LinkedIn applies the upstream state filter on a best-effort basis: OPEN
// commonly returns the same postings as DRAFT, and no query is guaranteed to
// return an item whose own `state` is LISTED even though LISTED is a valid
// value of that field (per the SDK's own documented contract on this query
// param). Silent wrong-filtering is worse than honesty, so every returned
// page is re-filtered here against each item's own `state` before it reaches
// --json output.
//
// The request vocabulary (JOB_STATES: DRAFT|OPEN|CLOSED|REVIEW|SUSPENDED)
// and the response item's own `state` field
// (DRAFT|LISTED|CLOSED|REVIEW|SUSPENDED) differ in exactly one value: the
// request's OPEN corresponds to the response's LISTED. Every other value is
// the identical string on both sides.
//
// This is a PAGE-LOCAL filter, not a global one: it never changes the
// pagination cursor. The cursor comes from the upstream response's own
// `cursor` field, untouched by which items survive filtering -- `--all`
// keeps walking the same unfiltered upstream pages it always did, it just
// stops re-emitting items that don't match their own state.
// ---------------------------------------------------------------------------

function requestStateToItemState(state: string): string {
  return state === "OPEN" ? "LISTED" : state;
}

function filterJobsByState(
  items: readonly JobListItem[] | undefined,
  requestedState: string,
): { items: JobListItem[]; dropped: number } {
  const source = items ?? [];
  const wantedState = requestStateToItemState(requestedState);
  const filtered = source.filter((item) => item.state === wantedState);
  return { items: filtered, dropped: source.length - filtered.length };
}

function stateFilterDroppedNote(dropped: number, total: number, requestedState: string): string {
  return `note: LinkedIn's --state filter is best-effort -- dropped ${dropped} of ${total} returned item(s) on this page whose own state was not "${requestedState}". The page walk itself is unaffected (upstream pages are fetched unfiltered).\n`;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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

function resolveOutputOpts(flags: JobFlags) {
  return {
    json: (flags.json ?? false) || !process.stdout.isTTY,
    isTTY: process.stdout.isTTY ?? false,
    fields: flags.fields,
    verbose: flags.verbose ?? false,
  };
}

/** Exit 2, naming the missing required flag. */
function requireFlag(value: string | undefined, flag: string, out: OutputStreams): string {
  if (!value) {
    out.stderr.write(`error: ${flag} is required.\n`);
    process.exit(2);
  }
  return value;
}

/** Exit 2 when a value is outside its allowed enum, naming the flag. */
function requireEnum(value: string, allowed: readonly string[], flag: string, out: OutputStreams): void {
  if (!allowed.includes(value)) {
    out.stderr.write(`error: ${flag} must be one of: ${allowed.join(", ")}. Got "${value}".\n`);
    process.exit(2);
  }
}

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
 * Build a { id? , name? } reference object from an id flag and a name flag.
 * Returns undefined when neither is set (so update can omit it). `create`
 * validates presence separately (naming the flag) before calling this.
 */
function buildRef(idValue: string | undefined, nameValue: string | undefined): { id?: string; name?: string } | undefined {
  if (idValue) return { id: idValue };
  if (nameValue) return { name: nameValue };
  return undefined;
}

/**
 * Build the apply_method oneOf from --apply-method + its companion flag.
 * `linkedin` needs --notification-email; `external` needs --website-url.
 * On a required call site (create), a missing companion exits 2 naming it.
 */
function buildApplyMethod(flags: JobFlags, out: OutputStreams): { method: string; notification_email?: string; website_url?: string } {
  const method = flags["apply-method"] ?? "";
  requireEnum(method, APPLY_METHODS, "--apply-method", out);
  if (method === "linkedin") {
    const email = requireFlag(flags["notification-email"], "--notification-email (required when --apply-method is linkedin)", out);
    return { method, notification_email: email };
  }
  const url = requireFlag(flags["website-url"], "--website-url (required when --apply-method is external)", out);
  return { method, website_url: url };
}

// ---------------------------------------------------------------------------
// Read run functions
// ---------------------------------------------------------------------------

/**
 * Run `job get <url|id>`.
 * Read command, rejects --preview (exit 2), no SDK call in that case.
 */
export async function runJobGet(client: Curviate, flags: JobFlags, out: OutputStreams): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);
  const accountId = await requireAccount(client, flags.account, out);
  const resolvedId = resolveJobIdentifier(flags.id ?? "");
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.jobs.get(resolvedId);
    renderSuccess(result, { ...outOpts, slim: slimJob }, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `job list --state <s>`, jobs.list (paginated read). --state is required.
 *
 * D10: LinkedIn's state filter is best-effort, every returned page is
 * re-filtered against each item's own `state` before reaching output, so
 * --json only ever contains real matches (a stderr note reports how many
 * were dropped). This is page-local: it never touches the pagination
 * cursor, which is threaded from the unfiltered upstream response, `--all`
 * walks exactly the same upstream pages it always did.
 */
export async function runJobList(client: Curviate, flags: JobFlags, out: OutputStreams): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);
  const accountId = await requireAccount(client, flags.account, out);
  const state = requireFlag(flags.state, "--state", out);

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
  const pageDelayMs = pageDelayFromFlags(flags);

  // --state ALL -> a best-effort client-side union over every enum state.
  if (state === "ALL") {
    await runJobListAllStates(ns, flags, out, outOpts, { all, maxPages, pageDelayMs });
    return;
  }
  requireEnum(state, JOB_STATES, "--state", out);

  const base: { state: string; limit?: number; cursor?: string } = { state };
  if (flags.limit) base.limit = parseInt(flags.limit, 10);
  if (flags.cursor) base.cursor = flags.cursor;

  try {
    if (all) {
      // Narrow cast at the query-argument call site: state is validated above.
      // Re-filter each page's items in the wrapped fn (not after streamAll
      // flattens them) so the note stays page-local and streamAll's own
      // cursor/truncation bookkeeping, driven by the untouched page.cursor
      //, never sees the filtering at all.
      const fn = (p: typeof base) =>
        ns.jobs.list(p as JobListQuery).then((page) => {
          const { items: filtered, dropped } = filterJobsByState(page.items, state);
          if (dropped > 0) {
            out.stderr.write(stateFilterDroppedNote(dropped, page.items?.length ?? 0, state));
          }
          return { ...page, items: filtered };
        });
      for await (const item of streamAll(fn, base, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.jobs.list(base as JobListQuery);
      const { items: filtered, dropped } = filterJobsByState(result.items, state);
      if (dropped > 0) {
        out.stderr.write(stateFilterDroppedNote(dropped, result.items?.length ?? 0, state));
      }
      renderSuccess({ ...result, items: filtered }, outOpts, out);
    }
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/** A modest inter-request pause reused between per-state fetches in a union. */
function pace(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

const JOB_LIST_UNION_CAVEAT =
  "note: --state ALL is a best-effort client-side union over DRAFT/OPEN/CLOSED/REVIEW/SUSPENDED. " +
  "LinkedIn's per-state filter is best-effort, so each state is queried, its items are re-filtered against their own state, " +
  "and the results are merged and de-duplicated by id. There is no unified pagination cursor; each state is walked " +
  "independently and --max-pages applies per state.\n";

/** The stable id of a job-list item (for cross-state de-duplication), if present. */
function jobItemId(item: unknown): string | undefined {
  const id = (item as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

/**
 * Run `job list --state ALL`, a best-effort client-side union over every enum
 * state. Each state is queried and re-filtered against its own `state` (LinkedIn's
 * filter is best-effort), then results are merged and de-duplicated by id. A
 * modest pause separates the per-state fetches (pacing). With `--all`, each
 * state's pages are streamed as NDJSON and de-duplicated across the whole union;
 * without it, the first page of each state is merged into one envelope (no
 * unified cursor).
 */
async function runJobListAllStates(
  ns: AccountNs,
  flags: JobFlags,
  out: OutputStreams,
  outOpts: ReturnType<typeof resolveOutputOpts>,
  opts: { all: boolean; maxPages: number; pageDelayMs: number | undefined },
): Promise<void> {
  const { all, maxPages, pageDelayMs } = opts;
  const betweenStatesDelay = pageDelayMs ?? DEFAULT_PAGE_DELAY_MS;
  const limit = flags.limit ? parseInt(flags.limit, 10) : undefined;
  const seen = new Set<string>();

  try {
    if (all) {
      // The union owns the NDJSON notice + the caveat + cross-state dedupe; the
      // per-state streamAll gets no `out` (a per-state truncation sentinel would
      // be misleading inside a merged stream).
      out.stderr.write(ndjsonModeNotice());
      out.stderr.write(JOB_LIST_UNION_CAVEAT);
      for (let i = 0; i < JOB_STATES.length; i++) {
        const s = JOB_STATES[i]!;
        const base: { state: string; limit?: number } = { state: s };
        if (limit !== undefined) base.limit = limit;
        const fn = (p: typeof base) =>
          ns.jobs.list(p as JobListQuery).then((page) => ({
            ...page,
            items: filterJobsByState(page.items, s).items,
          }));
        // The union owns its own NDJSON notice, caveat, and cross-state dedupe,
        // so this per-state streamAll deliberately gets no `out` (a per-state
        // truncation sentinel would be misleading in a merged stream). The
        // marker below is a documented exception for the call-site gate.
        for await (const item of streamAll(fn, base, { maxPages, pageDelayMs /* union-aggregate-no-out */ })) {
          const id = jobItemId(item);
          if (id !== undefined && seen.has(id)) continue;
          if (id !== undefined) seen.add(id);
          out.stdout.write(JSON.stringify(item) + "\n");
        }
        if (i < JOB_STATES.length - 1) await pace(betweenStatesDelay);
      }
    } else {
      out.stderr.write(JOB_LIST_UNION_CAVEAT);
      const merged: JobListItem[] = [];
      for (let i = 0; i < JOB_STATES.length; i++) {
        const s = JOB_STATES[i]!;
        const base: { state: string; limit?: number } = { state: s };
        if (limit !== undefined) base.limit = limit;
        const page = await ns.jobs.list(base as JobListQuery);
        const { items: filtered } = filterJobsByState(page.items, s);
        for (const item of filtered) {
          const id = jobItemId(item);
          if (id !== undefined && seen.has(id)) continue;
          if (id !== undefined) seen.add(id);
          merged.push(item);
        }
        if (i < JOB_STATES.length - 1) await pace(betweenStatesDelay);
      }
      renderSuccess({ object: "list", items: merged, cursor: null }, outOpts, out);
    }
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/** Run `job budget <id>`, jobs.getBudget (single read). */
export async function runJobBudget(client: Curviate, flags: JobFlags, out: OutputStreams): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);
  const accountId = await requireAccount(client, flags.account, out);
  const jobId = resolveJobIdentifier(flags.id ?? "");
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.jobs.getBudget(jobId);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/** Run `job applicants <id>`, jobs.listApplicants (POST-as-search, paginated read). */
export async function runJobApplicants(client: Curviate, flags: JobFlags, out: OutputStreams): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);
  const accountId = await requireAccount(client, flags.account, out);
  const jobId = resolveJobIdentifier(flags.id ?? "");
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;

  // Filter body (ratings) + top-level pagination merged into one param object,
  // matching the SDK's POST-as-search convention.
  const base: Record<string, unknown> = {};
  if (flags.ratings) {
    const ratings = flags.ratings.split(",").map((r) => r.trim()).filter(Boolean);
    for (const r of ratings) requireEnum(r, RATINGS, "--ratings", out);
    base.ratings = ratings;
  }
  if (flags.limit) base.limit = parseInt(flags.limit, 10);
  if (flags.cursor) base.cursor = flags.cursor;

  try {
    if (all) {
      const fn = (p: Record<string, unknown>) => ns.jobs.listApplicants(jobId, p as ListApplicantsParams);
      for await (const item of streamAll(fn, base, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.jobs.listApplicants(jobId, base as ListApplicantsParams);
      renderSuccess(result, outOpts, out);
    }
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/** Run `job applicant get <id> <app_id>`, jobs.getApplicant (single read). */
export async function runJobApplicantGet(client: Curviate, flags: JobFlags, out: OutputStreams): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);
  const accountId = await requireAccount(client, flags.account, out);
  const jobId = resolveJobIdentifier(flags.id ?? "");
  const applicantId = flags.applicantId ?? "";
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.jobs.getApplicant(jobId, applicantId);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `job applicant resume <id> <app_id> -o <file>`, jobs.downloadResume (binary).
 * Read command, rejects --preview. Refuses to dump bytes to a TTY without -o.
 * @param isTTY injectable for tests.
 */
export async function runJobApplicantResume(client: Curviate, flags: JobFlags, out: OutputStreams, isTTY: boolean): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);
  const accountId = await requireAccount(client, flags.account, out);
  const jobId = resolveJobIdentifier(flags.id ?? "");
  const applicantId = flags.applicantId ?? "";
  const ns = client.account(accountId);

  try {
    const data = await ns.jobs.downloadResume(jobId, applicantId);
    await writeBinaryOutput(data, { outputPath: flags.output, isTTY, stdout: process.stdout });
  } catch (err: unknown) {
    if (err instanceof BinaryOutputError) {
      out.stderr.write(`error: ${err.message}\n`);
      process.exit(err.exitCode);
    }
    await handleSdkError(err, resolveOutputOpts(flags), out);
  }
}

// ---------------------------------------------------------------------------
// Write run functions
// ---------------------------------------------------------------------------

/** Run `job create <flags>`, jobs.create. All 7 body fields are required. */
export async function runJobCreate(client: Curviate, flags: JobFlags, out: OutputStreams): Promise<void> {
  const accountId = await requireAccount(client, flags.account, out);

  // Validate every required field FIRST, naming the missing flag (exit 2,
  // before any SDK call).
  if (!flags["job-title"] && !flags["job-title-id"]) {
    out.stderr.write("error: --job-title (a free-text name) or --job-title-id is required.\n");
    process.exit(2);
  }
  if (!flags.company && !flags["company-id"]) {
    out.stderr.write("error: --company (a free-text name) or --company-id is required.\n");
    process.exit(2);
  }
  const workplaceType = requireFlag(flags["workplace-type"], "--workplace-type", out);
  requireEnum(workplaceType, WORKPLACE_TYPES, "--workplace-type", out);
  const location = requireFlag(flags.location, "--location", out);
  const employmentStatus = requireFlag(flags["employment-status"], "--employment-status", out);
  requireEnum(employmentStatus, EMPLOYMENT_STATUSES, "--employment-status", out);
  const description = requireFlag(flags.description, "--description", out);
  requireFlag(flags["apply-method"], "--apply-method", out);
  const applyMethod = buildApplyMethod(flags, out);

  const body: Record<string, unknown> = {
    job_title: buildRef(flags["job-title-id"], flags["job-title"]),
    company: buildRef(flags["company-id"], flags.company),
    workplace_type: workplaceType,
    location,
    employment_status: employmentStatus,
    description,
    apply_method: applyMethod,
  };
  if (flags.skills) {
    body.skills = flags.skills.split(",").map((s) => s.trim()).filter(Boolean);
  }

  if (flags.preview) {
    const preview = buildPreviewOutput({ method: "jobs.create", args: {}, body, account: accountId });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  try {
    // Narrow cast at the body-argument call site: every required field is
    // validated above; apply_method is a method-discriminated oneOf.
    const result = await ns.jobs.create(body as CreateJobBody);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/** Run `job update <id> <flags>`, jobs.update. Only the provided fields change. */
export async function runJobUpdate(client: Curviate, flags: JobFlags, out: OutputStreams): Promise<void> {
  const accountId = await requireAccount(client, flags.account, out);
  const jobId = resolveJobIdentifier(flags.id ?? "");

  const body: Record<string, unknown> = {};
  const jobTitle = buildRef(flags["job-title-id"], flags["job-title"]);
  if (jobTitle) body.job_title = jobTitle;
  const company = buildRef(flags["company-id"], flags.company);
  if (company) body.company = company;
  if (flags["workplace-type"]) {
    requireEnum(flags["workplace-type"], WORKPLACE_TYPES, "--workplace-type", out);
    body.workplace_type = flags["workplace-type"];
  }
  if (flags.location) body.location = flags.location;
  if (flags["employment-status"]) {
    requireEnum(flags["employment-status"], EMPLOYMENT_STATUSES, "--employment-status", out);
    body.employment_status = flags["employment-status"];
  }
  if (flags.description) body.description = flags.description;
  if (flags["apply-method"]) body.apply_method = buildApplyMethod(flags, out);
  if (flags.skills) body.skills = flags.skills.split(",").map((s) => s.trim()).filter(Boolean);

  if (flags.preview) {
    const preview = buildPreviewOutput({ method: "jobs.update", args: { job_id: jobId }, body, account: accountId });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  try {
    const result = await ns.jobs.update(jobId, body as UpdateJobBody);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `job publish <id> --mode <m>`, jobs.publish.
 * --mode is required. PROMOTED/PROMOTED_PLUS require a full --budget-* triple,
 * supplying it is the explicit opt-in to spend real money.
 */
export async function runJobPublish(client: Curviate, flags: JobFlags, out: OutputStreams): Promise<void> {
  const accountId = await requireAccount(client, flags.account, out);
  const jobId = resolveJobIdentifier(flags.id ?? "");
  const mode = requireFlag(flags.mode, "--mode", out);
  requireEnum(mode, PUBLISH_MODES, "--mode", out);

  let body: Record<string, unknown> = { mode };
  if (mode === "PROMOTED" || mode === "PROMOTED_PLUS") {
    const currency = requireFlag(flags["budget-currency"], "--budget-currency (required for a paid publish)", out);
    const amountRaw = requireFlag(flags["budget-amount"], "--budget-amount (required for a paid publish)", out);
    const scope = requireFlag(flags["budget-scope"], "--budget-scope (required for a paid publish)", out);
    requireEnum(scope, BUDGET_SCOPES, "--budget-scope", out);
    const amount = Number(amountRaw);
    if (!Number.isFinite(amount) || amount < 0) {
      out.stderr.write("error: --budget-amount must be a non-negative number.\n");
      process.exit(2);
    }
    body = { mode, budget: { currency, amount, scope } };
  }

  if (flags.preview) {
    const preview = buildPreviewOutput({ method: "jobs.publish", args: { job_id: jobId }, body, account: accountId });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  try {
    // Narrow cast at the body-argument call site: mode + budget are validated
    // above; the body is a mode-discriminated oneOf.
    const result = await ns.jobs.publish(jobId, body as PublishJobBody);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/** Run `job close <id>`, jobs.close (bodyless write). */
export async function runJobClose(client: Curviate, flags: JobFlags, out: OutputStreams): Promise<void> {
  const accountId = await requireAccount(client, flags.account, out);
  const jobId = resolveJobIdentifier(flags.id ?? "");

  if (flags.preview) {
    const preview = buildPreviewOutput({ method: "jobs.close", args: { job_id: jobId }, body: {}, account: accountId });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  try {
    const result = await ns.jobs.close(jobId);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

// ---------------------------------------------------------------------------
// Citty command definitions
// ---------------------------------------------------------------------------

/** Shared config/client boilerplate for a subcommand's run(). */
async function withClient(
  flags: JobFlags,
  fn: (client: Curviate, flags: JobFlags, out: OutputStreams) => Promise<void>,
): Promise<void> {
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
  await fn(client, { ...flags, account: flags.account ?? cfg.account }, out);
}

// Shared body flags for create/update (kebab -> snake_case body keys).
const JOB_BODY_FLAGS = {
  "job-title": { type: "string" as const, description: "Job title as free text (or use --job-title-id for an existing LinkedIn title)." },
  "job-title-id": { type: "string" as const, description: "Existing LinkedIn job-title id." },
  company: { type: "string" as const, description: "Hiring company as free text (or use --company-id)." },
  "company-id": { type: "string" as const, description: "Existing company id." },
  "workplace-type": { type: "string" as const, description: "Workplace arrangement: ON_SITE|HYBRID|REMOTE." },
  location: { type: "string" as const, description: "A LOCATION parameter id (from search parameters)." },
  "employment-status": { type: "string" as const, description: "Employment type: FULL_TIME|PART_TIME|CONTRACT|TEMPORARY|OTHER|VOLUNTEER|INTERNSHIP." },
  description: { type: "string" as const, description: "Full job description (required; minimum 200 characters, enforced server-side)." },
  "apply-method": { type: "string" as const, description: "How candidates apply: linkedin|external." },
  "notification-email": { type: "string" as const, description: "Email notified of new applicants (required when --apply-method is linkedin)." },
  "website-url": { type: "string" as const, description: "External apply URL (required when --apply-method is external)." },
  skills: { type: "string" as const, description: "Comma-separated skill parameter ids (optional)." },
};

const jobGetCommand = defineCommand({
  meta: { name: "get", description: "Retrieve one public LinkedIn job posting's full detail." },
  args: {
    ...READ_SINGLE_FLAGS,
    id: { type: "positional", description: "Job URL or a bare numeric job id." },
  },
  async run({ args }) {
    await withClient(args as JobFlags, runJobGet);
  },
});

const jobListCommand = defineCommand({
  meta: { name: "list", description: "List your own classic job postings by state." },
  args: {
    ...GLOBAL_FLAGS,
    state: { type: "string", description: "Filter by state (required): DRAFT|OPEN|CLOSED|REVIEW|SUSPENDED, or ALL for a best-effort client-side union across every state (each state queried, re-filtered, merged and de-duplicated by id; no unified cursor). Best-effort on LinkedIn's side -- verify item.state. The CLI re-filters returned items against their own state (dropped items are noted on stderr), but the upstream page walk itself is unfiltered, so --all may fetch more pages than the filtered item count implies.", required: true },
  },
  async run({ args }) {
    await withClient(args as JobFlags, runJobList);
  },
});

const jobCreateCommand = defineCommand({
  meta: { name: "create", description: "Create a classic job-posting draft (never publishes, never spends)." },
  args: {
    ...WRITE_SINGLE_FLAGS,
    ...JOB_BODY_FLAGS,
  },
  async run({ args }) {
    await withClient(args as JobFlags, runJobCreate);
  },
});

const jobUpdateCommand = defineCommand({
  meta: { name: "update", description: "Apply a partial update to a job posting you own." },
  args: {
    ...WRITE_SINGLE_FLAGS,
    id: { type: "positional", description: "Job id to update." },
    ...JOB_BODY_FLAGS,
  },
  async run({ args }) {
    await withClient(args as JobFlags, runJobUpdate);
  },
});

const jobBudgetCommand = defineCommand({
  meta: { name: "budget", description: "Price a publish before committing any money." },
  args: {
    ...READ_SINGLE_FLAGS,
    id: { type: "positional", description: "Job id to price." },
  },
  async run({ args }) {
    await withClient(args as JobFlags, runJobBudget);
  },
});

const jobPublishCommand = defineCommand({
  meta: { name: "publish", description: "Publish a draft. PROMOTED/PROMOTED_PLUS spend real money and require --budget-amount, --budget-currency, and --budget-scope." },
  args: {
    ...WRITE_SINGLE_FLAGS,
    id: { type: "positional", description: "Job id to publish." },
    mode: { type: "string", description: "Publish mode (required): FREE|PROMOTED|PROMOTED_PLUS.", required: true },
    "budget-currency": { type: "string", description: "ISO-4217 currency (required for a paid publish), e.g. EUR." },
    "budget-amount": { type: "string", description: "Budget amount, a non-negative number (required for a paid publish)." },
    "budget-scope": { type: "string", description: "Budget scope (required for a paid publish): DAILY|TOTAL." },
  },
  async run({ args }) {
    await withClient(args as JobFlags, runJobPublish);
  },
});

const jobCloseCommand = defineCommand({
  meta: { name: "close", description: "Stop a posting from accepting applications (irreversible once LISTED)." },
  args: {
    ...WRITE_SINGLE_FLAGS,
    id: { type: "positional", description: "Job id to close." },
  },
  async run({ args }) {
    await withClient(args as JobFlags, runJobClose);
  },
});

const jobApplicantsCommand = defineCommand({
  meta: { name: "applicants", description: "List applicants to a posting you own (POST-as-search)." },
  args: {
    ...GLOBAL_FLAGS,
    id: { type: "positional", description: "Job id to list applicants for." },
    ratings: { type: "string", description: "Comma-separated rating filter: UNRATED|NOT_A_FIT|MAYBE|GOOD_FIT. Omit for the full funnel." },
  },
  async run({ args }) {
    await withClient(args as JobFlags, runJobApplicants);
  },
});

const jobApplicantGetCommand = defineCommand({
  meta: { name: "get", description: "Get one applicant's full detail, including contact info." },
  args: {
    ...READ_SINGLE_FLAGS,
    id: { type: "positional", description: "Job id the applicant applied to." },
    applicantId: { type: "positional", description: "Applicant id." },
  },
  async run({ args }) {
    await withClient(args as JobFlags, runJobApplicantGet);
  },
});

const jobApplicantResumeCommand = defineCommand({
  meta: { name: "resume", description: "Download an applicant's résumé (binary)." },
  args: {
    ...READ_SINGLE_FLAGS,
    id: { type: "positional", description: "Job id the applicant applied to." },
    applicantId: { type: "positional", description: "Applicant id." },
    output: { type: "string", alias: "o", description: "Path to write the résumé file to." },
  },
  async run({ args }) {
    await withClient(args as JobFlags, (c, f, o) => runJobApplicantResume(c, f, o, process.stdout.isTTY ?? false));
  },
});

const jobApplicantCommand = defineCommand({
  meta: { name: "applicant", description: "Applicant detail + résumé for a posting you own." },
  args: { ...READ_SINGLE_FLAGS },
  subCommands: {
    get: jobApplicantGetCommand,
    resume: jobApplicantResumeCommand,
  },
  async run() {
    process.stderr.write(
      "Usage: curviate job applicant get <job_id> <applicant_id>\n" +
      "       curviate job applicant resume <job_id> <applicant_id> -o <file>\n",
    );
  },
});

export const jobCommand = defineCommand({
  meta: { name: "job", description: "Classic LinkedIn job-posting operations." },
  args: { ...READ_SINGLE_FLAGS },
  subCommands: {
    get: jobGetCommand,
    list: jobListCommand,
    create: jobCreateCommand,
    update: jobUpdateCommand,
    budget: jobBudgetCommand,
    publish: jobPublishCommand,
    close: jobCloseCommand,
    applicants: jobApplicantsCommand,
    applicant: jobApplicantCommand,
  },
  async run() {
    process.stderr.write(
      "Usage: curviate job get <url|id>\n" +
      "       curviate job list --state <DRAFT|OPEN|CLOSED|REVIEW|SUSPENDED|ALL>\n" +
      "       curviate job create --job-title <t> --company <c> --workplace-type <w> --location <id> --employment-status <e> --description <d> --apply-method <linkedin|external>\n" +
      "       curviate job update <id> [<flags>]\n" +
      "       curviate job budget <id>\n" +
      "       curviate job publish <id> --mode <FREE|PROMOTED|PROMOTED_PLUS>\n" +
      "       curviate job close <id>\n" +
      "       curviate job applicants <id>\n" +
      "       curviate job applicant get <id> <applicant_id>\n" +
      "       curviate job applicant resume <id> <applicant_id> -o <file>\n",
    );
  },
});
