/**
 * `curviate do-not-contact`: your Team's one list of people no Campaign contacts
 * and no write reaches. Root-scoped (`curviate.doNotContact.*`).
 */
import { defineCommand } from "citty";
import type { Curviate } from "@curviate/sdk";
import { DESCRIPTIONS } from "./descriptions.js";
import { GLOBAL_FLAGS, READ_SINGLE_FLAGS, WRITE_SINGLE_FLAGS, readOnly } from "../lib/global-flags.js";
import { renderSuccess, writeNdjsonItem } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { streamAll, pageDelayFromFlags, readCursorFlag, readMaxPagesFlag, readableObject, readablePage, rejectPaginationModifiersWithoutAll } from "../lib/paginate.js";
import { intFlag } from "../lib/int-flag.js";
import { fail, outputOpts, rootClient, usage, type RootFlags } from "../lib/root-command.js";
import { readFileFlag } from "../lib/document.js";
import { isStdinToken } from "../lib/stdin.js";
import { sendChunked } from "../lib/chunks.js";
import { writeAtomic } from "../lib/write-atomic.js";
import { downloadBinary } from "../lib/client.js";
import { chunkRows, csvRecords } from "./contact-import.js";

type Flags = RootFlags & {
  id?: string;
  lead?: string;
  "linkedin-url"?: string;
  company?: string;
  reason?: string;
  scope?: string;
  query?: string;
  limit?: string;
  cursor?: string;
  all?: boolean;
  "max-pages"?: string;
  "page-delay"?: string;
  file?: string;
  format?: string;
  output?: string;
};
type Body = Record<string, unknown>;

const REASONS = ["asked_to_stop", "existing_customer", "competitor", "partner", "employee", "unsubscribed", "other"];
const SCOPES = ["everything", "email_only"];

const online = (fn: (c: Curviate, f: Flags) => Promise<void>) => async ({ args }: { args: unknown }) => {
  const f = args as Flags;
  await fn(await rootClient(f), f);
};

const preview = (method: string, args: Body, body: Body = {}) =>
  void process.stdout.write(JSON.stringify(buildPreviewOutput({ method, args, body })) + "\n");

const scope = (f: Flags): string | undefined => {
  if (f.scope === undefined) return undefined;
  if (!SCOPES.includes(f.scope)) usage(`--scope takes everything or email_only (got ${JSON.stringify(f.scope)}).`);
  return f.scope;
};

const reason = (f: Flags, requiredFlag: boolean): string | undefined => {
  if (f.reason === undefined) return requiredFlag ? usage(`--reason is required: one of ${REASONS.join(", ")}.`) : undefined;
  if (!REASONS.includes(f.reason)) usage(`--reason takes one of ${REASONS.join(", ")}.`);
  return f.reason;
};

async function runList(c: Curviate, f: Flags): Promise<void> {
  rejectPaginationModifiersWithoutAll(f, process);
  const params: Body = {};
  if (f.query !== undefined) {
    if (f.query.trim() === "") usage("--query was given an empty value.");
    params["q"] = f.query;
  }
  if (f.limit !== undefined) params["limit"] = intFlag("limit", f.limit, 1, 100);
  const cursor = readCursorFlag(f, process);
  if (cursor) params["cursor"] = cursor;
  try {
    if (f.all) {
      const page = (p: Body) => c.doNotContact.list(p as never) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(page, params, { maxPages: readMaxPagesFlag(f, process), out: process, pageDelayMs: pageDelayFromFlags(f) })) writeNdjsonItem(process, item, f.fields);
    } else {
      renderSuccess(readablePage(await c.doNotContact.list(params as never)), outputOpts(f), process);
    }
  } catch (err) {
    await fail(err, f);
  }
}

