/**
 * `curviate campaign`: Campaigns and their Sequences.
 * Root-scoped (`curviate.campaigns.*`). Enrollments are the root `enrollment`
 * group.
 *
 * Documents: a Campaign file (`campaign create|update --file`) is checked before
 * any request, the Campaign fields against the vendored request schema
 * (lib/document.ts, `<path>: <rule>`), then its `sequence` with the SDK's
 * `validateSequence` (compiler-format lines, lib/sequence-report.ts). A pasted
 * `campaign get` output loses its read-only keys with a warning.
 * `lint` and `init` are offline.
 */
import { defineCommand } from "citty";
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Curviate, CurviateError } from "@curviate/sdk";
import { DESCRIPTIONS } from "./descriptions.js";
import { GLOBAL_FLAGS, READ_SINGLE_FLAGS, WRITE_SINGLE_FLAGS, readOnly } from "../lib/global-flags.js";
import { renderSuccess, writeNdjsonItem } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { DEFAULT_PAGE_DELAY_MS, streamAll, pageDelayFromFlags, readCursorFlag, readMaxPagesFlag, readableObject, readablePage, rejectPaginationModifiersWithoutAll } from "../lib/paginate.js";
import { documentSchema, parseDocument, readFileFlag, reportIssues, validate } from "../lib/document.js";
import { intFlag } from "../lib/int-flag.js";
import { isStdinToken } from "../lib/stdin.js";
import { compilerLines } from "../lib/sequence-report.js";
import { sendInChunks } from "../lib/chunks.js";
import { AttachError, readAttachment } from "../lib/attach.js";
import { fail, listFlag, outputOpts, rootClient, usage, type RootFlags } from "../lib/root-command.js";
import connectAndConverse from "../templates/connect-and-converse.json";
import engageThenConnect from "../templates/engage-then-connect.json";
import nurtureConnections from "../templates/nurture-connections.json";

/** Lead ids per add/remove request: `x-curviate-limits.items` of both operations (test-held equal to the fixture). */
export const BULK_MAX_IDS = 1000;

export const TEMPLATES: Record<string, unknown> = {
  "connect-and-converse": connectAndConverse,
  "engage-then-connect": engageThenConnect,
  "nurture-connections": nurtureConnections,
};

const STATUSES = ["draft", "scheduled", "active", "paused", "completed", "archived"];

type CampaignFlags = RootFlags & {
  id?: string;
  file?: string;
  status?: string;
  version?: string;
  "if-revision"?: string;
  sample?: string;
  lead?: string | string[];
  account?: string;
  accounts?: string;
  sort?: string;
  template?: string;
  output?: string;
  limit?: string;
  cursor?: string;
  all?: boolean;
  "max-pages"?: string;
  "page-delay"?: string;
  "skip-missing-email"?: boolean;
};

type Body = Record<string, unknown>;

function preview(method: string, args: Record<string, unknown>, body: unknown = {}): void {
  process.stdout.write(JSON.stringify(buildPreviewOutput({ method, args, body: body as Body })) + "\n");
}

/** `--file`'s path as the findings name it: `-` for stdin. */
const shownFile = (f: CampaignFlags) => (f.file === undefined || isStdinToken(f.file) ? "-" : f.file);

/**
 * The Sequence verdict printed in the compiler format on stderr, and in JSON
 * mode the server's refusal shape on stdout. Errors exit 2 (SEQUENCE_INVALID),
 * nothing sent; warnings print and never block.
 */
/**
 * W17, offline where the file holds both the Sequence and `settings.assign`. The rest is server-side.
 * ponytail: written here because this CLI pins a published SDK; move into the SDK's validator at its next release.
 */
function assignWarning(sequence: unknown, assign: unknown) {
  if (assign !== "already_connected" || !sequence || typeof sequence !== "object") return [];
  const steps = (sequence as Body)["steps"];
  if (!Array.isArray(steps)) return [];
  const at = steps.findIndex((s: Body | null) => s?.["do"] === "invite.send" && typeof s["id"] === "string");
  if (at < 0) return [];
  const rule = "settings.assign is already_connected, so anyone not already connected to a sending Account is skipped and this invitation never runs for them; use assign: auto";
  const hint = "Set settings.assign to auto, the default: it prefers an Account already connected and invites everyone else. Keep already_connected only for a Campaign that writes to existing Connections.";
  return [{ code: "W17" as const, path: `${(steps[at] as Body)["id"]}.do`, rule, message: rule, pointer: `/steps/${at}/do`, hint, docs_url: "https://docs.curviate.com/reference/sequence-rules#w17", severity: "warning" as const }];
}

async function checkSequence(f: CampaignFlags, text: string, sequence: unknown, prefix: string, settings?: unknown): Promise<{ warnings: unknown[] }> {
  const { validateSequence } = await import("@curviate/sdk");
  const verdict = validateSequence(sequence);
  verdict.warnings.push(...assignWarning(sequence, (settings as Body | null | undefined)?.["assign"]));
  const lines = compilerLines(shownFile(f), text, verdict, prefix);
  if (verdict.errors.length) {
    const first = verdict.errors[0]!;
    const message = `${first.path}: ${first.rule}${verdict.errors.length > 1 ? ` and ${verdict.errors.length - 1} more` : ""}`;
    if (outputOpts(f).json) process.stdout.write(JSON.stringify({ error: { code: "SEQUENCE_INVALID", message, errors: verdict.errors }, warnings: verdict.warnings }) + "\n");
    process.stderr.write(lines.map((l) => `${l}\n`).join(""));
    process.exit(2);
  }
  process.stderr.write(lines.map((l) => `${l}\n`).join(""));
  return verdict;
}

