/**
 * `curviate search`, LinkedIn search operations.
 *
 * Subcommands:
 *   search <url>: run a pasted search URL (search.fromUrl)
 *   search people [filters...]: search people (POST body)
 *   search companies [filters...]: search companies (POST body)
 *   search posts [filters...]: search posts (POST body)
 *   search jobs [filters...]: search jobs (POST body)
 *   search parameters --type <t> --keywords <k>: resolve filter IDs (GET)
 *   search groups <query>: keyword search LinkedIn groups (GET)
 *   search services [--keywords] [--service-category] [--location] [--connections] [--language], search Services Marketplace providers (POST body)
 *   search service-parameters --keywords <k> [--type <t>]: resolve service-filter IDs (GET)
 *
 * SDK reality: people/companies/posts/jobs are HTTP POST; cursor+limit go on
 * the query, not the body (the SDK splits them out). The CLI passes cursor+limit
 * merged into the method call, the SDK resource handles the split.
 *
 * All read commands reject --preview (exit 2).
 * search parameters rejects --all (non-paginated).
 * List POST searches support --all NDJSON streaming.
 */

import { requireAccount } from "../lib/account-arg.js";
import { defineCommand } from "citty";
import { GLOBAL_FLAGS } from "../lib/global-flags.js";
import { resolveEffectiveConfig } from "../lib/resolve.js";
import { createClient } from "../lib/client.js";
import { renderSuccess, renderError, renderUnexpectedError } from "../lib/output.js";
import { streamAll, pageDelayFromFlags } from "../lib/paginate.js";
import {
  assembleFilters,
  splitCsv,
  splitCsvNumbers,
  DEFAULT_FILTER_READERS,
  type FilterReaders,
} from "../lib/search-filters.js";
import {
  slimSearchPeople,
  slimSearchPeopleItem,
  slimSearchCompanies,
  slimSearchCompaniesItem,
  slimSearchJobs,
  slimSearchJobsItem,
  slimSearchPosts,
  slimSearchPostsItem,
} from "../lib/slim.js";
import type { Curviate, CurviateError, paths } from "@curviate/sdk";

/** `GET /v1/{account_id}/search/parameters` query, `type`+`keywords` both required in v2. */
type SearchParametersQuery = paths["/v1/{account_id}/search/parameters"]["get"]["parameters"]["query"];

type SearchFlags = {
  keywords?: string;
  url?: string;
  type?: string;
  limit?: string;
  cursor?: string;
  all?: boolean;
  "max-pages"?: string;
  "page-delay"?: string;
  account?: string;
  json?: boolean;
  verbose?: boolean;
  fields?: string;
  preview?: boolean;
  "api-key"?: string;
  "base-url"?: string;
  timeout?: string;
  profile?: string;
  // Filter escape hatch (reaches every documented filter as JSON).
  filters?: string;
  "filters-file"?: string;
  // Curated named convenience flags (string arrays are comma-separated).
  industry?: string;
  location?: string;
  company?: string;
  "past-company"?: string;
  school?: string;
  "network-distance"?: string;
  "connections-of"?: string;
  "followers-of"?: string;
  // People-only filter flags
  title?: string;
  "profile-language"?: string;
  // Posts filter flags
  "sort-by"?: string;
  "date-posted"?: string;
  "content-type"?: string;
  // Jobs filter flags (NOT valid on classic people search)
  seniority?: string;
  function?: string;
  "employment-type"?: string;
  "job-type"?: string;
  region?: string;
  // Companies filter flags
  "has-job-offers"?: boolean;
  headcount?: string;
  // Additional jobs filter flags
  "has-verifications"?: boolean;
  "under-10-applicants"?: boolean;
  "in-your-network"?: boolean;
  "fair-chance-employer"?: boolean;
  presence?: string;
  benefits?: string;
  commitments?: string;
  "location-within-area"?: string;
  // Posts nested filter flags
  "posted-by-member"?: string;
  "posted-by-company"?: string;
  "posted-by-me"?: boolean;
  "mentioning-member"?: string;
  "mentioning-company"?: string;
  "author-industry"?: string;
  "author-company"?: string;
  "author-keywords"?: string;
  // search groups
  query?: string;
  // search services
  "service-category"?: string;
  connections?: string;
  language?: string;
};

