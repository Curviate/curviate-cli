/**
 * `curviate contact import` and `curviate contact imports`.
 *
 * `import --file` reads a CSV, JSON (an array of objects) or NDJSON file,
 * checks only its structure locally, and sends it in imports of at most
 * IMPORT_MAX_ROWS rows and IMPORT_MAX_BODY_BYTES bytes (a CSV's header is
 * repeated in each), one after the other, each awaited unless --no-wait. It
 * stops at the first refused or failed import and prints one aggregated
 * report. Bad values are the server's to skip and report per row.
 */
import { defineCommand } from "citty";
import { setTimeout as sleep } from "node:timers/promises";
import type { Curviate } from "@curviate/sdk";
import { GLOBAL_FLAGS, READ_SINGLE_FLAGS, WRITE_SINGLE_FLAGS, readOnly } from "../lib/global-flags.js";
import { renderSuccess, writeNdjsonItem } from "../lib/output.js";
import { readFileFlag } from "../lib/document.js";
import { isStdinToken } from "../lib/stdin.js";
import { streamAll, pageDelayFromFlags, readCursorFlag, readMaxPagesFlag, readableObject, readablePage, rejectPaginationModifiersWithoutAll } from "../lib/paginate.js";
import { intFlag } from "../lib/int-flag.js";
import { sendChunked } from "../lib/chunks.js";
import { fail, listFlag, outputOpts, usage } from "../lib/root-command.js";
import { online, preview, type ContactFlags } from "./contact.js";

/** The operation's published `x-curviate-limits`: rows per import, and the request body in bytes. */
export const IMPORT_MAX_ROWS = 10_000;
export const IMPORT_MAX_BODY_BYTES = 9_437_184;
/** Room in the body for everything but the rows: list, tags, mapping. */
const BODY_MARGIN = 16 * 1024;
/** The most a file may weigh before it is read (100,000 Contacts is the Team cap). */
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const POLL_MS = 1500;

type Body = Record<string, unknown>;
type ImportFlags = Omit<ContactFlags, "list" | "tag"> & {
  file?: string;
  format?: string;
  "list-name"?: string;
  list?: string;
  tag?: string | string[];
  "remove-tag"?: string | string[];
  map?: string | string[];
  delimiter?: string;
  "no-wait"?: boolean;
  outcome?: string;
};

const FORMATS = ["csv", "json", "ndjson"];
const EXT: Record<string, string> = { ".csv": "csv", ".json": "json", ".ndjson": "ndjson", ".jsonl": "ndjson" };

/** The 1-based line and column of a JSON parse failure, never the text around it. */
function whereJson(text: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : "";
  const lc = /line (\d+) column (\d+)/.exec(msg);
  if (lc) return `line ${lc[1]}, column ${lc[2]}`;
  const pos = /position (\d+)/.exec(msg);
  if (!pos) return "an unknown position";
  const before = text.slice(0, Number(pos[1]));
  const line = before.split("\n").length;
  return `line ${line}, column ${before.length - before.lastIndexOf("\n")}`;
}

/** A CSV's records: split at newlines outside quotes (a quoted field may hold newlines); blank lines dropped. */
export function csvRecords(text: string): string[] {
  const records: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (ch === "\n" && !quoted) {
      records.push(cur.replace(/\r$/, ""));
      cur = "";
    } else cur += ch;
  }
  records.push(cur.replace(/\r$/, ""));
  return records.filter((r) => r.trim() !== "");
}