/** A Campaign file against the create/update schema: read-only keys dropped, then fields. Shared by `create`, `update` and `lint`, so lint cannot pass what create refuses. */
function checkCampaignFields(f: CampaignFlags, command: "campaign create" | "campaign update", doc: unknown): Body {
  const schema = documentSchema(command);
  let body = doc as Body;
  if (doc && typeof doc === "object" && !Array.isArray(doc)) {
    const readOnlyKeys = schema["x-curviate-response-only"] as string[];
    const dropped = Object.keys(doc).filter((k) => readOnlyKeys.includes(k));
    if (dropped.length) {
      process.stderr.write(`warning: dropped ${dropped.join(", ")}: set by Curviate, not part of a Campaign file (\`curviate campaign get\` output carries them).\n`);
      body = Object.fromEntries(Object.entries(doc).filter(([k]) => !dropped.includes(k)));
    }
  }
  const issues = validate(schema, body);
  if (issues.length) reportIssues(issues, outputOpts(f).json);
  return body;
}

/** A Campaign file, checked whole before any request: fields against the schema, then the Sequence. */
async function readCampaignFile(f: CampaignFlags, command: "campaign create" | "campaign update"): Promise<{ body: Body; text: string }> {
  const text = await readFileFlag("file", f.file ?? "", { others: f });
  const body = checkCampaignFields(f, command, parseDocument("file", text));
  if (body["sequence"] != null) await checkSequence(f, text, body["sequence"], "/sequence", body["settings"]);
  return { body, text };
}