async function runGet(c: Curviate, f: Flags): Promise<void> {
  try {
    renderSuccess(readableObject(await c.doNotContact.get(String(f.id ?? ""))), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

async function runAdd(c: Curviate, f: Flags): Promise<void> {
  const named = [f.lead, f["linkedin-url"], f.company].filter((v) => v !== undefined).length;
  if (named !== 1) usage("name exactly one of --lead (con_...), --linkedin-url (a person) or --company (a company's LinkedIn URL).");
  for (const [flag, v] of [["lead", f.lead], ["linkedin-url", f["linkedin-url"]], ["company", f.company]] as const) if (v !== undefined && v.trim() === "") usage(`--${flag} was given an empty value.`);
  const body: Body = f.lead !== undefined ? { lead_id: f.lead } : f.company !== undefined ? { company_linkedin_url: f.company } : { linkedin_url: f["linkedin-url"] };
  const why = reason(f, false);
  if (why) body["reason"] = why;
  const what = scope(f);
  if (what) body["scope"] = what;
  if (f.preview) return preview("doNotContact.add", {}, body);
  try {
    renderSuccess(readableObject(await c.doNotContact.add(body as never)), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

async function runUpdate(c: Curviate, f: Flags): Promise<void> {
  const body = { reason: reason(f, true) };
  if (f.preview) return preview("doNotContact.update", { id: f.id }, body);
  try {
    renderSuccess(readableObject(await c.doNotContact.update(String(f.id ?? ""), body as never)), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

async function runRemove(c: Curviate, f: Flags): Promise<void> {
  if (f.preview) return preview("doNotContact.remove", { id: f.id });
  try {
    await c.doNotContact.remove(String(f.id ?? ""));
    renderSuccess({}, outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

const FORMATS = ["csv", "json", "ndjson"];
const EXT: Record<string, string> = { ".csv": "csv", ".json": "json", ".ndjson": "ndjson", ".jsonl": "ndjson" };
/** The operation's published `x-curviate-limits.rows`; the server refuses more (413). */
const IMPORT_MAX_ROWS = 10_000;

async function runExport(c: Curviate, f: Flags): Promise<void> {
  if (f.json) usage("export takes no --json: its data is the file. Use --format json for JSON.");
  const format = f.format ?? "ndjson";
  if (!FORMATS.includes(format)) usage(`--format takes one of ${FORMATS.join(", ")}.`);
  const params: Body = { format };
  if (f.preview) return preview("doNotContact.export", {}, params);
  let bytes: Buffer;
  try {
    const got = await downloadBinary(() => c.doNotContact.export(params as never));
    bytes = got instanceof ArrayBuffer ? Buffer.from(got) : Buffer.from(JSON.stringify(got) + "\n");
  } catch (err) {
    return fail(err, f);
  }
  // The whole answer is in hand before a byte is written: an error never lands in the data stream or over a good file.
  if (f.output === undefined || f.output === "-") process.stdout.write(bytes);
  else {
    try {
      writeAtomic(f.output, bytes);
    } catch (err) {
      usage(`--output: cannot write ${f.output}: ${(err as NodeJS.ErrnoException).code ?? "write error"}.`);
    }
  }
  const lines = bytes.toString("utf8").split("\n").filter((l) => l !== "").length;
  process.stderr.write(`Exported ${format === "json" ? "" : `${format === "csv" ? Math.max(0, lines - 1) : lines} `}entries as ${format}${f.output && f.output !== "-" ? ` to ${f.output}` : ""}.\n`);
}

type Reported = { row: number; outcome: string; skip_reason?: string | null; field?: string | null };
type Imported = { counts?: Record<string, number>; report?: Reported[] };
const COUNTS = ["created", "unchanged", "skipped"];

async function runImport(c: Curviate, f: Flags): Promise<void> {
  const file = f.file;
  if (file === undefined || file.trim() === "") usage("--file is required: a CSV, JSON or NDJSON file, or - for stdin.");
  const dash = isStdinToken(file);
  let format = f.format;
  if (format === undefined) {
    format = dash ? undefined : EXT[(/\.[^./\\]+$/.exec(file.toLowerCase()) ?? [""])[0]];
    if (format === undefined) usage(dash ? "--format is required with --file -: csv, json or ndjson." : "--format could not be told from the file name: pass csv, json or ndjson.");
  }
  if (!FORMATS.includes(format)) usage(`--format takes one of ${FORMATS.join(", ")}.`);
  const what = scope(f);
  // Structure first, nothing sent on a refusal.
  const text = await readFileFlag("file", file, { allowBom: true, maxBytes: 64 * 1024 * 1024, others: f as Record<string, unknown> });
  let header: string | undefined;
  let rows: unknown[];
  if (format === "csv") {
    const [head, ...rest] = csvRecords(text);
    if (head === undefined) usage("--file: the CSV has no header row.");
    if (rest.length === 0) usage("--file: the CSV has a header and no rows to import.");
    header = head;
    rows = rest;
  } else if (format === "json") {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      usage("--file: not valid JSON.");
    }
    if (!Array.isArray(doc)) usage("--file: a JSON import is an array of objects, one per person.");
    rows = doc;
  } else {
    rows = text.split("\n").flatMap((line, i) => (line.trim() === "" ? [] : [(() => { try { return JSON.parse(line) as unknown; } catch { return usage(`--file: line ${i + 1} is not valid JSON.`); } })()]));
  }
  if (rows.length === 0) usage("--file: no rows to import.");
  const bad = header === undefined ? rows.findIndex((o) => o === null || typeof o !== "object" || Array.isArray(o)) : -1;
  if (bad >= 0) usage(`--file: row ${bad + 1} is not an object.`);
  // --scope: the scope of every row that names none.
  if (what !== undefined && header !== undefined) {
    if (header.split(",").some((h) => h.trim().replace(/^"|"$/g, "").toLowerCase() === "scope")) usage("--scope: the file has a scope column; set it there, or drop the column.");
    header = `${header},scope`;
    rows = rows.map((r) => `${r as string},${what}`);
  } else if (what !== undefined) {
    rows = rows.map((r) => ("scope" in (r as Body) ? r : { ...(r as Body), scope: what }));
  }
  const chunks = chunkRows(rows, (r) => Buffer.byteLength(typeof r === "string" ? r : JSON.stringify(r)) + 1, IMPORT_MAX_ROWS);
  const bodyOf = (part: unknown[]): Body => (header !== undefined ? { csv: [header, ...part].join("\n") } : { rows: part });
  if (f.preview) return preview("doNotContact.import", chunks.length > 1 ? { requests: chunks.length, rows: rows.length } : {}, bodyOf(chunks[0]!));

  const done: Imported[] = [];
  const offsets: number[] = [];
  let at = 0;
  // Each request is sent before the next: a refusal stops the run before any later chunk.
  await sendChunked(
    chunks,
    async (part) => {
      const got = readableObject(await c.doNotContact.import(bodyOf(part) as never)) as Imported;
      offsets.push(at);
      at += part.length;
      done.push(got);
      return got;
    },
    f,
    "rows",
  );
  const counts = Object.fromEntries(COUNTS.map((k) => [k, done.reduce((n, i) => n + (i.counts?.[k] ?? 0), 0)]));
  const skipped = done.flatMap((imp, k) =>
    (imp.report ?? []).filter((r) => r.outcome === "skipped").map((r) => ({ row: offsets[k]! + r.row, reason: r.skip_reason ?? null, field: r.field ?? null })),
  );
  renderSuccess({ total_rows: rows.length, counts, skipped }, outputOpts(f), process);
}

const ID = { type: "positional" as const, description: "Entry id (dnc_...), from `curviate do-not-contact list`." };
const REASON_ARG = { type: "string" as const, description: `Why: ${REASONS.join(" | ")}.` };
const SCOPE_ARG = {
  type: "string" as const,
  description: "What the entry stops: everything (default) or email_only (No email: email steps skip the person; LinkedIn Campaigns and writes still reach them).",
};

const listCmd = defineCommand({
  meta: {
    name: "list",
    description:
      "List your Team's do-not-contact list, newest first. No Campaign contacts a person on it and writes toward them are refused (exit 10); a reply in a conversation they wrote in stays allowed. " +
      "An entry whose Lead was deleted still applies.",
    risk: "read",
    examples: ["curviate do-not-contact list", "curviate do-not-contact list --query jane"],
  },
  args: { ...readOnly(GLOBAL_FLAGS), limit: { ...GLOBAL_FLAGS.limit, description: "Entries per page (1 to 100). The API returns no total: count with --all." }, query: { type: "string", description: "Only entries whose Lead name matches this text." } },
  run: online(runList),
});

const getCmd = defineCommand({
  meta: { name: "get", description: "One do-not-contact entry: the person, the reason, the scope (everything or email_only), how it was added and by whom.", risk: "read", examples: ["curviate do-not-contact get dnc_YOUR_ENTRY_ID"] },
  args: { ...readOnly(READ_SINGLE_FLAGS), id: ID },
  run: online(runGet),
});

const addCmd = defineCommand({
  meta: {
    name: "add",
    description:
      "Put one person on the list, by Lead id or LinkedIn URL (a URL of someone who is not a Lead yet creates the Lead from stored data), or a whole company with --company (its LinkedIn URL with the numeric id, as a Lead's company_linkedin_url): nobody who works there is contacted or imported. " +
      "No Campaign contacts them afterwards and writes toward them are refused; with --scope email_only only email stops (No email). " +
      "One person per call; for many, `do-not-contact import`. Any member may add. Needs Automate.",
    risk: "write",
    rules: {
      changes: "The person joins the list; Campaigns skip them and writes toward them are refused.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "Safe: a person already on the list answers with their existing entry.",
      undo: "`curviate do-not-contact remove <id>` (Owners and Managers).",
    },
    errors: { TIER_REQUIRED: "your plan does not include Do-not-contact writes (Automate).", RESOURCE_NOT_FOUND: "no Lead has this id." },
    seeAlso: ["curviate do-not-contact list", "curviate do-not-contact import"],
    examples: [
      "curviate do-not-contact add --lead con_YOUR_LEAD_ID --reason asked_to_stop",
      "curviate do-not-contact add --lead con_YOUR_LEAD_ID --scope email_only",
      "curviate do-not-contact add --company https://www.linkedin.com/company/1234567/",
    ],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    lead: { type: "string", description: "The Lead (con_...). Not with --linkedin-url." },
    "linkedin-url": { type: "string", description: "The person's LinkedIn profile URL, in any spelling. Not with --lead." },
    company: { type: "string", description: "A company instead of a person: its LinkedIn URL with the numeric id (linkedin.com/company/<id>/). Nobody who works there is contacted or imported." },
    reason: REASON_ARG,
    scope: SCOPE_ARG,
  },
  run: online(runAdd),
});

const updateCmd = defineCommand({
  meta: {
    name: "update",
    description: "Change the reason on an entry. Needs Automate.",
    risk: "write",
    rules: {
      changes: "The entry's reason.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "Safe: the same call leaves the same reason.",
      undo: "Update again with the old reason.",
    },
    errors: { TIER_REQUIRED: "your plan does not include Do-not-contact writes (Automate).", RESOURCE_NOT_FOUND: "no such entry." },
    examples: ["curviate do-not-contact update dnc_YOUR_ENTRY_ID --reason existing_customer"],
  },
  args: { ...WRITE_SINGLE_FLAGS, id: ID, reason: { ...REASON_ARG, required: true } },
  run: online(runUpdate),
});

const removeCmd = defineCommand({
  meta: {
    name: "remove",
    description: "Take a person off the list: Campaigns and writes may reach them again. Owners and Managers only.",
    risk: "high",
    rules: {
      changes: "The entry is deleted; Campaigns may enroll the person and writes toward them are allowed again.",
      visible_to: "The person, if a Campaign or write then reaches them on LinkedIn.",
      budget_rows: [],
      retry: "Safe: a second call answers RESOURCE_NOT_FOUND.",
      undo: "`curviate do-not-contact add` again.",
      blast_radius: "One person.",
    },
    errors: { INSUFFICIENT_ROLE: "removing is for Owners and Managers.", RESOURCE_NOT_FOUND: "no such entry (already removed)." },
    seeAlso: ["curviate do-not-contact list", "curviate do-not-contact add"],
    examples: ["curviate do-not-contact remove dnc_YOUR_ENTRY_ID"],
  },
  args: { ...WRITE_SINGLE_FLAGS, id: ID },
  run: online(runRemove),
});

const exportCmd = defineCommand({
  meta: {
    name: "export",
    description:
      "Download your Team's whole do-not-contact list as csv, json or ndjson (default): LinkedIn URL (empty once the Lead was deleted), reason, who added it, when. The file imports as it is. " +
      "The data goes to stdout or --output and nothing else does; the count goes to stderr. --output is written whole or not at all, with mode 0600. Owners and Managers only.",
    risk: "read",
    output: ["The data only. No --json: use --format json."],
    errors: { INSUFFICIENT_ROLE: "exporting is for Owners and Managers." },
    seeAlso: ["curviate do-not-contact import"],
    examples: ["curviate do-not-contact export --format csv --output do-not-contact.csv", "curviate do-not-contact export --format json"],
  },
  args: {
    "api-key": GLOBAL_FLAGS["api-key"],
    profile: GLOBAL_FLAGS.profile,
    team: GLOBAL_FLAGS.team,
    "base-url": GLOBAL_FLAGS["base-url"],
    timeout: GLOBAL_FLAGS.timeout,
    json: { type: "boolean", description: "Not accepted: an export's data is the file. Use --format json." },
    format: { type: "string", description: "csv | json | ndjson (default ndjson)." },
    output: { type: "string", alias: "o", description: "Write to this path (0600, replaced whole on success) or - for stdout (default)." },
  },
  run: online(runExport),
});

const importCmd = defineCommand({
  meta: {
    name: "import",
    description:
      "Put the people of a CSV, JSON or NDJSON file on the list: a linkedin_url per row and an optional reason (a do-not-contact export works as it is). Each row works as `add`: " +
      "someone who is not a Lead yet becomes one from stored data, and a person already listed is reported unchanged and keeps their reason. A bad URL or reason skips its row and the server says why. " +
      "A file over 10,000 rows is sent in several requests. Any member may import. Needs Automate.",
    risk: "write",
    rules: {
      changes: "The people join the list; Campaigns skip them and writes toward them are refused. Nothing is sent to LinkedIn or to the people.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "Safe to repeat: a person already listed is reported unchanged. A run stopped part way: run it again.",
      undo: "`curviate do-not-contact remove <id>` per person (Owners and Managers).",
    },
    errors: { TIER_REQUIRED: "your plan does not include Do-not-contact writes (Automate).", LEAD_LIMIT_REACHED: "the Team is at its Lead cap; rows that would add a Lead past it are skipped." },
    output: ["One report: `total_rows`, summed `counts` (created, unchanged, skipped) and `skipped` rows with their number in the file, a reason and the field."],
    seeAlso: ["curviate do-not-contact export", "curviate do-not-contact list"],
    examples: ["curviate do-not-contact import --file do-not-contact.csv", "curviate do-not-contact import --file - --format ndjson"],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    file: { type: "string", stdinArg: true, required: true, description: "The file: a path, or - to read it from stdin (then --format is required)." },
    format: { type: "string", description: "csv | json | ndjson. Default: from the file extension (.csv, .json, .ndjson)." },
    scope: { ...SCOPE_ARG, description: "The scope of every row that names none: everything (default) or email_only." },
  },
  run: online(runImport),
});

export const doNotContactCommand = defineCommand({
  meta: { name: "do-not-contact", description: DESCRIPTIONS["do-not-contact"] },
  subCommands: { list: listCmd, get: getCmd, add: addCmd, update: updateCmd, remove: removeCmd, export: exportCmd, import: importCmd },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(doNotContactCommand, ["curviate", "do-not-contact"]);
  },
});