/**
 * The 7 fully-specified company headcount buckets. The substrate's 8th
 * bucket (`10001+`) has no confirmed `{min,max}` pairing in the documented
 * enum for the unbounded top bucket; it is deliberately deferred rather
 * than guessed; passing it is an unrecognized bucket (exit 2), and `--help`
 * documents the gap.
 */
const HEADCOUNT_BUCKETS: Record<string, { min: number; max: number }> = {
  "1-10": { min: 1, max: 10 },
  "11-50": { min: 11, max: 50 },
  "51-200": { min: 51, max: 200 },
  "201-500": { min: 201, max: 500 },
  "501-1000": { min: 501, max: 1000 },
  "1001-5000": { min: 1001, max: 5000 },
  "5001-10000": { min: 5001, max: 10000 },
};

/**
 * Flags that are valid on jobs/SN but NOT on `search people` (classic LinkedIn
 * people search does not support them). Passing any of these to runSearchPeople
 * exits 2.
 */
const PEOPLE_INVALID_FLAGS = ["seniority", "function", "employment-type", "sort-by"] as const;

/** Named convenience flags reused across the search description sets. */
const FILTER_FLAGS = {
  filters: {
    type: "string" as const,
    stdinArg: true,
    description: "Filter body as a JSON object (named flags win on conflict; server validates and strips unknown fields); '-' reads JSON from stdin.",
  },
  "filters-file": {
    type: "string" as const,
    description: "Path to a JSON file with the filter body (named flags win on conflict).",
  },
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

function rejectAllOnNonPaginated(all: boolean | undefined, out: OutputStreams): void {
  if (all) {
    out.stderr.write("error: --all is not supported on non-paginated commands.\n");
    process.exit(2);
  }
}

function resolveOutputOpts(flags: SearchFlags) {
  return {
    json: (flags.json ?? false) || !process.stdout.isTTY,
    isTTY: process.stdout.isTTY ?? false,
    fields: flags.fields,
    verbose: flags.verbose ?? false,
  };
}

/** Apply the common --keywords / pagination flags over a body. */
function applyCommonSearchFlags(body: Record<string, unknown>, flags: SearchFlags): void {
  if (flags.keywords) body["keywords"] = flags.keywords;
  // cursor + limit go as query params (SDK splits them out of the body)
  if (flags.cursor) body["cursor"] = flags.cursor;
  if (flags.limit) body["limit"] = parseInt(flags.limit, 10);
}

/**
 * Merge a patch object INTO a nested body key, preserving any sub-fields
 * already set there (by --filters or an earlier named flag targeting the same
 * nested object) rather than replacing the object wholesale. Used by the
 * search posts nested filter flags (posted-by / mentioning / author).
 */
function mergeNested(body: Record<string, unknown>, key: string, patch: Record<string, unknown>): void {
  const existing =
    body[key] !== null && body[key] !== undefined && typeof body[key] === "object" && !Array.isArray(body[key])
      ? (body[key] as Record<string, unknown>)
      : {};
  body[key] = { ...existing, ...patch };
}

/**
 * Per-command named-flag mappers. Each maps the curated convenience flags to the
 * exact API request-body field names, merging OVER the --filters base body.
 * String-array fields are comma-separated; network_distance is a number array.
 * A mapper may return an error string (usage error, exit 2 before any SDK call)
 * instead of mutating the body, e.g. an unrecognized --headcount bucket or a
 * non-numeric --location-within-area.
 */
const NAMED_FLAG_MAPPERS: Record<
  string,
  (body: Record<string, unknown>, flags: SearchFlags) => string | void
> = {
  people(body, flags) {
    if (flags.industry) body["industry"] = splitCsv(flags.industry);
    if (flags.location) body["location"] = splitCsv(flags.location);
    if (flags.company) body["company"] = splitCsv(flags.company);
    if (flags["past-company"]) body["past_company"] = splitCsv(flags["past-company"]);
    if (flags.school) body["school"] = splitCsv(flags.school);
    if (flags["network-distance"]) body["network_distance"] = splitCsvNumbers(flags["network-distance"]);
    // --connections-of / --followers-of: comma-separated -> array
    if (flags["connections-of"]) body["connections_of"] = splitCsv(flags["connections-of"]);
    if (flags["followers-of"]) body["followers_of"] = splitCsv(flags["followers-of"]);
    // --title: merge into existing advanced_keywords object (not overwrite)
    if (flags.title) {
      const existingAK =
        body["advanced_keywords"] !== null &&
        body["advanced_keywords"] !== undefined &&
        typeof body["advanced_keywords"] === "object" &&
        !Array.isArray(body["advanced_keywords"])
          ? (body["advanced_keywords"] as Record<string, unknown>)
          : {};
      body["advanced_keywords"] = { ...existingAK, title: flags.title };
    }
    // --profile-language: profile_language array (comma-split)
    if (flags["profile-language"]) body["profile_language"] = splitCsv(flags["profile-language"]);
  },
  companies(body, flags) {
    if (flags.industry) body["industry"] = splitCsv(flags.industry);
    if (flags.location) body["location"] = splitCsv(flags.location);
    if (flags["network-distance"]) body["network_distance"] = splitCsvNumbers(flags["network-distance"]);
    // --has-job-offers / --headcount
    if (flags["has-job-offers"]) body["has_job_offers"] = true;
    if (flags.headcount) {
      const buckets = splitCsv(flags.headcount);
      const mapped: Array<{ min: number; max: number }> = [];
      for (const bucket of buckets) {
        const range = HEADCOUNT_BUCKETS[bucket];
        if (!range) return `--headcount: unrecognized bucket "${bucket}"`;
        mapped.push(range);
      }
      body["headcount"] = mapped;
    }
  },
  posts(body, flags) {
    if (flags["sort-by"]) body["sort_by"] = flags["sort-by"];
    // normalize hyphen aliases (e.g. past-week -> past_week) before sending
    if (flags["date-posted"]) body["date_posted"] = flags["date-posted"].replace(/-/g, "_");
    if (flags["content-type"]) body["content_type"] = flags["content-type"];

    // Nested posted_by / mentioning / author filters. Each named flag
    // merges INTO the shared nested object rather than replacing it wholesale
    // (same deep-merge discipline as --title -> advanced_keywords above).
    if (flags["posted-by-member"]) mergeNested(body, "posted_by", { member: splitCsv(flags["posted-by-member"]) });
    if (flags["posted-by-company"]) mergeNested(body, "posted_by", { company: splitCsv(flags["posted-by-company"]) });
    if (flags["posted-by-me"]) mergeNested(body, "posted_by", { me: true });

    if (flags["mentioning-member"]) mergeNested(body, "mentioning", { member: splitCsv(flags["mentioning-member"]) });
    if (flags["mentioning-company"]) mergeNested(body, "mentioning", { company: splitCsv(flags["mentioning-company"]) });

    if (flags["author-industry"]) mergeNested(body, "author", { industry: splitCsv(flags["author-industry"]) });
    if (flags["author-company"]) mergeNested(body, "author", { company: splitCsv(flags["author-company"]) });
    if (flags["author-keywords"]) mergeNested(body, "author", { keywords: flags["author-keywords"] });
  },
  jobs(body, flags) {
    // --location on jobs maps to body region (single opaque geo-id, not location array)
    if (flags.location) body["region"] = flags.location;
    if (flags.industry) body["industry"] = splitCsv(flags.industry);
    if (flags.seniority) body["seniority"] = splitCsv(flags.seniority);
    if (flags.function) body["function"] = splitCsv(flags.function);
    if (flags["job-type"]) body["job_type"] = splitCsv(flags["job-type"]);
    if (flags.company) body["company"] = splitCsv(flags.company);
    if (flags["sort-by"]) body["sort_by"] = flags["sort-by"];
    // --date-posted on jobs is a numeric age-in-days (NOT an enum string; no normalization)
    if (flags["date-posted"] !== undefined && flags["date-posted"] !== "") {
      body["date_posted"] = Number(flags["date-posted"]);
    }
    // --region alias applied last so it wins over --location when both supplied
    if (flags.region) body["region"] = flags.region;
    // --title: job_title_ids, comma-separated -> body role
    if (flags.title) body["role"] = splitCsv(flags.title);
    // Additional named flags, all already server-wired but previously flag-less
    if (flags.presence) body["presence"] = splitCsv(flags.presence);
    if (flags.benefits) body["benefits"] = splitCsv(flags.benefits);
    if (flags.commitments) body["commitments"] = splitCsv(flags.commitments);
    if (flags["has-verifications"]) body["has_verifications"] = true;
    if (flags["under-10-applicants"]) body["under_10_applicants"] = true;
    if (flags["in-your-network"]) body["in_your_network"] = true;
    if (flags["fair-chance-employer"]) body["fair_chance_employer"] = true;
    // --location-within-area: miles, numeric only
    if (flags["location-within-area"] !== undefined) {
      const raw = flags["location-within-area"];
      const n = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(n)) {
        return `--location-within-area: must be a number (miles)`;
      }
      body["location_within_area"] = n;
    }
  },
};