/** Greedy chunks of at most `maxRows` rows and `maxBytes` bytes (`size` measures one row); a row too big alone goes alone. */
export function chunkRows<T>(rows: T[], size: (r: T) => number, maxRows = IMPORT_MAX_ROWS, maxBytes = IMPORT_MAX_BODY_BYTES - BODY_MARGIN): T[][] {
  const chunks: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;
  for (const r of rows) {
    const n = size(r);
    if (cur.length > 0 && (cur.length >= maxRows || bytes + n > maxBytes)) {
      chunks.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(r);
    bytes += n;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** The file cut into import-sized chunks of rows (a CSV's rows are text; the header is kept to repeat). Exit 2, nothing sent, on a structure problem. */
function split(text: string, format: string): { header?: string; chunks: unknown[][] } {
  if (format === "csv") {
    const [header, ...rows] = csvRecords(text);
    if (header === undefined) usage("--file: the CSV has no header row.");
    if (rows.length === 0) usage("--file: the CSV has a header and no rows to import.");
    return { header, chunks: chunkRows(rows, (r) => Buffer.byteLength(r) + 1) };
  }
  let objs: unknown[];
  if (format === "json") {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch (err) {
      usage(`--file: not valid JSON, at ${whereJson(text, err)}.`);
    }
    if (!Array.isArray(doc)) usage("--file: a JSON import is an array of objects, one per Contact.");
    objs = doc;
  } else {
    objs = text.split("\n").flatMap((line, i) => {
      if (line.trim() === "") return [];
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return usage(`--file: line ${i + 1} is not valid JSON.`);
      }
    });
  }
  const bad = objs.findIndex((o) => o === null || typeof o !== "object" || Array.isArray(o));
  if (bad >= 0) usage(`--file: row ${bad + 1} is not an object.`);
  if (objs.length === 0) usage("--file: no rows to import.");
  return { chunks: chunkRows(objs, (o) => Buffer.byteLength(JSON.stringify(o)) + 1) };
}

/** `--map header=target`, repeatable. */
function mapping(f: ImportFlags): Record<string, string> | undefined {
  const pairs = listFlag("map", f.map);
  if (!pairs.length) return undefined;
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const at = p.indexOf("=");
    if (at <= 0 || at === p.length - 1) usage("--map takes header=target, for example --map \"LinkedIn Profile=linkedin_url\".");
    out[p.slice(0, at)] = p.slice(at + 1);
  }
  return out;
}

const DELIMITERS: Record<string, string> = { ",": ",", comma: ",", ";": ";", semicolon: ";", tab: "\t", "\\t": "\t", "\t": "\t" };

type Skipped = { row: number; outcome: string; reason?: string | null; field?: string | null };
type Imp = { id?: string; status?: string; counts?: Record<string, number>; failure?: { code?: string; message?: string }; report?: Skipped[] };

const COUNTS = ["created", "updated", "unchanged", "skipped"];

async function runImport(c: Curviate, f: ImportFlags): Promise<void> {
  const file = f.file;
  if (file === undefined || file.trim() === "") usage("--file is required: a CSV, JSON or NDJSON file, or - for stdin.");
  const dash = isStdinToken(file);
  let format = f.format;
  if (format === undefined) {
    format = dash ? undefined : EXT[(/\.[^./\\]+$/.exec(file.toLowerCase()) ?? [""])[0]];
    if (format === undefined) usage(dash ? "--format is required with --file -: csv, json or ndjson." : "--format could not be told from the file name: pass csv, json or ndjson.");
  }
  if (!FORMATS.includes(format)) usage(`--format takes one of ${FORMATS.join(", ")}.`);
  if (f.list !== undefined && f["list-name"] !== undefined) usage("--list and --list-name cannot be combined: name the list (cl_...) or a list to create by name.");
  if (f.delimiter !== undefined && format !== "csv") usage("--delimiter applies to a CSV file.");
  const base: Body = {};
  if (f.list !== undefined) base["list_id"] = f.list;
  if (f["list-name"] !== undefined) base["list_name"] = f["list-name"];
  const tags = listFlag("tag", f.tag);
  if (tags.length) base["tags"] = tags;
  const removeTags = listFlag("remove-tag", f["remove-tag"]);
  if (removeTags.length) base["remove_tags"] = removeTags;
  const map = mapping(f);
  if (map) base["mapping"] = map;
  if (f.delimiter !== undefined) {
    const d = DELIMITERS[f.delimiter];
    if (d === undefined) usage("--delimiter takes comma, semicolon or tab.");
    base["delimiter"] = d;
  }

  // Structure first, nothing sent on a refusal.
  const text = await readFileFlag("file", file, { allowBom: true, maxBytes: MAX_FILE_BYTES, others: f as Record<string, unknown> });
  const { header, chunks } = split(text, format);
  const bodyOf = (rows: unknown[]): Body => ({ ...base, ...(header !== undefined ? { csv: [header, ...rows].join("\n") } : { rows }) });
  const total = chunks.reduce((n, x) => n + x.length, 0);
  if (f.preview) return preview("contacts.imports.create", chunks.length > 1 ? { imports: chunks.length, rows: total } : {}, bodyOf(chunks[0]!));

  const wait = !f["no-wait"];
  const poll = async (made: Imp): Promise<Imp> => {
    let imp = made;
    while (wait && imp.status !== "completed" && imp.status !== "failed") {
      await sleep(POLL_MS);
      imp = readableObject((await c.contacts.imports.get(String(imp.id))) as Imp);
    }
    return imp;
  };
  const done: Imp[] = [];
  const offsets: number[] = [];
  let at = 0;
  // Each import is sent, then awaited, before the next: a refusal stops the run before any later chunk is sent.
  await sendChunked(
    chunks,
    async (rows) => {
      const made = readableObject((await c.contacts.imports.create(bodyOf(rows) as never)) as Imp);
      const imp = await poll(made);
      offsets.push(at);
      at += rows.length;
      done.push(imp);
      if (imp.status === "failed") throw await failedImport(imp);
      return imp;
    },
    f,
    "rows",
  );
  // A failed import never reaches here: it threw above and sendChunked exited with its error.
  const counts = Object.fromEntries(COUNTS.map((k) => [k, done.reduce((n, i) => n + (i.counts?.[k] ?? 0), 0)]));
  const skipped: Array<{ row: number; reason: string | null; field: string | null }> = [];
  for (const [k, imp] of done.entries()) {
    if (!wait || !(imp.counts?.["skipped"] ?? 0)) continue;
    for (const r of await skippedRows(c, imp)) skipped.push({ row: offsets[k]! + r.row, reason: r.reason ?? null, field: r.field ?? null });
  }
  const summary = { imports: done.map((i) => ({ id: i.id, status: i.status })), total_rows: total, ...(wait ? { counts, skipped } : {}) };
  renderSuccess(summary, outputOpts(f), process);
}

/** The import's own failure as the error to stop on: its code when the API knows it, else a generic one. */
async function failedImport(imp: Imp): Promise<Error> {
  const { CurviateError } = await import("@curviate/sdk");
  return new CurviateError({ code: (imp.failure?.code ?? "INTERNAL") as never, message: imp.failure?.message ?? "The import failed.", status: 422 } as never);
}

/** The rows an import skipped: from its report when it carries one, else its skipped rows read back. */
async function skippedRows(c: Curviate, imp: Imp): Promise<Skipped[]> {
  if (imp.report) return imp.report.filter((r) => r.outcome === "skipped");
  const rows: Skipped[] = [];
  let cursor: string | null | undefined;
  do {
    const page = (await c.contacts.imports.rows(String(imp.id), { outcome: "skipped", limit: 100, ...(cursor ? { cursor } : {}) } as never)) as { items?: Skipped[]; cursor?: string | null };
    rows.push(...(page.items ?? []));
    cursor = page.cursor;
  } while (cursor);
  return rows;
}

const importCmd = defineCommand({
  meta: {
    name: "import",
    description:
      `Import Contacts from a CSV, JSON (an array of objects) or NDJSON file. The format comes from the extension; with --file - pass --format. A file above ${IMPORT_MAX_ROWS} rows or ${(IMPORT_MAX_BODY_BYTES / 1048576).toFixed(0)} MiB ` +
      "is split into several imports, run one after the other (a CSV's header is repeated), each awaited unless --no-wait; the first refused or failed import stops the run. " +
      "Only the file's structure is checked here; the server skips bad rows and reports why. Re-importing merges: a Contact already there is updated or left as it is. Needs Automate.",
    risk: "write",
    rules: {
      changes: "Contacts are created or updated, joined to --list and tagged with --tag. Nothing is sent to LinkedIn or to the people.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "Safe to repeat: Contacts converge, a second run reports them `unchanged`. A run stopped part way: read `curviate contact imports list`, then import the rest.",
      undo: "Cannot be undone as a whole. `curviate contact delete --import IMPORT_ID` deletes every Contact in its report, those it only updated included; Tags and list membership are undone with `contact tags remove` and `contact lists remove`.",
    },
    errors: {
      CONTACT_LIMIT_REACHED: "the Team is at its Contact cap; rows past it are skipped.",
      IMPORT_QUEUE_FULL: "too many imports are queued (429); wait, then run it again.",
      NAME_TAKEN: "--list-name names a list that exists.",
    },
    output: ["One report: `imports` (id and status each), `total_rows`, summed `counts` (created, updated, unchanged, skipped) and `skipped` rows with their number in the file, a reason and the field. With --no-wait: the imports' ids and statuses only."],
    seeAlso: ["curviate contact imports get", "curviate contact list"],
    examples: [
      "curviate contact import --file prospects.csv --list-name \"Q4 prospects\" --tag conference",
      "curviate contact import --file prospects.csv --map \"LinkedIn Profile=linkedin_url\" --list cl_YOUR_LIST_ID --no-wait",
      "curviate contact import --file - --format ndjson --list cl_YOUR_LIST_ID",
    ],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    file: { type: "string", stdinArg: true, required: true, description: "The file: a path, or - to read it from stdin (then --format is required)." },
    format: { type: "string", description: "csv | json | ndjson. Default: from the file extension (.csv, .json, .ndjson)." },
    list: { type: "string", description: "Add every imported Contact to this Contact list (cl_...)." },
    "list-name": { type: "string", description: "Add them to the list of this name (up to 100 characters), creating it. Not with --list." },
    tag: { type: "string", description: "Put this Tag on every imported Contact (up to 64 characters); repeatable." },
    "remove-tag": { type: "string", description: "Take this Tag off every imported Contact; repeatable." },
    map: { type: "string", description: "Map a file header to a Contact field: header=target, for example \"LinkedIn Profile=linkedin_url\"; repeatable." },
    delimiter: { type: "string", description: "A CSV's separator: comma, semicolon or tab. Default: found by the server." },
    "no-wait": { type: "boolean", description: "Print the imports' ids without waiting for them to finish. Stops only on a refused request." },
  },
  run: online(runImport),
});

// ---------------------------------------------------------------------------

const ID = { type: "positional" as const, description: "Import id (imp_...)." };

const importsList = defineCommand({
  meta: { name: "list", description: "List your Team's imports, newest first: status, counts and failure.", risk: "read", examples: ["curviate contact imports list"] },
  args: { ...readOnly(GLOBAL_FLAGS) },
  run: online(async (c, f) => {
    rejectPaginationModifiersWithoutAll(f, process);
    const params: Body = {};
    if (f.limit !== undefined) params["limit"] = intFlag("limit", f.limit, 1, 100);
    const cursor = readCursorFlag(f, process);
    if (cursor) params["cursor"] = cursor;
    try {
      if (f.all) {
        const next = (p: Body) => c.contacts.imports.list(p as never) as Promise<{ items?: unknown[]; cursor?: string | null }>;
        for await (const item of streamAll(next, params, { maxPages: readMaxPagesFlag(f, process), out: process, pageDelayMs: pageDelayFromFlags(f) })) writeNdjsonItem(process, item, f.fields);
      } else {
        renderSuccess(readablePage(await c.contacts.imports.list(params as never)), outputOpts(f), process);
      }
    } catch (err) {
      await fail(err, f);
    }
  }),
});

const importsGet = defineCommand({
  meta: {
    name: "get",
    description:
      "One import: its status, counts, the columns it mapped or ignored, and its failure. With --outcome, its rows instead: one per row of the file with what happened (created, updated, unchanged, skipped), the reason and the field. " +
      "Import records are kept for a limited time.",
    risk: "read",
    examples: ["curviate contact imports get imp_YOUR_IMPORT_ID", "curviate contact imports get imp_YOUR_IMPORT_ID --outcome skipped"],
  },
  args: {
    ...readOnly(GLOBAL_FLAGS),
    id: ID,
    outcome: { type: "string", description: "Read the rows instead: comma list of created, updated, unchanged, skipped." },
  },
  run: online(async (c, f: ContactFlags & { outcome?: string }) => {
    const id = String(f.id ?? "");
    try {
      if (f.outcome === undefined) return renderSuccess(readableObject(await c.contacts.imports.get(id)), outputOpts(f), process);
      rejectPaginationModifiersWithoutAll(f, process);
      const params: Body = { outcome: listFlag("outcome", f.outcome).join(",") };
      if (f.limit !== undefined) params["limit"] = intFlag("limit", f.limit, 1, 100);
      const cursor = readCursorFlag(f, process);
      if (cursor) params["cursor"] = cursor;
      if (f.all) {
        const next = (p: Body) => c.contacts.imports.rows(id, p as never) as Promise<{ items?: unknown[]; cursor?: string | null }>;
        for await (const item of streamAll(next, params, { maxPages: readMaxPagesFlag(f, process), out: process, pageDelayMs: pageDelayFromFlags(f) })) writeNdjsonItem(process, item, f.fields);
      } else {
        renderSuccess(readablePage(await c.contacts.imports.rows(id, params as never)), outputOpts(f), process);
      }
    } catch (err) {
      await fail(err, f);
    }
  }),
});

export const contactImportCommand = importCmd;
export const contactImportsCommand = defineCommand({
  meta: { name: "imports", description: "Your Team's import records." },
  subCommands: { list: importsList, get: importsGet },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(contactImportsCommand, ["curviate", "contact", "imports"]);
  },
});

void READ_SINGLE_FLAGS;
