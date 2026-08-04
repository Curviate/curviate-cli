/**
 * `curviate recruiter` — LinkedIn Recruiter operations (tier: recruiter).
 *
 * Subcommands:
 *   recruiter message new --to <id> "<text>" [--attach <f>…] [--voice <f>] [--video <f>] — start chat (write, multipart)
 *   recruiter profile <identifier>                                               — get profile (read, resolveIdentifier)
 *   recruiter search people [--keywords <k>] [--all] [--limit] [--cursor]       — search people (POST)
 *   recruiter search parameters --source <s> --type <t>                                       — get filter parameters (read)
 *   recruiter projects [--all] [--limit] [--cursor]                              — list projects (read)
 *   recruiter project <project_id>                                               — get project (read, verbatim id)
 *   recruiter save-candidate <project_id> --stage-id <id> --candidate-id <id>  — save candidate to pipeline (write)
 *   recruiter jobs [--all] [--limit] [--cursor]                                  — list jobs (read)
 *   recruiter job create [--body-file <path> | --body -] [--job-title <t>] [--description <d>] [--employment-type <e>] — create job draft (write; JSON body + scalar flags)
 *   recruiter job publish <project_id> <job_id> [--mode <m>]                                  — publish job (write)
 *   recruiter applicants <project_id> --channel-id <id>                                             — list applicants (read)
 *   recruiter job get <url|id>                                                    — get a job posting via the Recruiter lens (read, any public job)
 *   recruiter applicant <project_id> <applicant_id>                                            — get applicant (read, verbatim id)
 *   recruiter applicant resume <project_id> <applicant_id> -o <file>                          — download resume (binary)
 *
 * All subcommands are account-scoped.
 * Tier-gate: CLI never pre-checks — SDK call goes out; TIER_NOT_ACTIVE / LINKEDIN_FEATURE_NOT_SUBSCRIBED → exit 5.
 * Identifier resolution: applied to `profile <identifier>` only; `job get <url|id>`
 * resolves a job URL to its numeric id via resolveJobIdentifier (same helper
 * the top-level `job get` command uses).
 * user_id / job_id / applicant_id / project_id pass verbatim.
 */

import { defineCommand } from "citty";
import { GLOBAL_FLAGS, WRITE_FLAGS, READ_SINGLE_FLAGS, WRITE_SINGLE_FLAGS } from "../lib/global-flags.js";
import { resolveIdentifier, resolveJobIdentifier } from "../lib/identifier.js";
import { resolveEffectiveConfig } from "../lib/resolve.js";
import { createClient } from "../lib/client.js";
import { renderSuccess, renderError, renderUnexpectedError } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { streamAll, pageDelayFromFlags } from "../lib/paginate.js";
import { slimJob } from "../lib/slim.js";
import { readAttachment, AttachError, toAttachmentPayload } from "../lib/attach.js";
import { writeBinaryOutput, BinaryOutputError } from "../lib/binary.js";
import {
  assembleFilters,
  splitCsv,
  DEFAULT_FILTER_READERS,
  type FilterReaders,
} from "../lib/search-filters.js";
import { isStdinToken } from "../lib/stdin.js";
import { readFile } from "node:fs/promises";
import type { Curviate, CurviateError, paths } from "@curviate/sdk";

/**
 * Local type aliases for the recruiter bodies that are genuinely
 * impractical to build as fully-typed literals (deep discriminated unions,
 * or a body sourced from free-form user JSON) — used for a single narrow
 * cast at the call site instead.
 */