/** A refusal the server lists with the compiler keys (a newer server than this CLI's SDK) prints in the same format. */
function explain(err: unknown, f: CampaignFlags, text: string): void {
  const e = err as Partial<CurviateError> & { current?: { sequence_revision?: number; sequence_updated_by_user_id?: string | null; updated_at?: string } };
  if (e.code === "SEQUENCE_INVALID" && e.errors?.length) {
    process.stderr.write(compilerLines(shownFile(f), text, { errors: e.errors, warnings: [] }, "/sequence").map((l) => `${l}\n`).join(""));
  }
  if (e.code === "SEQUENCE_CONFLICT" && e.current) {
    const c = e.current;
    process.stderr.write(
      `The Sequence was saved since revision ${f["if-revision"]}: revision ${c.sequence_revision} by ${c.sequence_updated_by_user_id ?? "an unknown user"} at ${c.updated_at ?? "an unknown time"}. ` +
        `Read it with \`curviate campaign get ${f.id}\` and merge, or send yours again with --if-revision ${c.sequence_revision} to replace it.\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Run functions
// ---------------------------------------------------------------------------

async function runList(c: Curviate, f: CampaignFlags): Promise<void> {
  rejectPaginationModifiersWithoutAll(f, process);
  const params: Body = {};
  if (f.status !== undefined) {
    const status = listFlag("status", f.status);
    const bad = status.filter((s) => !STATUSES.includes(s));
    if (bad.length) usage(`--status takes a comma list of ${STATUSES.join(", ")}.`);
    params["status"] = status;
  }
  const accounts = f.accounts ?? f.account;
  if (accounts !== undefined) params["account_id"] = listFlag("accounts", accounts);
  if (f.sort !== undefined) {
    if (!["updated", "activity"].includes(f.sort)) usage("--sort takes updated or activity.");
    params["sort"] = f.sort;
  }
  if (f.limit !== undefined) params["limit"] = intFlag("limit", f.limit, 1, 100);
  const cursor = readCursorFlag(f, process);
  if (cursor) params["cursor"] = cursor;
  try {
    if (f.all) {
      const page = (p: Body) => c.campaigns.list(p as never) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(page, params, { maxPages: readMaxPagesFlag(f, process), out: process, pageDelayMs: pageDelayFromFlags(f) })) writeNdjsonItem(process, item, f.fields);
    } else {
      renderSuccess(readablePage(await c.campaigns.list(params as never)), outputOpts(f), process);
    }
  } catch (err) {
    await fail(err, f);
  }
}

async function runGet(c: Curviate, f: CampaignFlags): Promise<void> {
  try {
    const result = f.version === undefined
      ? await c.campaigns.get(f.id ?? "")
      : await c.campaigns.getSequenceVersion(f.id ?? "", { version: intFlag("version", f.version) });
    renderSuccess(readableObject(result), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

async function runCreate(c: Curviate, f: CampaignFlags): Promise<void> {
  const { body, text } = await readCampaignFile(f, "campaign create");
  if (f.preview) return preview("campaigns.create", {}, body);
  try {
    renderSuccess(await c.campaigns.create(body as never), outputOpts(f), process);
  } catch (err) {
    explain(err, f, text);
    await fail(err, f);
  }
}

async function runUpdate(c: Curviate, f: CampaignFlags): Promise<void> {
  const olpc = (f as { "one-lead-per-company"?: boolean })["one-lead-per-company"];
  if (f.file === undefined && olpc === undefined) usage("pass --file <campaign.json>, --one-lead-per-company or --no-one-lead-per-company.");
  const { body, text } = f.file === undefined ? { body: {} as Body, text: "" } : await readCampaignFile(f, "campaign update");
  if (olpc !== undefined) body["settings"] = { ...((body["settings"] as Body | undefined) ?? {}), one_lead_per_company: olpc };
  // The precondition is sent only when asked for, never read from the file.
  if ("if_sequence_revision" in body) {
    process.stderr.write("warning: dropped if_sequence_revision from the file: pass --if-revision <n> to send it.\n");
    delete body["if_sequence_revision"];
  }
  if (f["if-revision"] !== undefined) body["if_sequence_revision"] = intFlag("if-revision", f["if-revision"], 0);
  if (f.preview) return preview("campaigns.update", { id: f.id }, body);
  try {
    renderSuccess(await c.campaigns.update(f.id ?? "", body as never), outputOpts(f), process);
  } catch (err) {
    explain(err, f, text);
    await fail(err, f);
  }
}

/** start, pause, resume, archive, delete: one call on one Campaign. start and resume send `{skip_missing_email: true}` when asked. */
const lifecycle = (method: "start" | "pause" | "resume" | "archive" | "delete") => async (c: Curviate, f: CampaignFlags): Promise<void> => {
  const body = f["skip-missing-email"] ? { skip_missing_email: true } : undefined;
  if (f.preview) return preview(`campaigns.${method}`, { id: f.id }, body);
  try {
    const id = f.id ?? "";
    renderSuccess(await (method === "start" || method === "resume" ? c.campaigns[method](id, body) : c.campaigns[method](id)), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
};

/** `--all`: every page merged into one answer, the first page's paths and projection, every page's samples. */
async function previewAll(c: Curviate, f: CampaignFlags, params: Body): Promise<Body> {
  const maxPages = readMaxPagesFlag(f, process);
  const delay = pageDelayFromFlags(f) ?? DEFAULT_PAGE_DELAY_MS;
  let merged: Body | undefined;
  for (let pages = 1; ; pages++) {
    const page = (await c.campaigns.preview(f.id ?? "", params as never)) as unknown as Body;
    merged = merged ? { ...merged, samples: [...(merged["samples"] as unknown[]), ...((page["samples"] as unknown[]) ?? [])], next_cursor: page["next_cursor"] } : page;
    const next = page["next_cursor"];
    if (typeof next !== "string" || !next) return merged;
    if (pages >= maxPages) {
      process.stderr.write(`warning: stopped after ${maxPages} pages (--max-pages); next_cursor resumes it.\n`);
      return merged;
    }
    params = { ...params, cursor: next };
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  }
}

async function runPreview(c: Curviate, f: CampaignFlags): Promise<void> {
  const params: Body = {};
  if (f.sample !== undefined) params["sample"] = intFlag("sample", f.sample, 1, 20);
  if (f.limit !== undefined) params["limit"] = intFlag("limit", f.limit, 1, 20);
  if (f.lead !== undefined) params["lead_ids"] = listFlag("lead", f.lead);
  if (params["sample"] !== undefined && params["limit"] !== undefined) usage("--sample is an alias of --limit: pass one.");
  if ((params["sample"] ?? params["limit"]) !== undefined && params["lead_ids"] !== undefined) usage("--limit and --lead cannot be combined: name the Leads, or let Curviate page.");
  if (f.all && params["lead_ids"] !== undefined) usage("--all pages over every Lead; with --lead there is one page.");
  rejectPaginationModifiersWithoutAll(f, process);
  const cursor = readCursorFlag(f, process);
  if (cursor) params["cursor"] = cursor;
  try {
    const result = f.all ? await previewAll(c, f, params) : await c.campaigns.preview(f.id ?? "", params as never);
    renderSuccess(readableObject(result), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

async function runPlacement(c: Curviate, f: CampaignFlags): Promise<void> {
  try {
    renderSuccess(await c.campaigns.placementChecks(f.id ?? ""), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

async function runCheck(c: Curviate, f: CampaignFlags): Promise<void> {
  if (f.preview) return preview("campaigns.check", { id: f.id });
  try {
    renderSuccess(await c.campaigns.check(f.id ?? ""), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

/** `add` and `remove`: Lead ids in chunks of BULK_MAX_IDS, in order. */
const membership = (kind: "add" | "remove") => async (c: Curviate, f: CampaignFlags): Promise<void> => {
  const ids = listFlag("lead", f.lead);
  if (!ids.length) usage("--lead is required: one or more Lead ids (con_...).");
  if (f.account !== undefined && f.account.trim() === "") usage("--account was given an empty value. Pass an acc_... id of the Campaign, or omit it to let Curviate assign one.");
  const body = (chunk: string[]) => ({ lead_ids: chunk, ...(f.account !== undefined ? { account_id: f.account } : {}) });
  const method = kind === "add" ? "addLeads" : "removeLeads";
  if (f.preview) return preview(`campaigns.${method}`, { id: f.id }, body(ids.slice(0, BULK_MAX_IDS)));
  const results = await sendInChunks(ids, BULK_MAX_IDS, (chunk) => c.campaigns[method](f.id ?? "", body(chunk) as never) as Promise<unknown>, f);
  if (results.length === 1) return renderSuccess(results[0], outputOpts(f), process);
  // Several chunks: one answer, every chunk's entries in input order.
  const last = (results[results.length - 1] ?? {}) as Body;
  const merged = kind === "add"
    ? { ...last, results: results.flatMap((r) => (r as { results?: unknown[] } | null)?.results ?? []) }
    : {
        ...last,
        removed: results.reduce<number>((n, r) => n + ((r as { removed?: number } | null)?.removed ?? 0), 0),
        not_found: results.flatMap((r) => (r as { not_found?: unknown[] } | null)?.not_found ?? []),
      };
  renderSuccess(merged, outputOpts(f), process);
};

/** `voice-clip upload <file>`: the file's bytes as the raw body (Content-Length set), one clip back. */
async function runVoiceClipUpload(c: Curviate, f: CampaignFlags): Promise<void> {
  const path = f.file ?? "";
  if (path.trim() === "") usage("the audio file is missing. Pass its path: `curviate campaign voice-clip upload intro.mp3`.");
  const filename = basename(path);
  let bytes: Buffer;
  try {
    bytes = await readAttachment(path);
  } catch (err) {
    if (err instanceof AttachError) usage(err.message);
    throw err;
  }
  if (f.preview) {
    return void process.stdout.write(JSON.stringify(buildPreviewOutput({ method: "campaigns.voiceClips.upload", args: { filename }, body: {}, attachments: [{ name: filename, buffer: bytes }] })) + "\n");
  }
  try {
    renderSuccess(await c.campaigns.voiceClips.upload(bytes, { filename }), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

/** `attachment upload <file>`: the file's bytes as the raw body (Content-Length set), one stored file back. */
async function runAttachmentUpload(c: Curviate, f: CampaignFlags): Promise<void> {
  const path = f.file ?? "";
  if (path.trim() === "") usage("the file is missing. Pass its path: `curviate campaign attachment upload pricing.pdf`.");
  const filename = basename(path);
  let bytes: Buffer;
  try {
    bytes = await readAttachment(path);
  } catch (err) {
    if (err instanceof AttachError) usage(err.message);
    throw err;
  }
  if (f.preview) {
    return void process.stdout.write(JSON.stringify(buildPreviewOutput({ method: "campaigns.attachments.upload", args: { filename }, body: {}, attachments: [{ name: filename, buffer: bytes }] })) + "\n");
  }
  try {
    renderSuccess(await c.campaigns.attachments.upload(bytes, { filename }), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

async function runAttachmentGet(c: Curviate, f: CampaignFlags): Promise<void> {
  try {
    renderSuccess(await c.campaigns.attachments.get(f.id ?? ""), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

async function runVoiceClipGet(c: Curviate, f: CampaignFlags): Promise<void> {
  try {
    renderSuccess(await c.campaigns.voiceClips.get(f.id ?? ""), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

/** `lint`: offline. A Campaign file's Sequence (under `/sequence`) or a bare Sequence document. */
export async function runLint(f: CampaignFlags): Promise<void> {
  const text = await readFileFlag("file", f.file ?? "", { others: f });
  const doc = parseDocument("file", text) as Body | null;
  const campaignFile = !!doc && typeof doc === "object" && !Array.isArray(doc) && !("steps" in doc) && ("sequence" in doc || "name" in doc);
  if (campaignFile) checkCampaignFields(f, "campaign create", doc); // the fields create refuses, lint refuses
  if (campaignFile && doc["sequence"] == null) usage("--file: the Campaign file has no sequence; there is nothing to lint.");
  const verdict = await checkSequence(f, text, campaignFile ? doc["sequence"] : doc, campaignFile ? "/sequence" : "", campaignFile ? doc["settings"] : undefined);
  if (outputOpts(f).json) process.stdout.write(JSON.stringify({ errors: [], warnings: verdict.warnings }) + "\n");
}

/** `init`: offline. A template as a Campaign file: `{name, sequence}` only; the server fills schedule and settings. */
export async function runInit(f: CampaignFlags): Promise<void> {
  const tpl = Object.prototype.hasOwnProperty.call(TEMPLATES, f.template ?? "") ? TEMPLATES[f.template!] : undefined;
  if (!tpl) usage(`--template takes one of ${Object.keys(TEMPLATES).join(", ")}.`);
  const { name, sequence } = tpl as { name: string; sequence: unknown }; // description is not a Campaign field
  const doc = { name, sequence: structuredClone(sequence) };
  const text = JSON.stringify(doc, null, 2) + "\n";
  if (f.output === undefined) return void process.stdout.write(text);
  try {
    await writeFile(f.output, text);
  } catch (err) {
    usage(`--output: cannot write ${f.output}: ${(err as NodeJS.ErrnoException).code ?? "write error"}.`);
  }
  process.stderr.write(`Wrote ${f.output}. Next: fill lead_list_ids and account_ids, then \`curviate campaign create --file ${f.output}\`.\n`);
}

// ---------------------------------------------------------------------------
// citty definitions
// ---------------------------------------------------------------------------

const online = (fn: (c: Curviate, f: CampaignFlags) => Promise<void>) => async ({ args }: { args: unknown }) => {
  const f = args as CampaignFlags;
  await fn(await rootClient(f), f);
};

const ID = { type: "positional" as const, description: "Campaign id (mot_...)." };
const FILE_DESC = "The Campaign file: a path, or - to read it from stdin. `curviate campaign get` output is accepted as is.";
const SEQUENCE_ERRORS = { SEQUENCE_INVALID: "the Sequence breaks a rule; every error is listed, one line each, as `curviate campaign lint` prints them." };
const ROLE_ERRORS = {
  INSUFFICIENT_ROLE: "your role cannot send from a sending Account of this Campaign.",
  ACCOUNT_NOT_SHARED: "a sending Account is not shared with you.",
};
const SEE_LIFECYCLE = ["curviate campaign get", "curviate enrollment list"];

const listCmd = defineCommand({
  meta: {
    name: "list",
    description:
      "List your Team's Campaigns, most recently updated first (--sort activity: latest activity first, `last_activity_at`). Items carry no Sequence: read one with `curviate campaign get <campaign_id>`. " +
      "A cursor belongs to its sort.",
    risk: "read",
    examples: ["curviate campaign list", "curviate campaign list --status active,paused", "curviate campaign list --accounts acc_A,acc_B --sort activity"],
  },
  args: {
    ...readOnly(GLOBAL_FLAGS),
    accounts: { type: "string", description: "Only Campaigns sending from one of these Accounts: a comma list of ids (acc_...). --account a,b is accepted as the same filter." },
    sort: { type: "string", description: "updated (default) or activity." },
    status: { type: "string", description: `Comma list of ${STATUSES.join(", ")}. Default: all but archived.` },
  },
  run: online(runList),
});

const getCmd = defineCommand({
  meta: {
    name: "get",
    description: "One Campaign with its current Sequence and lint warnings. With --version, that Sequence version instead, and how many Enrollments still run on it.",
    risk: "read",
    output: ["The full Campaign, pasteable: `curviate campaign create --file -` and `curviate campaign update <campaign_id> --file -` accept it as is, dropping the keys Curviate sets."],
    examples: ["curviate campaign get mot_YOUR_CAMPAIGN_ID", "curviate campaign get mot_YOUR_CAMPAIGN_ID --version 1"],
  },
  args: {
    ...readOnly(READ_SINGLE_FLAGS),
    id: ID,
    version: { type: "string", description: "A Sequence version number (1 or more)." },
  },
  run: online(runGet),
});

const CAMPAIGN_DOC = `{
  "name": "Q4 webinar follow-up",
  "lead_list_ids": ["cl_YOUR_LIST_ID"],
  "account_ids": ["acc_YOUR_ACCOUNT_ID"],
  "sequence": {
    "on_reply": "end",
    "steps": [
      { "id": "invite", "do": "invite.send", "with": { "note": null }, "next": "end" }
    ]
  }
}`;

const createCmd = defineCommand({
  meta: {
    name: "create",
    description: "Create a Campaign from a Campaign file, always as a draft: nothing runs until `curviate campaign start`. The file is checked before anything is sent, its Sequence as `curviate campaign lint` checks it. settings.priority (normal or prioritized) sets the Campaign's weight in each Account's budgets: 1 or 1.5, on every budget; every Campaign with work due still progresses and no limit is passed. Needs Automate.",
    risk: "write",
    rules: {
      changes: "Creates a draft Campaign. No Lead is enrolled and nothing reaches LinkedIn until it is started.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "A retry creates a second draft: list with `curviate campaign list --status draft` first.",
      undo: "`curviate campaign delete <campaign_id>` deletes a draft.",
    },
    errors: { ...SEQUENCE_ERRORS, ...ROLE_ERRORS, TIER_REQUIRED: "Campaigns need the Automate plan." },
    seeAlso: ["curviate campaign lint", "curviate campaign init", "curviate campaign preview"],
    document: "campaign create",
    examples: [
      "curviate campaign create --file campaign.json",
      `curviate campaign create --file - <<'EOF'\n${CAMPAIGN_DOC}\nEOF`,
    ],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    file: { type: "string", stdinArg: true, required: true, description: FILE_DESC },
  },
  run: online(runCreate),
});

const updateCmd = defineCommand({
  meta: {
    name: "update",
    description:
      "Change a Campaign from a Campaign file: objects (schedule, settings) merge by key, arrays and the Sequence replace whole, null clears. " +
      "settings.priority (normal or prioritized) weighs the Campaign 1 or 1.5 in each Account's budgets, on every budget (every Campaign with work due still progresses, and no limit is passed); settings.new_enrollments_per_account_per_day and settings.assign even are retired (accepted and ignored until 2027-01-28, with a notice). " +
      "--one-lead-per-company enrolls at most one Lead per company (a Lead whose company already has one in the Campaign is skipped, same_company, naming the Lead kept; one with no known company never is); --no-one-lead-per-company turns it off; either works with or without --file. " +
      "After start, a structural Sequence change makes a new version; running Enrollments keep theirs. With --if-revision the save is refused when someone saved the Sequence since. Needs Automate.",
    risk: "write",
    rules: {
      changes: "Changes the Campaign. A running Campaign picks the change up at each Enrollment's next Step.",
      visible_to: "Your Team, and the Leads its next Steps reach.",
      budget_rows: [],
      retry: "Safe: the same file sends the same change. Without --if-revision the last save wins.",
      undo: "Send the previous file again (`curviate campaign get <campaign_id> --version <n>` reads an earlier Sequence).",
    },
    errors: {
      ...SEQUENCE_ERRORS,
      SEQUENCE_CONFLICT: "with --if-revision: someone saved the Sequence since that revision; the message names the newer revision and who saved it.",
      CAMPAIGN_STATUS_CONFLICT: "an archived Campaign, or one past its end, cannot change.",
      ...ROLE_ERRORS,
    },
    seeAlso: ["curviate campaign get", "curviate campaign lint"],
    document: "campaign update",
    examples: [
      "curviate campaign update mot_YOUR_CAMPAIGN_ID --file campaign.json --if-revision 3",
      "curviate campaign update mot_YOUR_CAMPAIGN_ID --one-lead-per-company",
      `curviate campaign update mot_YOUR_CAMPAIGN_ID --file - <<'EOF'\n${CAMPAIGN_DOC}\nEOF`,
    ],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    id: ID,
    file: { type: "string", stdinArg: true, description: FILE_DESC },
    "one-lead-per-company": { type: "boolean", description: "Enroll at most one Lead per company (settings.one_lead_per_company); --no-one-lead-per-company turns it off." },
    "if-revision": { type: "string", description: "The sequence_revision you read (`curviate campaign get`). The save is refused with SEQUENCE_CONFLICT when the stored Sequence moved past it. Omitted: the last save wins." },
  },
  run: online(runUpdate),
});

const SKIP_MISSING_EMAIL = {
  "skip-missing-email": {
    type: "boolean" as const,
    description: "With an email step: start even though some Leads have no email address (`curviate campaign check` counts them). They are never enrolled either way.",
  },
};

const lifecycleCmd = (name: "start" | "pause" | "resume" | "archive" | "delete", meta: Record<string, unknown>) =>
  defineCommand({
    meta: {
      name,
      ...meta,
      examples: [`curviate campaign ${name} mot_YOUR_CAMPAIGN_ID`, ...(name === "start" ? ["curviate campaign start mot_YOUR_CAMPAIGN_ID --skip-missing-email"] : [])],
    },
    args: { ...WRITE_SINGLE_FLAGS, id: ID, ...(name === "start" || name === "resume" ? SKIP_MISSING_EMAIL : {}) },
    run: online(lifecycle(name)),
  });

const startCmd = lifecycleCmd("start", {
  description:
    "Start a draft: scheduled when its start time is ahead, else active. Freezes Sequence version 1. A Campaign missing what it needs is refused with every gap listed. " +
    "With an email step it needs `curviate campaign check` at the current Sequence revision, and is refused while Leads have no email address unless --skip-missing-email. Needs Automate.",
  risk: "high",
  rules: {
    changes: "The Campaign starts enrolling its Leads and running its Steps from its sending Accounts, paced on its schedule.",
    visible_to: "The Leads each Step reaches on LinkedIn.",
    budget_rows: [],
    retry: "A retry on a started Campaign answers CAMPAIGN_STATUS_CONFLICT; nothing runs twice.",
    undo: "`curviate campaign pause <campaign_id>` stops new Steps; what was sent stays sent.",
    blast_radius: "Every Lead of its Lead lists, from every sending Account, each Step spending that Account's budgets (`curviate account get <account_id>`).",
  },
  errors: {
    CAMPAIGN_NOT_STARTABLE: "a gap stops it (Lead list, sending Account, Sequence, with an email step the Lead check and Leads without an address); each is listed.",
    CAMPAIGN_STATUS_CONFLICT: "only a draft starts.",
    ...ROLE_ERRORS,
    TIER_REQUIRED: "Campaigns need the Automate plan.",
  },
  seeAlso: ["curviate campaign check", "curviate campaign preview", "curviate campaign pause"],
});

const pauseCmd = lifecycleCmd("pause", {
  description: "Pause an active or scheduled Campaign: no Step runs until it is resumed. Waits keep their time.",
  risk: "write",
  rules: {
    changes: "No Step of the Campaign runs while it is paused.",
    visible_to: "Your Team.",
    budget_rows: [],
    retry: "Safe: a paused Campaign answers CAMPAIGN_STATUS_CONFLICT.",
    undo: "`curviate campaign resume <campaign_id>`.",
  },
  errors: { CAMPAIGN_STATUS_CONFLICT: "only an active or scheduled Campaign pauses.", ...ROLE_ERRORS },
  seeAlso: SEE_LIFECYCLE,
});

const resumeCmd = lifecycleCmd("resume", {
  description: "Resume a paused Campaign. Runs the start checks again, the Lead check and --skip-missing-email included. Needs Automate.",
  risk: "high",
  rules: {
    changes: "The Campaign's Steps run again from its sending Accounts.",
    visible_to: "The Leads each Step reaches on LinkedIn.",
    budget_rows: [],
    retry: "A retry on a running Campaign answers CAMPAIGN_STATUS_CONFLICT.",
    undo: "`curviate campaign pause <campaign_id>`; what was sent stays sent.",
    blast_radius: "Every open Enrollment of the Campaign.",
  },
  errors: { CAMPAIGN_NOT_STARTABLE: "a gap stops it; each is listed.", CAMPAIGN_STATUS_CONFLICT: "only a paused Campaign resumes.", ...ROLE_ERRORS, TIER_REQUIRED: "Campaigns need the Automate plan." },
  seeAlso: SEE_LIFECYCLE,
});

const archiveCmd = lifecycleCmd("archive", {
  description: "Archive a Campaign: its open Enrollments end (campaign_archived) and it never runs again.",
  risk: "high",
  rules: {
    changes: "Ends every open Enrollment and freezes the Campaign.",
    visible_to: "Your Team.",
    budget_rows: [],
    retry: "A retry answers CAMPAIGN_STATUS_CONFLICT.",
    undo: "Cannot be undone. Create a new Campaign from `curviate campaign get <campaign_id>` output.",
    blast_radius: "Every open Enrollment of the Campaign.",
  },
  errors: { CAMPAIGN_STATUS_CONFLICT: "already archived.", ...ROLE_ERRORS },
  seeAlso: SEE_LIFECYCLE,
});

const deleteCmd = lifecycleCmd("delete", {
  description: "Delete a draft Campaign with its Sequence versions. Any other status: archive it instead.",
  risk: "high",
  rules: {
    changes: "Deletes the draft and its Sequence versions.",
    visible_to: "Your Team.",
    budget_rows: [],
    retry: "A retry answers RESOURCE_NOT_FOUND.",
    undo: "Cannot be undone. Keep `curviate campaign get <campaign_id>` output to create it again.",
    blast_radius: "One draft Campaign; it has no Enrollments.",
  },
  errors: { RESOURCE_NOT_FOUND: "no Campaign with this id.", CAMPAIGN_STATUS_CONFLICT: "only a draft is deleted; archive the others.", ...ROLE_ERRORS },
  seeAlso: ["curviate campaign archive", "curviate campaign list"],
});

const previewCmd = defineCommand({
  meta: {
    name: "preview",
    description:
      "What the Campaign would do, in any status: every path through its Sequence, rendered messages for its Leads a page at a time (--limit, 1 to 20, default 5; --cursor the previous page's next_cursor; --all every page, merged) or for named Leads, and the budget projection on the first page: per Account the pool that binds its pace, the expected actions a day (a draft: the mean daily invitations, messages and InMails of the first 7 days of its forecast, as if turned on now), and warnings (hours_below_share, no_sending_account). A read: never reaches LinkedIn, spends nothing.",
    risk: "read",
    examples: [
      "curviate campaign preview mot_YOUR_CAMPAIGN_ID",
      "curviate campaign preview mot_YOUR_CAMPAIGN_ID --limit 3",
      "curviate campaign preview mot_YOUR_CAMPAIGN_ID --all",
    ],
  },
  args: {
    ...readOnly(GLOBAL_FLAGS),
    id: ID,
    sample: { type: "string", description: "Alias of --limit." },
    lead: { type: "string", description: "A Lead id (con_...) to render; repeatable, or a comma list. Not with --limit or --all." },
  },
  run: online(runPreview),
});

const checkCmd = defineCommand({
  meta: {
    name: "check",
    description:
      "Run the Lead check: one count over every Lead the Campaign would enroll (no usable email address, a bounced one, on the Do-not-contact list for email only) and the Lead variables without a fallback they lack. Stored as lead_check on the Campaign; starting a Campaign with an email step needs one at the current Sequence revision. Any status; sends nothing.",
    risk: "write",
    rules: {
      changes: "Stores the check as the Campaign's lead_check, replacing the previous one. Nothing is sent.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "Safe: a retry runs the check again.",
      undo: "Not needed: it changes no Lead and no Step.",
    },
    output: ["The check: leads, without_email, email_bounced, no_email, fields[] (variable, steps, on_missing, missing), checked_at, sequence_revision."],
    seeAlso: ["curviate campaign start", "curviate campaign preview"],
    examples: ["curviate campaign check mot_YOUR_CAMPAIGN_ID"],
  },
  args: { ...WRITE_SINGLE_FLAGS, id: ID },
  run: online(runCheck),
});

const placementCmd = defineCommand({
  meta: {
    name: "placement",
    description:
      "The Campaign's weekly placement checks, newest first, at most 26: each calendar week its first email step, and each email step whose text changed that week, goes from one of its Mailboxes to test inboxes and is read like a placement test (`curviate mailbox test`). " +
      "Each check: week (its Monday), mailbox_id, step_id, status (running, complete, waiting, skipped), reason (no_mailbox, cap, seeds) and the google_workspace and microsoft_365 verdicts (inbox, partly_spam, spam) once complete. Every role reads. One API call.",
    risk: "read",
    output: ["The checks: items[] (week, mailbox_id, step_id, status, reason, google_workspace, microsoft_365)."],
    seeAlso: ["curviate mailbox test", "curviate analytics email"],
    examples: ["curviate campaign placement mot_YOUR_CAMPAIGN_ID"],
  },
  args: { ...readOnly(READ_SINGLE_FLAGS), id: ID },
  run: online(runPlacement),
});

const membershipCmd = (kind: "add" | "remove") =>
  defineCommand({
    meta: {
      name: kind,
      description: kind === "add"
        ? "Enroll Leads directly, on an Account of the Campaign (--account) or one Curviate assigns. Every exclusion and filter applies; each Lead's outcome says what happened. Sent in requests of up to 1000 ids, in order. Needs Automate."
        : "Take Leads out of the Campaign: their open Enrollments end (removed). Sent in requests of up to 1000 ids, in order.",
      risk: "high",
      rules: kind === "add"
        ? {
            changes: "Each queued Lead becomes a pending Enrollment; a running Campaign reaches it on its schedule.",
            visible_to: "Your Team now; the Leads once their Steps run.",
            budget_rows: [],
            retry: "Safe: a Lead already in the Campaign answers already_enrolled. After a failed request, send the ids from the failed one on.",
            undo: "`curviate campaign remove <campaign_id> --lead <lead_id>`; what was sent stays sent.",
            blast_radius: "Every Lead given.",
          }
        : {
            changes: "Ends each named Lead's open Enrollments in the Campaign (removed).",
            visible_to: "Your Team.",
            budget_rows: [],
            retry: "Safe: a Lead no longer in the Campaign is listed in not_found.",
            undo: "`curviate campaign add <campaign_id> --lead <lead_id>` enrolls it again.",
            blast_radius: "Every Lead given.",
          },
      errors: { CAMPAIGN_STATUS_CONFLICT: "an archived Campaign, or one past its end, takes no Leads.", ...ROLE_ERRORS },
      seeAlso: ["curviate enrollment list"],
      examples: kind === "add"
        ? ["curviate campaign add mot_YOUR_CAMPAIGN_ID --lead con_YOUR_LEAD_ID", "curviate campaign add mot_YOUR_CAMPAIGN_ID --lead con_A,con_B --account acc_YOUR_ACCOUNT_ID"]
        : ["curviate campaign remove mot_YOUR_CAMPAIGN_ID --lead con_YOUR_LEAD_ID"],
    },
    args: {
      ...WRITE_SINGLE_FLAGS,
      id: ID,
      lead: { type: "string", required: true, description: "A Lead id (con_...); repeatable, or a comma list." },
      ...(kind === "add" ? { account: { type: "string" as const, description: "Enroll them on this sending Account of the Campaign (acc_...). Never defaulted: omit it and Curviate assigns one." } } : {}),
    },
    run: online(membership(kind)),
  });

const OFFLINE = { notes: ["Offline: no API call."] };

const lintCmd = defineCommand({
  meta: {
    name: "lint",
    description:
      "Check a Sequence offline with the rules the API applies: a Campaign file (its sequence) or a bare Sequence document. One line per finding, `<file>:<line>:<col> error|warning <code> <path>: <message>. <hint> -> <docs_url>`; exit 2 on any error, 0 otherwise.",
    risk: "read",
    rules: OFFLINE,
    output: ["Findings on stderr. With --json (or piped), stdout carries `{errors, warnings}`, or on errors the SEQUENCE_INVALID refusal the API would send."],
    examples: ["curviate campaign lint --file campaign.json"],
  },
  args: {
    json: GLOBAL_FLAGS.json,
    file: { type: "string", stdinArg: true, required: true, description: "A Campaign file or a Sequence document: a path, or - to read it from stdin." },
  },
  async run({ args }) {
    await runLint(args as CampaignFlags);
  },
});

const initCmd = defineCommand({
  meta: {
    name: "init",
    description: `Write a Campaign file from a template (${Object.keys(TEMPLATES).join(", ")}). Fill lead_list_ids and account_ids, then create it.`,
    risk: "read",
    rules: OFFLINE,
    output: ["The Campaign file on stdout, or in the --output file."],
    examples: ["curviate campaign init --template connect-and-converse --output campaign.json"],
  },
  args: {
    template: { type: "string", required: true, description: `One of ${Object.keys(TEMPLATES).join(", ")}.` },
    output: { type: "string", alias: "o", description: "Write to this path, replacing what is there. Omitted: stdout." },
  },
  async run({ args }) {
    await runInit(args as CampaignFlags);
  },
});

const voiceClipUploadCmd = defineCommand({
  meta: {
    name: "upload",
    description:
      "Upload one audio file (MP3, WAV, M4A, WebM or Ogg) and print the clip: its `id` (vc_...) is the `clip_id` of a `voice.send` step. 1 to 120 seconds, up to 20 MiB, 100 uploads per Team per 24 hours. " +
      "The file is converted once and the original is discarded. Nothing reaches LinkedIn. Needs Automate.",
    risk: "write",
    rules: {
      changes: "Stores one converted clip for your Team. No Campaign changes and nothing is sent to anyone.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "A retry stores a second clip (it counts toward the 24-hour cap); an unused clip is deleted 30 days after its upload.",
      undo: "Not needed: a clip no Sequence uses is deleted after 30 days.",
    },
    output: ["The clip: `id`, `duration_ms`, `bytes`, `filename`, `created_at`. No download link."],
    errors: {
      VOICE_CLIP_INVALID: "the file is empty, is not audio, cannot be decoded, is under 1 second or is over 120 seconds; the message names the reason. A clip is never shortened.",
      PAYLOAD_TOO_LARGE: "the file is over 20 MiB.",
      RATE_LIMIT_TENANT: "100 uploads in the last 24 hours; Retry-After is the wait.",
      TIER_REQUIRED: "Voice clips need the Automate plan.",
      ...ROLE_ERRORS,
    },
    seeAlso: ["curviate campaign voice-clip get", "curviate campaign lint", "curviate campaign create"],
    examples: ["curviate campaign voice-clip upload intro.mp3", "curviate campaign voice-clip upload intro.m4a --preview"],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    file: { type: "positional", required: true, description: "The audio file's path." },
  },
  run: online(runVoiceClipUpload),
});

const voiceClipGetCmd = defineCommand({
  meta: {
    name: "get",
    description: "One Voice clip: duration, size, file name and upload time. No download link. Another Team's clip is RESOURCE_NOT_FOUND, like an unknown id.",
    risk: "read",
    examples: ["curviate campaign voice-clip get vc_YOUR_CLIP_ID"],
  },
  args: {
    ...readOnly(READ_SINGLE_FLAGS),
    id: { type: "positional", description: "Voice clip id (vc_...)." },
  },
  run: online(runVoiceClipGet),
});

const voiceClipCommand = defineCommand({
  meta: { name: "voice-clip", description: DESCRIPTIONS.campaignVoiceClip },
  subCommands: { upload: voiceClipUploadCmd, get: voiceClipGetCmd },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(voiceClipCommand, ["curviate", "campaign", "voice-clip"]);
  },
});