/**
 * Build the POST search body: the --filters JSON base, then --keywords /
 * pagination and the per-command named convenience flags merged OVER it.
 * Returns the body, or an `error` string when --filters does not parse to an
 * object, or a named flag rejects its own value (e.g. --headcount, exit 2
 * without an API call in either case).
 */
async function buildSearchBody(
  kind: keyof typeof NAMED_FLAG_MAPPERS,
  flags: SearchFlags,
  readers: FilterReaders,
): Promise<{ body: Record<string, unknown> } | { error: string }> {
  const assembled = await assembleFilters(flags, readers);
  if ("error" in assembled) return assembled;
  const body = assembled.body;
  applyCommonSearchFlags(body, flags);
  const mapperError = NAMED_FLAG_MAPPERS[kind]!(body, flags);
  if (mapperError) return { error: mapperError };
  return { body };
}

// ---------------------------------------------------------------------------
// Exported run functions (testable without citty)
// ---------------------------------------------------------------------------

/**
 * Run `search people [filters...]`.
 * POST body search, cursor+limit passed to SDK (which splits to query).
 */
export async function runSearchPeople(
  client: Curviate,
  flags: SearchFlags,
  out: OutputStreams,
  readers: FilterReaders = DEFAULT_FILTER_READERS,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  // Reject flags that are only valid for jobs / Sales Navigator (not classic people search)
  for (const f of PEOPLE_INVALID_FLAGS) {
    if (flags[f as keyof SearchFlags]) {
      out.stderr.write(
        `error: --${f} is not valid for \`search people\` (classic LinkedIn search). Use \`search jobs\` or \`sales-nav search people\` for this filter.\n`,
      );
      process.exit(2);
    }
  }

  const accountId = await requireAccount(client, flags.account, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const verbose = flags.verbose ?? false;
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
  const assembled = await buildSearchBody("people", flags, readers);
  if ("error" in assembled) {
    out.stderr.write(`error: ${assembled.error}\n`);
    process.exit(2);
  }
  const body = assembled.body;

  try {
    if (all) {
      const fn = (p: Record<string, unknown>) => ns.search.people(p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, body, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        const projected = verbose ? item : slimSearchPeopleItem(item as Record<string, unknown>);
        out.stdout.write(JSON.stringify(projected) + "\n");
      }
    } else {
      const result = await ns.search.people(body);
      renderSuccess(result, { ...outOpts, slim: slimSearchPeople }, out);
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
 * Run `search companies [filters...]`.
 * POST body search.
 */
export async function runSearchCompanies(
  client: Curviate,
  flags: SearchFlags,
  out: OutputStreams,
  readers: FilterReaders = DEFAULT_FILTER_READERS,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = await requireAccount(client, flags.account, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const verbose = flags.verbose ?? false;
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
  const assembled = await buildSearchBody("companies", flags, readers);
  if ("error" in assembled) {
    out.stderr.write(`error: ${assembled.error}\n`);
    process.exit(2);
  }
  const body = assembled.body;

  try {
    if (all) {
      const fn = (p: Record<string, unknown>) => ns.search.companies(p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, body, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        const projected = verbose ? item : slimSearchCompaniesItem(item as Record<string, unknown>);
        out.stdout.write(JSON.stringify(projected) + "\n");
      }
    } else {
      const result = await ns.search.companies(body);
      renderSuccess(result, { ...outOpts, slim: slimSearchCompanies }, out);
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
 * Run `search posts [filters...]`.
 * POST body search.
 */
export async function runSearchPosts(
  client: Curviate,
  flags: SearchFlags,
  out: OutputStreams,
  readers: FilterReaders = DEFAULT_FILTER_READERS,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = await requireAccount(client, flags.account, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const verbose = flags.verbose ?? false;
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
  const assembled = await buildSearchBody("posts", flags, readers);
  if ("error" in assembled) {
    out.stderr.write(`error: ${assembled.error}\n`);
    process.exit(2);
  }
  const body = assembled.body;

  try {
    if (all) {
      const fn = (p: Record<string, unknown>) => ns.search.posts(p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, body, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        const projected = verbose ? item : slimSearchPostsItem(item as Record<string, unknown>);
        out.stdout.write(JSON.stringify(projected) + "\n");
      }
    } else {
      const result = await ns.search.posts(body);
      renderSuccess(result, { ...outOpts, slim: slimSearchPosts }, out);
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
 * Run `search jobs [filters...]`.
 * POST body search.
 */
export async function runSearchJobs(
  client: Curviate,
  flags: SearchFlags,
  out: OutputStreams,
  readers: FilterReaders = DEFAULT_FILTER_READERS,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = await requireAccount(client, flags.account, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const verbose = flags.verbose ?? false;
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
  const assembled = await buildSearchBody("jobs", flags, readers);
  if ("error" in assembled) {
    out.stderr.write(`error: ${assembled.error}\n`);
    process.exit(2);
  }
  const body = assembled.body;

  try {
    if (all) {
      const fn = (p: Record<string, unknown>) => ns.search.jobs(p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, body, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        const projected = verbose ? item : slimSearchJobsItem(item as Record<string, unknown>);
        out.stdout.write(JSON.stringify(projected) + "\n");
      }
    } else {
      const result = await ns.search.jobs(body);
      renderSuccess(result, { ...outOpts, slim: slimSearchJobs }, out);
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
 * Run `search parameters --type <t> --keywords <k>`.
 * GET, not paginated; rejects --all (exit 2).
 * v2: keywords is required for every type, including EMPLOYMENT_TYPE
 * (the pre-v2 API allowed omitting it there), now an actionable exit 2
 * instead of a server-side 400.
 */
export async function runSearchParameters(
  client: Curviate,
  flags: SearchFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);
  rejectAllOnNonPaginated(flags.all, out);

  if (!flags.type) {
    out.stderr.write("error: --type is required.\n");
    process.exit(2);
  }
  if (!flags.keywords) {
    out.stderr.write("error: --keywords is required (v2: required for every --type).\n");
    process.exit(2);
  }

  const accountId = await requireAccount(client, flags.account, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  // `type` is a free-form CLI string flag validated against the served enum
  // server-side, a narrow cast here is the pragmatic alternative to
  // hand-duplicating the enum union client-side.
  const query: SearchParametersQuery = {
    type: flags.type as SearchParametersQuery["type"],
    keywords: flags.keywords,
  };
  if (flags.limit) query.limit = parseInt(flags.limit, 10);

  try {
    const result = await ns.search.getParameters(query);
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

// Query/body types derived from the real SDK signatures, a shape drift is a
// compile error, not a latent runtime break.
type SearchGroupsQuery = Parameters<ReturnType<Curviate["account"]>["search"]["groups"]>[0];
type SearchServicesBody = Parameters<ReturnType<Curviate["account"]>["search"]["services"]>[0];
type SearchServiceParametersQuery = Parameters<ReturnType<Curviate["account"]>["search"]["getServiceParameters"]>[0];

/**
 * Run `search groups <query> [--limit] [--cursor] [--all]`, search.groups.
 * Read command, rejects --preview. Keyword-only search, no filter-id
 * resolution step. A no-match search returns an empty list, not an error.
 */
export async function runSearchGroups(
  client: Curviate,
  flags: SearchFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const keywords = flags.query ?? "";
  if (!keywords) {
    out.stderr.write("error: <query> is required.\n");
    process.exit(2);
  }

  const accountId = await requireAccount(client, flags.account, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;

  const query: SearchGroupsQuery = { keywords };
  if (flags.limit) query.limit = parseInt(flags.limit, 10);
  if (flags.cursor) query.cursor = flags.cursor;

  try {
    if (all) {
      const fn = (p: SearchGroupsQuery) => ns.search.groups(p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, query, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.search.groups(query);
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
 * Run `search services [--keywords] [--service-category] [--location]
 * [--connections] [--language] [--limit] [--cursor] [--all]`, search.services.
 * POST body search over the LinkedIn Services Marketplace. At least one of
 * --keywords, --service-category, or --location is required (server-enforced).
 * Read command, rejects --preview.
 */
export async function runSearchServices(
  client: Curviate,
  flags: SearchFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = await requireAccount(client, flags.account, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;

  const body: Record<string, unknown> = {};
  if (flags.keywords) body["keywords"] = flags.keywords;
  if (flags["service-category"]) body["service_category"] = splitCsv(flags["service-category"]);
  if (flags.location) body["location"] = splitCsv(flags.location);
  if (flags.connections) {
    body["connections"] = splitCsvNumbers(flags.connections);
  }
  if (flags.language) body["language"] = splitCsv(flags.language);
  if (flags.limit) body["limit"] = parseInt(flags.limit, 10);
  if (flags.cursor) body["cursor"] = flags.cursor;

  try {
    if (all) {
      const fn = (p: Record<string, unknown>) =>
        ns.search.services(p as SearchServicesBody) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, body, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.search.services(body as SearchServicesBody);
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
 * Run `search service-parameters --keywords <k> [--type <t>]`, search.getServiceParameters.
 * GET, not paginated in practice (a resolver lookup); rejects --all (exit 2).
 * --keywords is required (the SDK's `keywords` query field is required);
 * --type defaults server-side to service_category when omitted.
 */
export async function runSearchServiceParameters(
  client: Curviate,
  flags: SearchFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);
  rejectAllOnNonPaginated(flags.all, out);

  if (!flags.keywords) {
    out.stderr.write("error: --keywords is required.\n");
    process.exit(2);
  }

  const accountId = await requireAccount(client, flags.account, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  const query: SearchServiceParametersQuery = { keywords: flags.keywords };
  if (flags.type) query.type = flags.type as SearchServiceParametersQuery["type"];
  if (flags.limit) query.limit = parseInt(flags.limit, 10);

  try {
    const result = await ns.search.getServiceParameters(query);
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

// Body type derived from the real SDK signature (fromUrl merges the {url} body
// with the top-level offset/limit/cursor query into one argument).
type SearchFromUrlBody = Parameters<ReturnType<Curviate["account"]>["search"]["fromUrl"]>[0];

/**
 * Run `search <url>`, search.fromUrl.
 * Runs a pasted LinkedIn search / saved-search / lead-list URL directly. Read
 * command, rejects --preview. The response is polymorphic; --all streams it.
 */
export async function runSearchFromUrl(
  client: Curviate,
  flags: SearchFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);
  const accountId = await requireAccount(client, flags.account, out);
  const url = flags.url ?? "";
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const verbose = flags.verbose ?? false;
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;

  const body: Record<string, unknown> = { url };
  if (flags.limit) body.limit = parseInt(flags.limit, 10);
  if (flags.cursor) body.cursor = flags.cursor;

  try {
    if (all) {
      // Narrow cast at the body-argument call site: fromUrl takes {url} + paging.
      const fn = (p: Record<string, unknown>) => ns.search.fromUrl(p as SearchFromUrlBody) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, body, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.search.fromUrl(body as SearchFromUrlBody);
      renderSuccess(result, { ...outOpts, verbose }, out);
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

// ---------------------------------------------------------------------------
// Citty command definitions
// ---------------------------------------------------------------------------

const searchPeopleCommand = defineCommand({
  meta: { name: "people", description: "Search members with structured filters." },
  args: {
    ...GLOBAL_FLAGS,
    keywords: { type: "string", description: "Full-text keyword search." },
    ...FILTER_FLAGS,
    industry: { type: "string", description: "Industry ids (comma-separated)." },
    location: { type: "string", description: "Location ids (comma-separated)." },
    company: { type: "string", description: "Current company ids (comma-separated)." },
    "past-company": { type: "string", description: "Past company ids (comma-separated)." },
    school: { type: "string", description: "School ids (comma-separated)." },
    "network-distance": { type: "string", description: "Network distance, 1-3 (comma-separated)." },
    "connections-of": { type: "string", description: "member id(s), comma-separated (resolve: search parameters --type CONNECTIONS --keywords \"<name>\")" },
    "followers-of": { type: "string", description: "member id(s), comma-separated (resolve: search parameters --type PEOPLE --keywords \"<name>\")" },
    // People-specific filter flags
    title: { type: "string", description: "Job title keyword filter (maps to advanced_keywords.title)." },
    "profile-language": { type: "string", description: "Profile language codes (comma-separated, e.g. en,de)." },
  },
  async run({ args }) {
    const flags = args as SearchFlags;
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
    await runSearchPeople(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const searchCompaniesCommand = defineCommand({
  meta: { name: "companies", description: "Search companies." },
  args: {
    ...GLOBAL_FLAGS,
    keywords: { type: "string", description: "Full-text keyword search." },
    ...FILTER_FLAGS,
    industry: { type: "string", description: "Industry ids (comma-separated)." },
    location: { type: "string", description: "Location ids (comma-separated)." },
    "network-distance": { type: "string", description: "Network distance, 1-3 (comma-separated)." },
    "has-job-offers": { type: "boolean", description: "only companies with active job listings" },
    headcount: {
      type: "string",
      description:
        "company size, comma-separated: 1-10, 11-50, 51-200, 201-500, 501-1000, 1001-5000, 5001-10000, 10001+ (10001+ not yet supported)",
    },
  },
  async run({ args }) {
    const flags = args as SearchFlags;
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
    await runSearchCompanies(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const searchPostsCommand = defineCommand({
  meta: { name: "posts", description: "Search posts." },
  args: {
    ...GLOBAL_FLAGS,
    keywords: { type: "string", description: "Full-text keyword search." },
    ...FILTER_FLAGS,
    "sort-by": { type: "string", description: "Sort order (e.g. relevance, date)." },
    "date-posted": { type: "string", description: "time window: past_day, past_week, or past_month (hyphens also accepted: past-day, past-week, past-month)" },
    "content-type": { type: "string", description: "content type: videos, images, live_videos, collaborative_articles, documents" },
    "posted-by-member": { type: "string", description: "member id(s), comma-separated (resolve: search parameters --type PEOPLE); merges into posted_by" },
    "posted-by-company": { type: "string", description: "company id(s), comma-separated (resolve: search parameters --type COMPANY); merges into posted_by" },
    "posted-by-me": { type: "boolean", description: "only posts authored by you; merges into posted_by" },
    "mentioning-member": { type: "string", description: "member id(s) mentioned in the post, comma-separated (resolve: search parameters --type PEOPLE); merges into mentioning" },
    "mentioning-company": { type: "string", description: "company id(s) mentioned in the post, comma-separated (resolve: search parameters --type COMPANY); merges into mentioning" },
    "author-industry": { type: "string", description: "author's industry id(s), comma-separated (resolve: search parameters --type INDUSTRY); merges into author" },
    "author-company": { type: "string", description: "author's company id(s), comma-separated (resolve: search parameters --type COMPANY); merges into author" },
    "author-keywords": { type: "string", description: "author keyword filter (free text); merges into author" },
  },
  async run({ args }) {
    const flags = args as SearchFlags;
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
    await runSearchPosts(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const searchJobsCommand = defineCommand({
  meta: { name: "jobs", description: "Search jobs." },
  args: {
    ...GLOBAL_FLAGS,
    keywords: { type: "string", description: "Full-text keyword search." },
    ...FILTER_FLAGS,
    // On jobs, --location maps to the geo region filter (not a location array, different API shape for jobs vs people)
    location: { type: "string", description: "geo region id (single id; resolve via search parameters --type LOCATION); maps to region filter" },
    industry: { type: "string", description: "Industry ids (comma-separated)." },
    seniority: { type: "string", description: "seniority level, closed enum: executive|director|mid_senior|associate|entry|intern (comma-separated)" },
    function: { type: "string", description: "Job function ids (comma-separated)." },
    "job-type": { type: "string", description: "job type, independent 7-value enum: full_time|part_time|contract|temporary|volunteer|internship|other (comma-separated)" },
    company: { type: "string", description: "Company ids (comma-separated)." },
    "sort-by": { type: "string", description: "Sort order (e.g. relevance, recent)." },
    "date-posted": { type: "string", description: "maximum job age in days (a number, e.g. 7, 14, 30; not an enum string)" },
    region: { type: "string", description: "alias for --location (same body field: region)" },
    title: {
      type: "string",
      description:
        "job title id(s), comma-separated (resolve: search parameters --type JOB_TITLE); ID-based targeting, unlike search people --title, which is free-text",
    },
    presence: { type: "string", description: "work presence, comma-separated: on_site, hybrid, remote" },
    benefits: { type: "string", description: "benefit ids, comma-separated" },
    commitments: { type: "string", description: "commitment/employment types, comma-separated" },
    "has-verifications": { type: "boolean", description: "only jobs with verified details" },
    "under-10-applicants": { type: "boolean", description: "only jobs with fewer than 10 applicants" },
    "in-your-network": { type: "boolean", description: "only jobs where you have a connection at the company" },
    "fair-chance-employer": { type: "boolean", description: "only fair-chance employer jobs" },
    "location-within-area": {
      type: "string",
      description: "radius in miles from --location (requires --location; numeric only)",
    },
  },
  async run({ args }) {
    const flags = args as SearchFlags;
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
    await runSearchJobs(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const searchParametersCommand = defineCommand({
  meta: { name: "parameters", description: "Resolve human-readable terms to opaque filter IDs." },
  args: {
    ...GLOBAL_FLAGS,
    type: {
      type: "string",
      description:
        "Parameter type: LOCATION, PEOPLE, CONNECTIONS, COMPANY, SCHOOL, INDUSTRY, SERVICE, JOB_FUNCTION, JOB_TITLE, EMPLOYMENT_TYPE, SKILL.",
      required: true,
    },
    keywords: { type: "string", description: "Human term to resolve (required for every --type, incl. EMPLOYMENT_TYPE).", required: true },
  },
  async run({ args }) {
    const flags = args as SearchFlags;
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
    await runSearchParameters(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const searchGroupsCommand = defineCommand({
  meta: { name: "groups", description: "Keyword search for LinkedIn groups. A no-match search returns an empty list, not an error." },
  args: {
    ...GLOBAL_FLAGS,
    query: { type: "positional", description: "Search terms (multi-word supported, e.g. 'gtm engineering')." },
  },
  async run({ args }) {
    const flags = args as SearchFlags;
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
    await runSearchGroups(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const searchServicesCommand = defineCommand({
  meta: {
    name: "services",
    description:
      "Search Services Marketplace providers with structured filters. At least one of --keywords, " +
      "--service-category, or --location is required. Resolve --service-category/--location values with " +
      "'search service-parameters' first, both take opaque ids, not free text.",
  },
  args: {
    ...GLOBAL_FLAGS,
    keywords: { type: "string", description: "Free-text keyword match." },
    "service-category": { type: "string", description: "Opaque service-category ids (comma-separated; resolve via search service-parameters --type service_category)." },
    location: { type: "string", description: "Opaque location ids (comma-separated; resolve via search service-parameters --type location)." },
    connections: { type: "string", description: "Connection degree filter, comma-separated: 1 (1st), 2 (2nd), 3 (3rd+)." },
    language: { type: "string", description: "Profile-language ISO 639-1 codes, comma-separated (e.g. en,de,es,fr)." },
  },
  async run({ args }) {
    const flags = args as SearchFlags;
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
    await runSearchServices(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const searchServiceParametersCommand = defineCommand({
  meta: {
    name: "service-parameters",
    description: "Resolve human-readable service-filter terms into the opaque ids 'search services' accepts.",
  },
  args: {
    ...GLOBAL_FLAGS,
    type: {
      type: "string",
      description: "Filter type to resolve: service_category (default) or location.",
    },
    keywords: { type: "string", description: "The typed text to resolve (e.g. 'marke').", required: true },
  },
  async run({ args }) {
    const flags = args as SearchFlags;
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
    await runSearchServiceParameters(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

export const searchCommand = defineCommand({
  meta: { name: "search", description: "Search people, companies, posts, and jobs. Also runs a pasted search URL directly." },
  args: {
    ...GLOBAL_FLAGS,
    url: {
      type: "positional",
      required: false,
      description: "A pasted LinkedIn search, saved-search re-run, or lead-list URL. Runs it directly (search.fromUrl).",
    },
  },
  subCommands: {
    people: searchPeopleCommand,
    companies: searchCompaniesCommand,
    posts: searchPostsCommand,
    jobs: searchJobsCommand,
    parameters: searchParametersCommand,
    groups: searchGroupsCommand,
    services: searchServicesCommand,
    "service-parameters": searchServiceParametersCommand,
  },
  async run({ args }) {
    const flags = args as SearchFlags;

    // Bare form: `search <url>` runs the URL directly. No url -> print usage.
    if (!flags.url) {
      process.stderr.write(
        "Usage: curviate search <url>\n" +
        "       curviate search people [--keywords <k>]\n" +
        "       curviate search companies [--keywords <k>]\n" +
        "       curviate search posts [--keywords <k>]\n" +
        "       curviate search jobs [--keywords <k>]\n" +
        "       curviate search parameters --type <t> --keywords <k>\n" +
        "       curviate search groups <query>\n" +
        "       curviate search services [--keywords <k>]\n" +
        "       curviate search service-parameters --keywords <k> [--type <t>]\n",
      );
      // <url> is functionally required for the bare form, a missing
      // required positional is a usage error (exit 2), not a silent success.
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
      process.stderr.write("error: no API key, run `curviate login` or pass --api-key.\n");
      process.exit(3);
    }
    const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeout: cfg.timeout });
    const out = buildOutputStreams();
    await runSearchFromUrl(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});