type RecruiterStartChatBody = paths["/v1/{account_id}/recruiter/chats"]["post"]["requestBody"]["content"]["application/json"];
type RecruiterSearchParametersBody = paths["/v1/{account_id}/recruiter/search/parameters"]["post"]["requestBody"]["content"]["application/json"];
type RecruiterCreateJobBody = paths["/v1/{account_id}/recruiter/jobs"]["post"]["requestBody"]["content"]["application/json"];
type RecruiterPublishJobBody = paths["/v1/{account_id}/recruiter/projects/{project_id}/jobs/{job_id}/publish"]["post"]["requestBody"]["content"]["application/json"];
type RecruiterListApplicantsBody = paths["/v1/{account_id}/recruiter/projects/{project_id}/talent-pool/applicants"]["post"]["requestBody"]["content"]["application/json"];
type RecruiterSaveCandidateBody = paths["/v1/{account_id}/recruiter/projects/{project_id}/pipeline/candidate/save"]["post"]["requestBody"]["content"]["application/json"];
type RecruiterUpdateProjectBody = paths["/v1/{account_id}/recruiter/projects/{project_id}"]["patch"]["requestBody"]["content"]["application/json"];
type RecruiterListPipelineBody = paths["/v1/{account_id}/recruiter/projects/{project_id}/pipeline"]["post"]["requestBody"]["content"]["application/json"];
type RecruiterCreateProjectJobBody = paths["/v1/{account_id}/recruiter/projects/{project_id}/jobs"]["post"]["requestBody"]["content"]["application/json"];
type RecruiterUpdateProjectJobBody = paths["/v1/{account_id}/recruiter/projects/{project_id}/jobs/{job_id}"]["patch"]["requestBody"]["content"]["application/json"];
type RecruiterSearchTalentPoolBody = paths["/v1/{account_id}/recruiter/projects/{project_id}/talent-pool/search"]["post"]["requestBody"]["content"]["application/json"];
type RecruiterSearchFromUrlBody = paths["/v1/{account_id}/recruiter/search"]["post"]["requestBody"]["content"]["application/json"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RecruiterFlags = {
  account?: string;
  json?: boolean;
  fields?: string;
  limit?: string;
  cursor?: string;
  all?: boolean;
  "max-pages"?: string;
  "page-delay"?: string;
  preview?: boolean;
  verbose?: boolean;
  "api-key"?: string;
  "base-url"?: string;
  timeout?: string;
  profile?: string;
  // Subcommand-specific
  to?: string;
  text?: string;
  subject?: string;
  signature?: string;
  attach?: string | string[];
  voice?: string;
  video?: string;
  type?: string;
  source?: string;
  keywords?: string;
  // search-people filter escape hatch + curated named flags
  // (note: "employment-type" is declared below in the job-create group and is
  //  reused by `recruiter search people` — it maps to the same API field.)
  filters?: string;
  "filters-file"?: string;
  locale?: string;
  function?: string;
  "profile-language"?: string;
  identifier?: string;
  userId?: string;
  projectId?: string;
  "project-id"?: string;
  jobId?: string;
  applicantId?: string;
  "hiring-project-id"?: string;
  stage?: string;
  "stage-id"?: string;
  "candidate-id"?: string;
  "channel-id"?: string;
  reason?: string;
  message?: string;
  "notify-at"?: string;
  mode?: string;
  "budget-currency"?: string;
  "budget-amount"?: string;
  "budget-scope"?: string;
  input?: string;
  output?: string;
  // job create
  body?: string;
  "body-file"?: string;
  "job-title"?: string;
  "project-name"?: string;
  description?: string;
  "employment-type"?: string;
  // recruiter job body (job create / project-job create / project-job update)
  "job-title-id"?: string;
  "company-id"?: string;
  "company-name"?: string;
  "workplace-type"?: string;
  "employment-status"?: string;
  "seniority-level"?: string;
  industry?: string;
  "job-function"?: string;
  "apply-method"?: string;
  "notification-email"?: string;
  "website-url"?: string;
  // project update
  name?: string;
  visibility?: string;
  location?: string;
  // pipeline / talent-search
  "sort-by"?: string;
  spotlights?: string;
  url?: string;
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

function resolveOutputOpts(flags: RecruiterFlags) {
  return {
    json: (flags.json ?? false) || !process.stdout.isTTY,
    isTTY: process.stdout.isTTY ?? false,
    fields: flags.fields,
    verbose: flags.verbose ?? false,
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

/**
 * Build a { id? } | { name? } reference object from an id flag and a name
 * flag — id wins when both are given. Returns undefined when neither is set.
 * Used for recruiter company/job_title references built from paired flags.
 */
function buildRecruiterRef(idValue: string | undefined, nameValue: string | undefined): { id?: string; name?: string } | undefined {
  if (idValue) return { id: idValue };
  if (nameValue) return { name: nameValue };
  return undefined;
}

/** Read all of stdin as a UTF-8 string. Used for `--body -`. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Reader injection point for `recruiter job create`, so the JSON-body source
 * (file / stdin) can be exercised in tests without real process.stdin I/O.
 */
export type JobCreateReaders = {
  readFile: (path: string) => Promise<string>;
  readStdin: () => Promise<string>;
};

const DEFAULT_JOB_CREATE_READERS: JobCreateReaders = {
  readFile: (path) => readFile(path, "utf8"),
  readStdin,
};

/**
 * Assemble a recruiter job-posting body (shared by `recruiter job create`,
 * `recruiter project-job create`, and `recruiter project-job update`) from a
 * JSON source (--body-file / --body -) plus top-level scalar convenience
 * flags that merge OVER the JSON.
 *
 * v2 shape: job_title is `{id?,name?}` (built from --job-title-id +
 * --job-title, the latter carrying the display name); company is `{id}` or
 * `{name}` (--company-id wins over --company-name); the enum field is
 * employment_status (--employment-status, NOT the pre-v2 --employment-type,
 * which remains a separate `recruiter search people` filter flag); industry
 * and job_function are arrays (comma-separated flag values).
 *
 * Returns the assembled body, or an `error` string when the JSON source is
 * present but does not parse / is not a JSON object. The caller handles the
 * error (exit 2). Deep shape validation (e.g. apply_method's companion
 * field) is left to the API; presence of each top-level required key is
 * validated separately by `requireRecruiterJobFields` where relevant
 * (create only — a PATCH-style update has no required fields).
 */
async function assembleRecruiterJobBody(
  flags: RecruiterFlags,
  readers: JobCreateReaders,
): Promise<{ body: Record<string, unknown> } | { error: string }> {
  let base: Record<string, unknown> = {};

  // 1. JSON source: --body-file <path>, or --body - (stdin). --body-file wins
  //    if both are given.
  let raw: string | undefined;
  let source: string | undefined;
  if (flags["body-file"] !== undefined) {
    source = `--body-file ${flags["body-file"]}`;
    try {
      raw = await readers.readFile(flags["body-file"]);
    } catch {
      return { error: `cannot read ${source}` };
    }
  } else if (isStdinToken(flags.body)) {
    source = "--body - (stdin)";
    raw = await readers.readStdin();
  } else if (flags.body !== undefined) {
    return { error: "--body only accepts '-' (read JSON from stdin); use --body-file <path> for a file." };
  }

  if (raw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { error: `${source} is not valid JSON` };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: `${source} must be a JSON object` };
    }
    base = parsed as Record<string, unknown>;
  }

  // 2. Top-level scalar convenience flags merge OVER the JSON.
  if (flags["job-title-id"] !== undefined || flags["job-title"] !== undefined) {
    base["job_title"] = {
      ...(flags["job-title-id"] !== undefined ? { id: flags["job-title-id"] } : {}),
      ...(flags["job-title"] !== undefined ? { name: flags["job-title"] } : {}),
    };
  }
  const company = buildRecruiterRef(flags["company-id"], flags["company-name"]);
  if (company) base["company"] = company;
  if (flags["workplace-type"] !== undefined) base["workplace_type"] = flags["workplace-type"];
  if (flags.location !== undefined) base["location"] = flags.location;
  if (flags["employment-status"] !== undefined) base["employment_status"] = flags["employment-status"];
  if (flags["seniority-level"] !== undefined) base["seniority_level"] = flags["seniority-level"];
  if (flags.description !== undefined) base["description"] = flags.description;
  if (flags.industry !== undefined) base["industry"] = splitCsv(flags.industry);
  if (flags["job-function"] !== undefined) base["job_function"] = splitCsv(flags["job-function"]);
  if (flags["apply-method"] !== undefined) {
    const method = flags["apply-method"];
    base["apply_method"] = {
      method,
      ...(method === "linkedin" && flags["notification-email"] !== undefined ? { notification_email: flags["notification-email"] } : {}),
      ...(method === "external" && flags["website-url"] !== undefined ? { website_url: flags["website-url"] } : {}),
    };
  }
  // project_name is only meaningful on `recruiter job create` (opens a
  // brand-new project); project-job create/update take the project from the
  // path and never send it, but merging it here is harmless when absent.
  if (flags["project-name"] !== undefined) base["project_name"] = flags["project-name"];

  return { body: base };
}

/** The recruiter job-posting body's required top-level keys (create only), each paired with the flag(s) that populate it, for a naming exit-2 message. */
const RECRUITER_JOB_REQUIRED_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["job_title", "--job-title-id (paired with --job-title)"],
  ["company", "--company-id or --company-name"],
  ["workplace_type", "--workplace-type"],
  ["location", "--location"],
  ["employment_status", "--employment-status"],
  ["seniority_level", "--seniority-level"],
  ["description", "--description"],
  ["industry", "--industry"],
  ["job_function", "--job-function"],
  ["apply_method", "--apply-method"],
];

/**
 * Exit 2, naming the flag, when a required recruiter job-body field is
 * absent from the assembled body (from neither the JSON source nor a
 * scalar flag) — before any SDK call. `extra` appends command-specific
 * required fields (e.g. `recruiter job create`'s --project-name).
 */
function requireRecruiterJobFields(
  body: Record<string, unknown>,
  extra: ReadonlyArray<readonly [string, string]>,
  out: OutputStreams,
): void {
  for (const [key, flagDesc] of [...RECRUITER_JOB_REQUIRED_FIELDS, ...extra]) {
    const value = body[key];
    const missing = value === undefined || value === null || (Array.isArray(value) && value.length === 0);
    if (missing) {
      out.stderr.write(`error: ${flagDesc} is required (or ${key} in --body-file/--body -).\n`);
      process.exit(2);
    }
  }
}

// ---------------------------------------------------------------------------
// Exported run functions (testable without citty)
// ---------------------------------------------------------------------------

/**
 * Run `recruiter message new --to <id> --subject <s> --signature <sig> "<text>" [--attach <f>…] [--voice <f>] [--video <f>]`.
 * Write command — supports --preview.
 *
 * v2: JSON-only (no multipart) — `subject` and `signature` are REQUIRED
 * (InMail-based Recruiter messaging). There is no separate voice_message/
 * video_message body field — every attachment (file, voice, or video) rides
 * the single `attachments[]` array as a base64 object; voice/video use
 * `send_mode: "native"` for a platform-native bubble (`metadata.duration`
 * is not computed client-side and is left unset).
 */
export async function runRecruiterMessageNew(
  client: Curviate,
  flags: RecruiterFlags,
  out: OutputStreams,
): Promise<void> {
  const accountId = requireAccount(flags.account, out);
  const to = flags.to ?? "";
  const text = flags.text ?? "";
  const subject = flags.subject ?? "";
  const signature = flags.signature ?? "";
  const attachPaths = normalizeAttachPaths(flags.attach);
  const voicePath = flags.voice;
  const videoPath = flags.video;

  if (!subject) {
    out.stderr.write("error: --subject is required (v2: REQUIRED for Recruiter messaging).\n");
    process.exit(2);
  }
  if (!signature) {
    out.stderr.write("error: --signature is required (v2: REQUIRED for Recruiter messaging).\n");
    process.exit(2);
  }

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
      method: "recruiter.startChat",
      args: { attendees_ids: [to] },
      body: { attendees_ids: [to], text, subject, signature },
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

  // Recruiter, classic, and SN chats all use `attendees_ids` (plural).
  const body = {
    attendees_ids: [to],
    text,
    subject,
    signature,
    ...(attachments.length > 0 ? { attachments } : {}),
  };

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.recruiter.startChat(body as RecruiterStartChatBody);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `recruiter profile <identifier>`.
 * Read command — rejects --preview. Identifier resolved via resolveIdentifier.
 */
export async function runRecruiterProfile(
  client: Curviate,
  flags: RecruiterFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = requireAccount(flags.account, out);
  const rawId = flags.identifier ?? "";
  const resolvedId = resolveIdentifier(rawId);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.recruiter.getProfile(resolvedId, {});
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `recruiter search people [filters…]`.
 * POST search — read-classified, rejects --preview.
 * Supports --all / --limit / --cursor pagination.
 */
export async function runRecruiterSearchPeople(
  client: Curviate,
  flags: RecruiterFlags,
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
  // The rich Recruiter filters are mostly nested objects, reachable via --filters.
  const assembled = await assembleFilters(flags, readers);
  if ("error" in assembled) {
    out.stderr.write(`error: ${assembled.error}\n`);
    process.exit(2);
  }
  const body = assembled.body;
  if (flags.keywords) body["keywords"] = flags.keywords;
  if (flags.locale) body["locale"] = flags.locale;
  if (flags["employment-type"]) body["employment_type"] = splitCsv(flags["employment-type"]);
  if (flags.function) body["function"] = splitCsv(flags.function);
  if (flags["profile-language"]) body["profile_language"] = splitCsv(flags["profile-language"]);

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
        return ns.recruiter.searchPeople(mergedBody, callParams) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      };
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.recruiter.searchPeople(body, Object.keys(params).length > 0 ? params : undefined);
      renderSuccess(result, outOpts, out);
    }
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `recruiter search parameters --source <s> --type <t> [--keywords <k>] [--project-id <id>] [--stage-id <id>]`.
 * Read command — rejects --preview.
 *
 * v2: getParameters (GET) is replaced by searchParameters (POST) — the body
 * is a source-discriminated oneOf (APPLICANTS/PIPELINE require project_id;
 * PIPELINE additionally accepts stage_id). `--source` is a free-form CLI
 * flag, so a narrow cast stands in for full static discrimination of the
 * union.
 */
export async function runRecruiterSearchParameters(
  client: Curviate,
  flags: RecruiterFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  if (!flags.source) {
    out.stderr.write("error: --source is required (APPLICANTS, PIPELINE, SEARCH, JOB_POSTING, or JOBS).\n");
    process.exit(2);
  }
  if (!flags.type) {
    out.stderr.write("error: --type is required.\n");
    process.exit(2);
  }

  const accountId = requireAccount(flags.account, out);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  const body = {
    source: flags.source,
    type: flags.type,
    ...(flags.keywords ? { keywords: flags.keywords } : {}),
    ...(flags["project-id"] ? { project_id: flags["project-id"] } : {}),
    ...(flags["stage-id"] ? { stage_id: flags["stage-id"] } : {}),
  } as RecruiterSearchParametersBody;

  const params: Record<string, unknown> = {};
  if (flags.limit) params["limit"] = parseInt(flags.limit, 10);

  try {
    const result = await ns.recruiter.searchParameters(body, Object.keys(params).length > 0 ? params : undefined);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `recruiter search <url> [--all] [--limit] [--cursor]`.
 * Read command — rejects --preview. Paginated. Runs a pasted Recruiter
 * search/talent-pool/applicant URL directly; the response is a 3-way oneOf
 * keyed by the URL kind — rendered verbatim, no client-side branching.
 */
export async function runRecruiterSearchFromUrl(
  client: Curviate,
  flags: RecruiterFlags,
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

  const body: RecruiterSearchFromUrlBody = { url };
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
        return ns.recruiter.searchFromUrl(body, callParams) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      };
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.recruiter.searchFromUrl(body, Object.keys(params).length > 0 ? params : undefined);
      renderSuccess(result, outOpts, out);
    }
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `recruiter projects [--all] [--limit] [--cursor]`.
 * Read command — rejects --preview. Paginated.
 */
export async function runRecruiterListProjects(
  client: Curviate,
  flags: RecruiterFlags,
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
      const fn = (p: Record<string, unknown>) => ns.recruiter.listProjects(p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.recruiter.listProjects(Object.keys(params).length > 0 ? params : undefined);
      renderSuccess(result, outOpts, out);
    }
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `recruiter project <project_id>`.
 * Read command — rejects --preview. project_id passes verbatim.
 */
export async function runRecruiterGetProject(
  client: Curviate,
  flags: RecruiterFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = requireAccount(flags.account, out);
  const projectId = flags.projectId ?? "";
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.recruiter.getProject(projectId);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `recruiter project update <project_id> [flags…]`.
 * Write command — supports --preview. project_id passes verbatim.
 * PATCH semantics: every field is optional; only supplied flags are sent.
 */
export async function runRecruiterUpdateProject(
  client: Curviate,
  flags: RecruiterFlags,
  out: OutputStreams,
): Promise<void> {
  const accountId = requireAccount(flags.account, out);
  const projectId = flags.projectId ?? "";
  const outOpts = resolveOutputOpts(flags);

  const body: Record<string, unknown> = {};
  if (flags.name !== undefined) body["name"] = flags.name;
  if (flags.visibility !== undefined) body["visibility"] = flags.visibility;
  if (flags.description !== undefined) body["description"] = flags.description;
  const company = buildRecruiterRef(flags["company-id"], flags["company-name"]);
  if (company) body["company"] = company;
  if (flags["job-title-id"] !== undefined || flags["job-title"] !== undefined) {
    body["job_title"] = {
      ...(flags["job-title-id"] !== undefined ? { id: flags["job-title-id"] } : {}),
      ...(flags["job-title"] !== undefined ? { name: flags["job-title"] } : {}),
    };
  }
  if (flags.location !== undefined) body["location"] = flags.location;
  if (flags["seniority-level"] !== undefined) body["seniority_level"] = flags["seniority-level"];

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "recruiter.updateProject",
      args: { project_id: projectId },
      body,
      account: accountId,
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);

  try {
    const result = await ns.recruiter.updateProject(projectId, body as RecruiterUpdateProjectBody);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `recruiter pipeline <project_id> [filters…]`.
 * Read command (POST-as-list) — rejects --preview. Paginated. project_id
 * passes verbatim. No required flags — the filter body is all-optional.
 */
export async function runRecruiterListPipeline(
  client: Curviate,
  flags: RecruiterFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = requireAccount(flags.account, out);
  const projectId = flags.projectId ?? "";
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
  const limit = flags.limit ? parseInt(flags.limit, 10) : undefined;
  const cursor = flags.cursor;

  const body: Record<string, unknown> = {};
  if (flags.keywords) body["keywords"] = flags.keywords;
  if (flags["stage-id"]) body["stage_id"] = flags["stage-id"];
  if (flags["sort-by"]) body["sort_by"] = flags["sort-by"];
  if (flags.spotlights) body["spotlights"] = splitCsv(flags.spotlights);

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
        return ns.recruiter.listPipeline(projectId, body as RecruiterListPipelineBody, callParams) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      };
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.recruiter.listPipeline(
        projectId,
        Object.keys(body).length > 0 ? (body as RecruiterListPipelineBody) : undefined,
        Object.keys(params).length > 0 ? params : undefined,
      );
      renderSuccess(result, outOpts, out);
    }
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `recruiter project-job get <project_id>`.
 * Read command — rejects --preview. Single object (the ONE job posting
 * attached to the project, not a list); 404 RESOURCE_NOT_FOUND when no job
 * is attached — surfaced via the standard exit-code map (exit 4), no special
 * client-side handling required.
 */
export async function runRecruiterGetProjectJob(
  client: Curviate,
  flags: RecruiterFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = requireAccount(flags.account, out);
  const projectId = flags.projectId ?? "";
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.recruiter.getProjectJob(projectId);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `recruiter project-job budget <project_id> <job_id>`.
 * Read command — rejects --preview. Single object. project_id/job_id pass verbatim.
 */
export async function runRecruiterGetProjectJobBudget(
  client: Curviate,
  flags: RecruiterFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = requireAccount(flags.account, out);
  const projectId = flags.projectId ?? "";
  const jobId = flags.jobId ?? "";
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.recruiter.getProjectJobBudget(projectId, jobId);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `recruiter save-candidate <project_id> --stage-id <id> --candidate-id <id>`.
 * Write command — supports --preview. project_id passes verbatim.
 *
 * v2: addCandidate(user_id, {hiring_project_id, stage}) is replaced by the
 * project-scoped saveCandidate(project_id, {stage_id, candidate_id}) — a
 * full body reshape, and the command is renamed to match.
 */
export async function runRecruiterSaveCandidate(
  client: Curviate,
  flags: RecruiterFlags,
  out: OutputStreams,
): Promise<void> {
  const accountId = requireAccount(flags.account, out);
  const projectId = flags.projectId ?? "";
  const outOpts = resolveOutputOpts(flags);

  const body: RecruiterSaveCandidateBody = {
    stage_id: flags["stage-id"] ?? "",
    candidate_id: flags["candidate-id"] ?? "",
  };

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "recruiter.saveCandidate",
      args: { project_id: projectId },
      body,
      account: accountId,
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);

  try {
    const result = await ns.recruiter.saveCandidate(projectId, body);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `recruiter jobs [--all] [--limit] [--cursor]`.
 * Read command — rejects --preview. Paginated.
 */
export async function runRecruiterListJobs(
  client: Curviate,
  flags: RecruiterFlags,
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
      const fn = (p: Record<string, unknown>) => ns.recruiter.listJobs(p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.recruiter.listJobs(Object.keys(params).length > 0 ? params : undefined);
      renderSuccess(result, outOpts, out);
    }
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `recruiter job create [--body-file <path> | --body -] [scalar flags…]`.
 * Write command — supports --preview. Opens a brand-new project — --project-name
 * is required in addition to the full recruiter-job-body required set.
 *
 * The job-create body is deeply nested (job_title, company, apply_method —
 * several of which are objects). Rather than enumerate a flag per nested
 * field, the body is supplied as JSON via --body-file <path> or --body -
 * (stdin), with top-level scalar convenience flags (--job-title-id,
 * --job-title, --company-id, --workplace-type, --employment-status,
 * --seniority-level, --industry, --job-function, --apply-method, …) merging
 * OVER the JSON — see assembleRecruiterJobBody.
 *
 * The CLI validates that the JSON parses AND that every required top-level
 * key is present in the assembled body (naming the flag, exit 2, before any
 * SDK call); deep shape validation within a field (e.g. apply_method's
 * companion field) is left to the API's 400.
 */
export async function runRecruiterCreateJob(
  client: Curviate,
  flags: RecruiterFlags,
  out: OutputStreams,
  readers: JobCreateReaders = DEFAULT_JOB_CREATE_READERS,
): Promise<void> {
  const accountId = requireAccount(flags.account, out);
  const outOpts = resolveOutputOpts(flags);

  const assembled = await assembleRecruiterJobBody(flags, readers);
  if ("error" in assembled) {
    out.stderr.write(`error: ${assembled.error}\n`);
    process.exit(2);
  }
  const body = assembled.body;

  // project_name is a new v2 top-level requirement (createJob always opens a
  // brand-new project) — folded into the shared required-fields check
  // alongside the rest of the recruiter job body.
  requireRecruiterJobFields(body, [["project_name", "--project-name"]], out);

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "recruiter.createJob",
      args: {},
      body,
      account: accountId,
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);

  try {
    // Narrow cast: the body is assembled from free-form JSON (--body-file/
    // --body -) merged with scalar convenience flags; deep structural
    // validation within a field (apply_method's companion, enum values) is
    // left to the API's 400, as documented on assembleRecruiterJobBody.
    const result = await ns.recruiter.createJob(body as RecruiterCreateJobBody);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `recruiter project-job create <project_id> [--body-file <path> | --body -] [scalar flags…]`.
 * Write command — supports --preview. project_id passes verbatim.
 * v2: createProjectJob attaches a job draft to an EXISTING project — same
 * body shape as `recruiter job create` minus project_name (the project comes
 * from the path). Never publishes, never spends money.
 */
export async function runRecruiterCreateProjectJob(
  client: Curviate,
  flags: RecruiterFlags,
  out: OutputStreams,
  readers: JobCreateReaders = DEFAULT_JOB_CREATE_READERS,
): Promise<void> {
  const accountId = requireAccount(flags.account, out);
  const projectId = flags.projectId ?? "";
  const outOpts = resolveOutputOpts(flags);

  const assembled = await assembleRecruiterJobBody(flags, readers);
  if ("error" in assembled) {
    out.stderr.write(`error: ${assembled.error}\n`);
    process.exit(2);
  }
  const body = assembled.body;
  requireRecruiterJobFields(body, [], out);

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "recruiter.createProjectJob",
      args: { project_id: projectId },
      body,
      account: accountId,
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);

  try {
    const result = await ns.recruiter.createProjectJob(projectId, body as RecruiterCreateProjectJobBody);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `recruiter project-job update <project_id> <job_id> [--body-file <path> | --body -] [scalar flags…]`.
 * Write command — supports --preview. project_id/job_id pass verbatim.
 * v2: PATCH semantics — every field is optional; only supplied fields
 * change. MONEY WARNING (updateProjectJob): editing an already-published
 * posting mutates a live, money-spending listing.
 */
export async function runRecruiterUpdateProjectJob(
  client: Curviate,
  flags: RecruiterFlags,
  out: OutputStreams,
  readers: JobCreateReaders = DEFAULT_JOB_CREATE_READERS,
): Promise<void> {
  const accountId = requireAccount(flags.account, out);
  const projectId = flags.projectId ?? "";
  const jobId = flags.jobId ?? "";
  const outOpts = resolveOutputOpts(flags);

  const assembled = await assembleRecruiterJobBody(flags, readers);
  if ("error" in assembled) {
    out.stderr.write(`error: ${assembled.error}\n`);
    process.exit(2);
  }
  const body = assembled.body;

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "recruiter.updateProjectJob",
      args: { project_id: projectId, job_id: jobId },
      body,
      account: accountId,
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);

  try {
    const result = await ns.recruiter.updateProjectJob(projectId, jobId, body as RecruiterUpdateProjectJobBody);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

const RECRUITER_PUBLISH_MODES = ["FREE", "PROMOTED", "PROMOTED_PLUS"] as const;
const RECRUITER_BUDGET_SCOPES = ["DAILY", "TOTAL"] as const;

/**
 * Run `recruiter job publish <project_id> <job_id> --mode <m> [--budget-*]`.
 * Write command — supports --preview. project_id/job_id pass verbatim.
 * v2: publishJob is project-scoped (project_id leads job_id). --mode is
 * required; PROMOTED/PROMOTED_PLUS require a full --budget-* triple —
 * supplying it is the explicit opt-in to spend real money.
 */
export async function runRecruiterPublishJob(
  client: Curviate,
  flags: RecruiterFlags,
  out: OutputStreams,
): Promise<void> {
  const accountId = requireAccount(flags.account, out);
  const projectId = flags.projectId ?? "";
  const jobId = flags.jobId ?? "";
  const outOpts = resolveOutputOpts(flags);

  if (!flags.mode) {
    out.stderr.write("error: --mode is required (FREE, PROMOTED, or PROMOTED_PLUS).\n");
    process.exit(2);
  }
  if (!RECRUITER_PUBLISH_MODES.includes(flags.mode as (typeof RECRUITER_PUBLISH_MODES)[number])) {
    out.stderr.write(`error: --mode must be one of: ${RECRUITER_PUBLISH_MODES.join(", ")}. Got "${flags.mode}".\n`);
    process.exit(2);
  }
  const mode = flags.mode;

  let body: Record<string, unknown> = { mode };
  if (mode === "PROMOTED" || mode === "PROMOTED_PLUS") {
    if (!flags["budget-currency"]) {
      out.stderr.write("error: --budget-currency is required for a paid publish (PROMOTED/PROMOTED_PLUS).\n");
      process.exit(2);
    }
    if (!flags["budget-amount"]) {
      out.stderr.write("error: --budget-amount is required for a paid publish (PROMOTED/PROMOTED_PLUS).\n");
      process.exit(2);
    }
    if (!flags["budget-scope"]) {
      out.stderr.write("error: --budget-scope is required for a paid publish (PROMOTED/PROMOTED_PLUS).\n");
      process.exit(2);
    }
    if (!RECRUITER_BUDGET_SCOPES.includes(flags["budget-scope"] as (typeof RECRUITER_BUDGET_SCOPES)[number])) {
      out.stderr.write(`error: --budget-scope must be one of: ${RECRUITER_BUDGET_SCOPES.join(", ")}. Got "${flags["budget-scope"]}".\n`);
      process.exit(2);
    }
    const amount = Number(flags["budget-amount"]);
    if (!Number.isFinite(amount) || amount < 0) {
      out.stderr.write("error: --budget-amount must be a non-negative number.\n");
      process.exit(2);
    }
    body = { mode, budget: { currency: flags["budget-currency"], amount, scope: flags["budget-scope"] } };
  }

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "recruiter.publishJob",
      args: { project_id: projectId, job_id: jobId },
      body,
      account: accountId,
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);

  try {
    // Narrow cast at the body-argument call site: mode + budget are
    // validated above; the body is a mode-discriminated oneOf.
    const result = await ns.recruiter.publishJob(projectId, jobId, body as RecruiterPublishJobBody);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `recruiter job close <project_id> <job_id>`.
 * Write command — supports --preview. Bodyless. project_id/job_id pass verbatim.
 * IMPACT WARNING: closing an already-published posting is irreversible — there
 * is no re-open operation.
 */
export async function runRecruiterCloseJob(
  client: Curviate,
  flags: RecruiterFlags,
  out: OutputStreams,
): Promise<void> {
  const accountId = requireAccount(flags.account, out);
  const projectId = flags.projectId ?? "";
  const jobId = flags.jobId ?? "";

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "recruiter.closeJob",
      args: { project_id: projectId, job_id: jobId },
      body: {},
      account: accountId,
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.recruiter.closeJob(projectId, jobId);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `recruiter talent-search <project_id> --channel-id <id> [filters…]`.
 * Read command (POST-as-search) — rejects --preview. Paginated. project_id
 * passes verbatim. `--channel-id` is required (the project's own
 * RECRUITER_SEARCH talent-pool channel).
 */
export async function runRecruiterSearchTalentPool(
  client: Curviate,
  flags: RecruiterFlags,
  out: OutputStreams,
  readers: FilterReaders = DEFAULT_FILTER_READERS,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  if (!flags["channel-id"]) {
    out.stderr.write("error: --channel-id is required.\n");
    process.exit(2);
  }

  const accountId = requireAccount(flags.account, out);
  const projectId = flags.projectId ?? "";
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
  const limit = flags.limit ? parseInt(flags.limit, 10) : undefined;
  const cursor = flags.cursor;

  const assembled = await assembleFilters(flags, readers);
  if ("error" in assembled) {
    out.stderr.write(`error: ${assembled.error}\n`);
    process.exit(2);
  }
  const body = assembled.body;
  body["channel_id"] = flags["channel-id"];
  if (flags.keywords) body["keywords"] = flags.keywords;

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
        return ns.recruiter.searchTalentPool(projectId, body as RecruiterSearchTalentPoolBody, callParams) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      };
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await ns.recruiter.searchTalentPool(projectId, body as RecruiterSearchTalentPoolBody, Object.keys(params).length > 0 ? params : undefined);
      renderSuccess(result, outOpts, out);
    }
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `recruiter applicants <project_id> --channel-id <id>`.
 * Read command — rejects --preview. project_id passes verbatim.
 *
 * v2: listApplicants is project-scoped, not job-scoped (a project id in the
 * positional — a job_id here would 404 against the real v2 op) and requires
 * `channel_id` (the project's own JOB_POSTING talent-pool channel) in the body.
 * The command is top-level under `recruiter` (not nested under `job`) to match
 * that project scope.
 */
export async function runRecruiterListApplicants(
  client: Curviate,
  flags: RecruiterFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  if (!flags["channel-id"]) {
    out.stderr.write("error: --channel-id is required.\n");
    process.exit(2);
  }

  const accountId = requireAccount(flags.account, out);
  const projectId = flags.projectId ?? "";
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  const body: RecruiterListApplicantsBody = { channel_id: flags["channel-id"] };
  const params: Record<string, unknown> = {};
  if (flags.limit) params["limit"] = parseInt(flags.limit, 10);
  if (flags.cursor) params["cursor"] = flags.cursor;

  try {
    const result = await ns.recruiter.listApplicants(projectId, body, Object.keys(params).length > 0 ? params : undefined);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `recruiter job get <url|id>`.
 * Read command — rejects --preview. Retrieves any public job posting via the
 * Recruiter lens (not only the operator's own postings) — the Recruiter
 * sibling of the top-level `job get` command, same underlying job-posting
 * shape. The positional accepts a job URL or a bare numeric id, resolved via
 * `resolveJobIdentifier` (mirrors `job get`'s resolution).
 */
export async function runRecruiterGetJob(
  client: Curviate,
  flags: RecruiterFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = requireAccount(flags.account, out);
  const rawJobId = flags.jobId ?? "";
  const jobId = resolveJobIdentifier(rawJobId);
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.recruiter.getJob(jobId);
    renderSuccess(result, { ...outOpts, slim: slimJob }, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `recruiter applicant <project_id> <applicant_id>`.
 * Read command — rejects --preview. project_id/applicant_id pass verbatim.
 * v2: getApplicant is project-scoped (project_id leads applicant_id).
 */
export async function runRecruiterGetApplicant(
  client: Curviate,
  flags: RecruiterFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = requireAccount(flags.account, out);
  const projectId = flags.projectId ?? "";
  const applicantId = flags.applicantId ?? "";
  const ns = client.account(accountId);
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await ns.recruiter.getApplicant(projectId, applicantId);
    renderSuccess(result, outOpts, out);
  } catch (err: unknown) {
    await handleSdkError(err, outOpts, out);
  }
}

/**
 * Run `recruiter applicant resume <project_id> <applicant_id> -o <file>`.
 * Read command — binary response. Rejects --preview.
 * v2: downloadResume is project-scoped (project_id leads applicant_id).
 * @param isTTY — injectable for tests.
 */
export async function runRecruiterDownloadResume(
  client: Curviate,
  flags: RecruiterFlags,
  out: OutputStreams,
  isTTY: boolean,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const accountId = requireAccount(flags.account, out);
  const projectId = flags.projectId ?? "";
  const applicantId = flags.applicantId ?? "";
  const ns = client.account(accountId);

  try {
    const data = await ns.recruiter.downloadResume(projectId, applicantId);
    await writeBinaryOutput(data, {
      outputPath: flags.output,
      isTTY,
      stdout: process.stdout,
    });
  } catch (err: unknown) {
    if (err instanceof BinaryOutputError) {
      out.stderr.write(`error: ${err.message}\n`);
      process.exit(err.exitCode);
    }
    const outOpts = resolveOutputOpts(flags);
    await handleSdkError(err, outOpts, out);
  }
}

// ---------------------------------------------------------------------------
// Citty command definitions
// ---------------------------------------------------------------------------

const recruiterMessageNewCommand = defineCommand({
  meta: { name: "new", description: "Start a new Recruiter chat with a member." },
  args: {
    // Write command: WRITE_FLAGS omits pagination/projection flags
    ...WRITE_FLAGS,
    to: {
      type: "string",
      description:
        "Recipient's LinkedIn provider ID (AE… format, e.g. from a Recruiter search result or profile). Not resolved from a URL/slug. Pass the provider ID directly.",
      required: true,
    },
    subject: { type: "string", description: "Message subject line (required for Recruiter InMail).", required: true },
    signature: { type: "string", description: "Sender signature (required for Recruiter InMail).", required: true },
    text: { type: "positional", description: "Opening message text." },
    attach: { type: "string", description: "File to attach (repeatable, max 7 MiB each)." },
    voice: { type: "string", description: "Voice message file (max 7 MiB)." },
    video: { type: "string", description: "Video message file (max 7 MiB)." },
  },
  async run({ args }) {
    const flags = args as RecruiterFlags;
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
    await runRecruiterMessageNew(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const recruiterMessageCommand = defineCommand({
  meta: { name: "message", description: "Recruiter messaging operations." },
  args: { ...GLOBAL_FLAGS },
  subCommands: {
    new: recruiterMessageNewCommand,
  },
  async run() {
    process.stderr.write("Usage: curviate recruiter message new --to <id> \"<text>\" [--attach <file>…]\n");
  },
});

const recruiterProfileCommand = defineCommand({
  meta: { name: "profile", description: "Get a Recruiter enriched member profile." },
  args: {
    // Single-object read: READ_SINGLE_FLAGS omits pagination flags, keeps --fields
    ...READ_SINGLE_FLAGS,
    identifier: { type: "positional", description: "LinkedIn URL, slug, or native id." },
  },
  async run({ args }) {
    const flags = args as RecruiterFlags;
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
    await runRecruiterProfile(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const recruiterSearchPeopleCommand = defineCommand({
  meta: { name: "people", description: "Search Recruiter member profiles." },
  args: {
    ...GLOBAL_FLAGS,
    keywords: { type: "string", description: "Keyword search string." },
    filters: { type: "string", stdinArg: true, description: "Filter body as a JSON object (escape hatch for the full filter surface); '-' reads JSON from stdin." },
    "filters-file": { type: "string", description: "Path to a JSON file with the filter body." },
    locale: { type: "string", description: "Result locale, e.g. en." },
    "employment-type": { type: "string", description: "Employment type ids (comma-separated)." },
    function: { type: "string", description: "Job function ids (comma-separated)." },
    "profile-language": { type: "string", description: "Profile language codes (comma-separated)." },
  },
  async run({ args }) {
    const flags = args as RecruiterFlags;
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
    await runRecruiterSearchPeople(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const recruiterSearchParametersCommand = defineCommand({
  meta: { name: "parameters", description: "Resolve Recruiter filter parameter IDs (POST, source-scoped)." },
  args: {
    ...GLOBAL_FLAGS,
    source: {
      type: "string",
      description:
        "Filter family to resolve within: APPLICANTS or PIPELINE (both require --project-id), SEARCH, JOB_POSTING, or JOBS.",
      required: true,
    },
    type: {
      type: "string",
      description:
        "Parameter type to resolve; the valid set depends on --source (e.g. SKILL/LOCATION/JOB_TITLE for APPLICANTS, CONTRACT/SEAT/LOCATION for JOBS).",
      required: true,
    },
    keywords: { type: "string", description: "Human term to resolve (e.g. Berlin)." },
    "project-id": { type: "string", description: "Recruiter project ID (required for --source APPLICANTS or PIPELINE)." },
    "stage-id": { type: "string", description: "Pipeline stage ID to filter to (only meaningful for --source PIPELINE)." },
  },
  async run({ args }) {
    const flags = args as RecruiterFlags;
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
    await runRecruiterSearchParameters(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const recruiterSearchCommand = defineCommand({
  meta: { name: "search", description: "Recruiter search operations. Also runs a pasted Recruiter search/talent-pool/applicant URL directly." },
  args: {
    ...GLOBAL_FLAGS,
    url: {
      type: "positional",
      required: false,
      description: "A pasted Recruiter search, talent-pool, or applicant URL. Runs it directly (recruiter.searchFromUrl).",
    },
  },
  subCommands: {
    people: recruiterSearchPeopleCommand,
    parameters: recruiterSearchParametersCommand,
  },
  async run({ args }) {
    const flags = args as RecruiterFlags;

    // Bare form: `recruiter search <url>` runs the URL directly. No url → print usage.
    if (!flags.url) {
      process.stderr.write(
        "Usage: curviate recruiter search <url>\n" +
        "       curviate recruiter search people [--keywords <k>]\n" +
        "       curviate recruiter search parameters --source <s> --type <t>\n",
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
    await runRecruiterSearchFromUrl(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const recruiterProjectsCommand = defineCommand({
  meta: { name: "projects", description: "List Recruiter hiring projects." },
  args: { ...GLOBAL_FLAGS },
  async run({ args }) {
    const flags = args as RecruiterFlags;
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
    await runRecruiterListProjects(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const recruiterProjectUpdateCommand = defineCommand({
  meta: { name: "update", description: "Edit a Recruiter project's config. All fields optional; omitted fields are left unchanged." },
  args: {
    // Write command: WRITE_SINGLE_FLAGS omits pagination flags, keeps --fields
    ...WRITE_SINGLE_FLAGS,
    projectId: { type: "positional", description: "Recruiter project ID." },
    name: { type: "string", description: "New project name." },
    visibility: { type: "string", description: "New project visibility: PRIVATE or PUBLIC." },
    description: { type: "string", description: "New project description." },
    "company-id": { type: "string", description: "Target company id." },
    "company-name": { type: "string", description: "Target company as free text (used when no id is given)." },
    "job-title-id": { type: "string", description: "Target job-title parameter id." },
    "job-title": { type: "string", description: "Target job-title display name." },
    location: { type: "string", description: "A LOCATION parameter id (resolve via search parameters)." },
    "seniority-level": { type: "string", description: "Target seniority level: INTERNSHIP|ENTRY_LEVEL|ASSOCIATE|MID_SENIOR_LEVEL|DIRECTOR|EXECUTIVE|NOT_APPLICABLE." },
  },
  async run({ args }) {
    const flags = args as RecruiterFlags;
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
    await runRecruiterUpdateProject(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const recruiterProjectCommand = defineCommand({
  meta: { name: "project", description: "Get a Recruiter hiring project by ID." },
  args: {
    // Single-object read: READ_SINGLE_FLAGS omits pagination flags, keeps --fields
    ...READ_SINGLE_FLAGS,
    projectId: { type: "positional", description: "Recruiter project ID." },
  },
  subCommands: {
    update: recruiterProjectUpdateCommand,
  },
  async run({ args }) {
    const flags = args as RecruiterFlags;
    if (!flags.projectId) {
      process.stderr.write(
        "Usage: curviate recruiter project <project_id>\n" +
        "       curviate recruiter project update <project_id> [flags…]\n",
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
    await runRecruiterGetProject(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const recruiterPipelineCommand = defineCommand({
  meta: { name: "pipeline", description: "List candidates in a project's pipeline (POST-as-list)." },
  args: {
    ...GLOBAL_FLAGS,
    projectId: { type: "positional", description: "Recruiter project ID." },
    keywords: { type: "string", description: "Free-text keyword search." },
    "stage-id": { type: "string", description: "Filter to a single pipeline stage id." },
    "sort-by": { type: "string", description: "Sort field: LAST_MODIFIED or ALPHABETICAL." },
    spotlights: { type: "string", description: "Spotlight tags (comma-separated): OPEN_TO_WORK, ACTIVE_TALENT, MISSED_CANDIDATES." },
  },
  async run({ args }) {
    const flags = args as RecruiterFlags;
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
    await runRecruiterListPipeline(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const recruiterSaveCandidateCommand = defineCommand({
  meta: { name: "save-candidate", description: "Save a candidate to a project's pipeline at a given stage." },
  args: {
    // Write command: WRITE_FLAGS omits pagination/projection flags
    ...WRITE_FLAGS,
    projectId: { type: "positional", description: "Recruiter project ID." },
    "stage-id": { type: "string", description: "Pipeline stage ID to save the candidate into.", required: true },
    "candidate-id": { type: "string", description: "Candidate id or user-profile id to save.", required: true },
  },
  async run({ args }) {
    const flags = args as RecruiterFlags;
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
    await runRecruiterSaveCandidate(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const recruiterJobsCommand = defineCommand({
  meta: { name: "jobs", description: "List Recruiter job postings." },
  args: { ...GLOBAL_FLAGS },
  async run({ args }) {
    const flags = args as RecruiterFlags;
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
    await runRecruiterListJobs(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

// Shared body flags for recruiter job create / project-job create / update
// (kebab → snake_case body keys via assembleRecruiterJobBody). All fields
// are also reachable via --body-file/--body - JSON.
const RECRUITER_JOB_BODY_FLAGS = {
  "body-file": { type: "string" as const, description: "Path to a JSON file with the full job body." },
  body: { type: "string" as const, stdinArg: true, description: "Read the JSON job body from stdin (pass '-')." },
  "job-title-id": { type: "string" as const, description: "Resolved job-title parameter id (merged with --job-title into job_title:{id,name})." },
  "job-title": { type: "string" as const, description: "Job title display name (merged with --job-title-id into job_title:{id,name})." },
  "company-id": { type: "string" as const, description: "Resolved company id (or use --company-name for free text)." },
  "company-name": { type: "string" as const, description: "Company as free text (used when no resolved id is available)." },
  "workplace-type": { type: "string" as const, description: "Workplace arrangement: ON_SITE|HYBRID|REMOTE." },
  location: { type: "string" as const, description: "A resolved LOCATION parameter id." },
  "employment-status": { type: "string" as const, description: "Employment type: FULL_TIME|PART_TIME|CONTRACT|TEMPORARY|OTHER|VOLUNTEER|INTERNSHIP." },
  "seniority-level": { type: "string" as const, description: "Seniority level: INTERNSHIP|ENTRY_LEVEL|ASSOCIATE|MID_SENIOR_LEVEL|DIRECTOR|EXECUTIVE|NOT_APPLICABLE." },
  description: { type: "string" as const, description: "Full job description (min 200 chars; merged over the JSON)." },
  industry: { type: "string" as const, description: "Industry parameter ids, 1-3 (comma-separated)." },
  "job-function": { type: "string" as const, description: "Job-function parameter ids, 1-3 (comma-separated)." },
  "apply-method": { type: "string" as const, description: "How candidates apply: linkedin|external." },
  "notification-email": { type: "string" as const, description: "Email notified of new applicants (used when --apply-method is linkedin)." },
  "website-url": { type: "string" as const, description: "External apply URL (used when --apply-method is external)." },
};

const recruiterJobCreateCommand = defineCommand({
  meta: { name: "create", description: "Create a Recruiter job posting draft, opening a brand-new hiring project." },
  args: {
    // Write command: WRITE_FLAGS omits pagination/projection flags
    ...WRITE_FLAGS,
    ...RECRUITER_JOB_BODY_FLAGS,
    "project-name": { type: "string", description: "Name for the new hiring project this job opens (required).", required: true },
  },
  async run({ args }) {
    const flags = args as RecruiterFlags;
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
    await runRecruiterCreateJob(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const recruiterJobPublishCommand = defineCommand({
  meta: { name: "publish", description: "Publish a Recruiter job posting draft. PROMOTED/PROMOTED_PLUS spend real money and require --budget-amount, --budget-currency, and --budget-scope." },
  args: {
    // Write command: WRITE_SINGLE_FLAGS omits pagination flags, keeps --fields
    ...WRITE_SINGLE_FLAGS,
    projectId: { type: "positional", description: "Recruiter project ID." },
    jobId: { type: "positional", description: "Job posting ID." },
    mode: { type: "string", description: "Publish mode (required): FREE|PROMOTED|PROMOTED_PLUS.", required: true },
    "budget-currency": { type: "string", description: "ISO-4217 currency (required for a paid publish), e.g. EUR." },
    "budget-amount": { type: "string", description: "Budget amount (required for a paid publish)." },
    "budget-scope": { type: "string", description: "Budget scope (required for a paid publish): DAILY|TOTAL." },
  },
  async run({ args }) {
    const flags = args as RecruiterFlags;
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
    await runRecruiterPublishJob(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const recruiterApplicantsCommand = defineCommand({
  meta: { name: "applicants", description: "List applicants in a Recruiter project's talent pool." },
  args: {
    ...GLOBAL_FLAGS,
    projectId: { type: "positional", description: "Recruiter project ID." },
    "channel-id": { type: "string", description: "The project's JOB_POSTING talent-pool channel ID (required).", required: true },
  },
  async run({ args }) {
    const flags = args as RecruiterFlags;
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
    await runRecruiterListApplicants(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const recruiterJobGetCommand = defineCommand({
  meta: { name: "get", description: "Get a job posting via the Recruiter lens (any public posting, not only your own)." },
  args: {
    ...READ_SINGLE_FLAGS,
    jobId: { type: "positional", description: "Job URL (e.g. https://www.linkedin.com/jobs/view/4428113858) or a bare numeric job id." },
  },
  async run({ args }) {
    const flags = args as RecruiterFlags;
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
    await runRecruiterGetJob(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const recruiterJobCloseCommand = defineCommand({
  meta: { name: "close", description: "Stop a project's job posting from accepting applications (irreversible once LISTED)." },
  args: {
    // Write command: WRITE_SINGLE_FLAGS omits pagination flags, keeps --fields
    ...WRITE_SINGLE_FLAGS,
    projectId: { type: "positional", description: "Recruiter project ID." },
    jobId: { type: "positional", description: "Job posting ID." },
  },
  async run({ args }) {
    const flags = args as RecruiterFlags;
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
    await runRecruiterCloseJob(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const recruiterJobCommand = defineCommand({
  meta: { name: "job", description: "Recruiter job posting operations." },
  args: { ...GLOBAL_FLAGS },
  subCommands: {
    create: recruiterJobCreateCommand,
    publish: recruiterJobPublishCommand,
    close: recruiterJobCloseCommand,
    get: recruiterJobGetCommand,
  },
  async run() {
    process.stderr.write(
      "Usage: curviate recruiter job create [flags…]\n" +
      "       curviate recruiter job publish <project_id> <job_id> --mode <FREE|PROMOTED|PROMOTED_PLUS>\n" +
      "       curviate recruiter job close <project_id> <job_id>\n" +
      "       curviate recruiter job get <url|id>\n",
    );
  },
});

const recruiterProjectJobGetCommand = defineCommand({
  meta: { name: "get", description: "Get the single job posting attached to a project (404 when none is attached)." },
  args: {
    // Single-object read: READ_SINGLE_FLAGS omits pagination flags, keeps --fields
    ...READ_SINGLE_FLAGS,
    projectId: { type: "positional", description: "Recruiter project ID." },
  },
  async run({ args }) {
    const flags = args as RecruiterFlags;
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
    await runRecruiterGetProjectJob(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const recruiterProjectJobCreateCommand = defineCommand({
  meta: { name: "create", description: "Create a job-posting draft attached to an existing project." },
  args: {
    // Write command: WRITE_SINGLE_FLAGS omits pagination flags, keeps --fields
    ...WRITE_SINGLE_FLAGS,
    ...RECRUITER_JOB_BODY_FLAGS,
    projectId: { type: "positional", description: "Recruiter project ID." },
  },
  async run({ args }) {
    const flags = args as RecruiterFlags;
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
    await runRecruiterCreateProjectJob(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const recruiterProjectJobBudgetCommand = defineCommand({
  meta: { name: "budget", description: "Get pricing to publish a project's job posting." },
  args: {
    // Single-object read: READ_SINGLE_FLAGS omits pagination flags, keeps --fields
    ...READ_SINGLE_FLAGS,
    projectId: { type: "positional", description: "Recruiter project ID." },
    jobId: { type: "positional", description: "Job posting ID." },
  },
  async run({ args }) {
    const flags = args as RecruiterFlags;
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
    await runRecruiterGetProjectJobBudget(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const recruiterProjectJobUpdateCommand = defineCommand({
  meta: { name: "update", description: "Apply a partial update to a project's job posting." },
  args: {
    // Write command: WRITE_SINGLE_FLAGS omits pagination flags, keeps --fields
    ...WRITE_SINGLE_FLAGS,
    ...RECRUITER_JOB_BODY_FLAGS,
    projectId: { type: "positional", description: "Recruiter project ID." },
    jobId: { type: "positional", description: "Job posting ID." },
  },
  async run({ args }) {
    const flags = args as RecruiterFlags;
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
    await runRecruiterUpdateProjectJob(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const recruiterProjectJobCommand = defineCommand({
  meta: { name: "project-job", description: "The single job posting attached to a Recruiter project." },
  args: {
    ...READ_SINGLE_FLAGS,
    projectId: { type: "positional", description: "Recruiter project ID.", required: false },
  },
  subCommands: {
    get: recruiterProjectJobGetCommand,
    create: recruiterProjectJobCreateCommand,
    budget: recruiterProjectJobBudgetCommand,
    update: recruiterProjectJobUpdateCommand,
  },
  async run({ args }) {
    const flags = args as RecruiterFlags;
    if (!flags.projectId) {
      process.stderr.write(
        "Usage: curviate recruiter project-job get <project_id>\n" +
        "       curviate recruiter project-job create <project_id> [flags…]\n" +
        "       curviate recruiter project-job budget <project_id> <job_id>\n" +
        "       curviate recruiter project-job update <project_id> <job_id> [flags…]\n",
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
    await runRecruiterGetProjectJob(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const recruiterTalentSearchCommand = defineCommand({
  meta: { name: "talent-search", description: "Search a project's talent pool." },
  args: {
    ...GLOBAL_FLAGS,
    projectId: { type: "positional", description: "Recruiter project ID." },
    "channel-id": { type: "string", description: "The project's RECRUITER_SEARCH talent-pool channel ID (required).", required: true },
    keywords: { type: "string", description: "Free-text keyword search." },
    filters: { type: "string", stdinArg: true, description: "Filter body as a JSON object (escape hatch for the full filter surface); '-' reads JSON from stdin." },
    "filters-file": { type: "string", description: "Path to a JSON file with the filter body." },
  },
  async run({ args }) {
    const flags = args as RecruiterFlags;
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
    await runRecruiterSearchTalentPool(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

const recruiterApplicantResumeCommand = defineCommand({
  meta: { name: "resume", description: "Download a job applicant's resume." },
  args: {
    // Single-object read: READ_SINGLE_FLAGS omits pagination flags, keeps --fields
    ...READ_SINGLE_FLAGS,
    projectId: { type: "positional", description: "Recruiter project ID." },
    applicantId: { type: "positional", description: "Applicant ID." },
    output: { type: "string", alias: "o", description: "Path to write the resume file." },
  },
  async run({ args }) {
    const flags = args as RecruiterFlags;
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
    await runRecruiterDownloadResume(
      client,
      { ...flags, account: flags.account ?? cfg.account },
      out,
      process.stdout.isTTY ?? false,
    );
  },
});

const recruiterApplicantCommand = defineCommand({
  meta: { name: "applicant", description: "Recruiter job applicant operations." },
  args: {
    // Single-object read: READ_SINGLE_FLAGS omits pagination flags, keeps --fields
    ...READ_SINGLE_FLAGS,
    projectId: { type: "positional", description: "Recruiter project ID.", required: false },
    applicantId: { type: "positional", description: "Applicant ID.", required: false },
  },
  subCommands: {
    resume: recruiterApplicantResumeCommand,
  },
  async run({ args }) {
    const flags = args as RecruiterFlags;
    if (!flags.projectId || !flags.applicantId) {
      process.stderr.write(
        "Usage: curviate recruiter applicant <project_id> <applicant_id>\n" +
        "       curviate recruiter applicant resume <project_id> <applicant_id> -o <file>\n",
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
    await runRecruiterGetApplicant(client, { ...flags, account: flags.account ?? cfg.account }, out);
  },
});

export const recruiterCommand = defineCommand({
  meta: { name: "recruiter", description: "LinkedIn Recruiter operations (requires the Recruiter add-on)." },
  args: { ...GLOBAL_FLAGS },
  subCommands: {
    message: recruiterMessageCommand,
    profile: recruiterProfileCommand,
    search: recruiterSearchCommand,
    projects: recruiterProjectsCommand,
    project: recruiterProjectCommand,
    pipeline: recruiterPipelineCommand,
    "project-job": recruiterProjectJobCommand,
    "talent-search": recruiterTalentSearchCommand,
    "save-candidate": recruiterSaveCandidateCommand,
    applicants: recruiterApplicantsCommand,
    jobs: recruiterJobsCommand,
    job: recruiterJobCommand,
    applicant: recruiterApplicantCommand,
  },
  async run() {
    process.stderr.write(
      "Usage: curviate recruiter message new --to <id> \"<text>\"\n" +
      "       curviate recruiter profile <identifier>\n" +
      "       curviate recruiter search people [--keywords <k>]\n" +
      "       curviate recruiter search parameters --source <s> --type <t>\n" +
      "       curviate recruiter search <url>\n" +
      "       curviate recruiter projects\n" +
      "       curviate recruiter project <project_id>\n" +
      "       curviate recruiter project update <project_id> [flags…]\n" +
      "       curviate recruiter pipeline <project_id>\n" +
      "       curviate recruiter project-job get <project_id>\n" +
      "       curviate recruiter project-job create <project_id> [flags…]\n" +
      "       curviate recruiter project-job budget <project_id> <job_id>\n" +
      "       curviate recruiter project-job update <project_id> <job_id> [flags…]\n" +
      "       curviate recruiter talent-search <project_id> --channel-id <id>\n" +
      "       curviate recruiter save-candidate <project_id> --stage-id <id> --candidate-id <id>\n" +
      "       curviate recruiter applicants <project_id> --channel-id <id>\n" +
      "       curviate recruiter jobs\n" +
      "       curviate recruiter job create [flags…]\n" +
      "       curviate recruiter job publish <project_id> <job_id> --mode <FREE|PROMOTED|PROMOTED_PLUS>\n" +
      "       curviate recruiter job close <project_id> <job_id>\n" +
      "       curviate recruiter job get <url|id>\n" +
      "       curviate recruiter applicant <project_id> <applicant_id>\n" +
      "       curviate recruiter applicant resume <project_id> <applicant_id> -o <file>\n",
    );
  },
});