const attachmentUploadCmd = defineCommand({
  meta: {
    name: "upload",
    description:
      "Upload one file and print it: its `id` (cat_...) goes in an email step's `attachment_ids` (at most 10 a step, 20 MiB in total). Up to 20 MiB, 100 uploads per Team per 24 hours. " +
      "Curviate reads the type from the file's bytes; executables, scripts, installers and macro-enabled Office files are refused. A link usually lands better than a file. Nothing is sent. Needs Automate.",
    risk: "write",
    rules: {
      changes: "Stores one file for your Team. No Campaign changes and nothing is sent to anyone.",
      visible_to: "Your Team; the recipients of the emails whose step names it.",
      budget_rows: [],
      retry: "A retry stores a second file (it counts toward the 24-hour cap); a file no Sequence uses is deleted 30 days after its upload.",
      undo: "Not needed: a file no Sequence uses is deleted after 30 days.",
    },
    output: ["The file: `id`, `filename`, `content_type`, `bytes`, `created_at`. No download link."],
    errors: {
      UNSUPPORTED_MEDIA_TYPE: "an executable, a script, an installer, a shortcut, a disk image or a macro-enabled Office file; the message names the type. Nothing is stored.",
      PAYLOAD_TOO_LARGE: "the file is over 20 MiB.",
      RATE_LIMIT_TENANT: "100 uploads in the last 24 hours; Retry-After is the wait.",
      TIER_REQUIRED: "Campaign attachments need the Automate plan.",
      ...ROLE_ERRORS,
    },
    seeAlso: ["curviate campaign attachment get", "curviate campaign lint", "curviate campaign check"],
    examples: ["curviate campaign attachment upload pricing.pdf", "curviate campaign attachment upload deck.pdf --preview"],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    file: { type: "positional", required: true, description: "The file's path." },
  },
  run: online(runAttachmentUpload),
});

const attachmentGetCmd = defineCommand({
  meta: {
    name: "get",
    description: "One Campaign attachment: file name, type, size and upload time. No download link. Another Team's file is RESOURCE_NOT_FOUND, like an unknown id.",
    risk: "read",
    examples: ["curviate campaign attachment get cat_YOUR_ATTACHMENT_ID"],
  },
  args: {
    ...readOnly(READ_SINGLE_FLAGS),
    id: { type: "positional", description: "Attachment id (cat_...)." },
  },
  run: online(runAttachmentGet),
});

const attachmentCommand = defineCommand({
  meta: { name: "attachment", description: DESCRIPTIONS.campaignAttachment },
  subCommands: { upload: attachmentUploadCmd, get: attachmentGetCmd },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(attachmentCommand, ["curviate", "campaign", "attachment"]);
  },
});

export const campaignCommand = defineCommand({
  meta: { name: "campaign", description: DESCRIPTIONS.campaign },
  subCommands: {
    list: listCmd,
    get: getCmd,
    create: createCmd,
    update: updateCmd,
    start: startCmd,
    pause: pauseCmd,
    resume: resumeCmd,
    archive: archiveCmd,
    delete: deleteCmd,
    preview: previewCmd,
    check: checkCmd,
    placement: placementCmd,
    add: membershipCmd("add"),
    remove: membershipCmd("remove"),
    lint: lintCmd,
    init: initCmd,
    "voice-clip": voiceClipCommand,
    attachment: attachmentCommand,
  },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(campaignCommand, ["curviate", "campaign"]);
  },
});
