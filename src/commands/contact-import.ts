/**
 * `curviate lead import` and `curviate lead imports`.
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
import type { Curviate, CurviateError } from "@curviate/sdk";
import { GLOBAL_FLAGS, READ_SINGLE_FLAGS, WRITE_SINGLE_FLAGS, readOnly } from "../lib/global-flags.js";
import { isJsonMode, renderSuccess, writeNdjsonItem } from "../lib/output.js";
import { readFileFlag } from "../lib/document.js";
import { isStdinToken } from "../lib/stdin.js";
import { streamAll, pageDelayFromFlags, readCursorFlag, readMaxPagesFlag, readableObject, readablePage, rejectPaginationModifiersWithoutAll } from "../lib/paginate.js";
import { intFlag } from "../lib/int-flag.js";
import { sendChunked } from "../lib/chunks.js";
import { withWireNotes, type WireNotes } from "../lib/client.js";
import { fail, listFlag, outputOpts, usage } from "../lib/root-command.js";
import { online, preview, type ContactFlags } from "./contact.js";

/** The operation's published `x-curviate-limits`: rows per import, and the request body in bytes. */
export const IMPORT_MAX_ROWS = 10_000;
export const IMPORT_MAX_BODY_BYTES = 9_437_184;
/** Room in the body for everything but the rows: list, tags, mapping. */
const BODY_MARGIN = 16 * 1024;
/** The most a file may weigh before it is read (100,000 Leads is the Team cap). */
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
  "apply-lists"?: boolean;
  map?: string | string[];
  delimiter?: string;
  "no-wait"?: boolean;
  wait?: boolean;
  async?: boolean;
  outcome?: string;
  source?: string;
  "source-url"?: string;
  filter?: string | string[];
  "filters-json"?: string;
  "list-id"?: string;
  "post-id"?: string;
  "group-id"?: string;
  titles?: string | string[];
  max?: string;
  continue?: string;
  restart?: boolean;
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
    if (!Array.isArray(doc)) usage("--file: a JSON import is an array of objects, one per Lead.");
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

/** The most a `Retry-After` the CLI sleeps (seconds); a longer one fails loudly. */
export const RETRY_AFTER_BOUND_S = 60;
/** The wait when the API says "busy" and names none. */
const RETRY_DEFAULT_S = 5;
/** Sends of one chunk the team's busy answer may cost before the run stops. */
const MAX_SENDS = 5;
/**
 * An inline import writes its record in the same transaction as its rows, so a request that timed out mid-apply
 * can show no import yet: the Team's imports are read again every 2 s, up to RELIST_TRIES more times (30 s),
 * before the CLI says none exists. The env var is a test seam (the interval; the window scales with it).
 */
const relistMs = (): number => Number(process.env["CURVIATE_IMPORT_RELIST_MS"]) || 2000;
const RELIST_TRIES = 15;
/** Our clock against the API's: an import this much older than the request still counts as its. */
const CLOCK_SKEW_MS = 30_000;

const say = (msg: string): void => void process.stderr.write(msg + "\n");

/**
 * Send one chunk. A team-busy 429 (`RATE_LIMIT_TENANT`: known not processed) waits the advertised `Retry-After`,
 * bounded, and sends again. A timeout or a dropped connection says nothing about whether the API applied the
 * chunk, so the Team's newest imports are read for the one this request made (`recover`).
 */
async function createChunk(c: Curviate, body: Body, rows: number, seen: string[], k: number, n: number): Promise<Imp> {
  const { CurviateError } = await import("@curviate/sdk");
  for (let sends = 1; ; sends++) {
    const notes: WireNotes = {};
    const started = Date.now();
    try {
      return readableObject((await withWireNotes(notes, () => c.leads.imports.create(body as never))) as Imp);
    } catch (err) {
      if (!(err instanceof CurviateError)) throw err;
      if (err.code === "RATE_LIMIT_TENANT") {
        const wait = notes.retryAfterS ?? RETRY_DEFAULT_S;
        // The API names the import holding the Team's write lock, when one does.
        const d = err.details as { import_id?: unknown; started_at?: unknown } | undefined;
        const holder = typeof d?.import_id === "string" ? ` Import ${d.import_id} (started ${String(d.started_at)}) holds the Team's write lock: read it with \`curviate lead imports get ${d.import_id}\`.` : "";
        if (wait > RETRY_AFTER_BOUND_S || sends >= MAX_SENDS) {
          const why = wait > RETRY_AFTER_BOUND_S ? ` The API asked to wait ${wait} s, more than the ${RETRY_AFTER_BOUND_S} s the CLI waits.` : "";
          throw new CurviateError({ code: err.code, message: `${err.message}${why} Nothing in this chunk was imported; send it again later.${holder}`, httpStatus: 429, userFixable: false, retryLikelyToSucceed: true, ...(err.details ? { details: err.details } : {}) } as never);
        }
        say(`Import ${k} of ${n}: the Team has other Lead writes running (nothing was imported); waiting ${wait} s, then sending it again.${holder}`);
        await sleep(wait * 1000);
        continue;
      }
      // A timeout or a dropped connection: the request may have been applied.
      if (err.code === "CLIENT_TIMEOUT" || (err.code === "INTERNAL" && err.httpStatus === undefined)) return recover(c, body, rows, seen, started, notes, err, k, n);
      throw err;
    }
  }
}

/** What a timed-out or dropped import did: the import it made, else an error that says what is known. */
async function recover(c: Curviate, body: Body, rows: number, seen: string[], started: number, notes: WireNotes, err: CurviateError, k: number, n: number): Promise<Imp> {
  const { CurviateError } = await import("@curviate/sdk");
  const fresh = (message: string): CurviateError => new CurviateError({ code: err.code, message, userFixable: true, retryLikelyToSucceed: false } as never);
  if (notes.unreached) throw fresh(`Nothing was imported: the API could not be reached (${err.message}).`);
  say(`Import ${k} of ${n}: no answer from the API; looking for the import it made.`);
  let found: Imp | undefined;
  // ponytail: the API names no credential and the CLI cannot learn the caller (no /v1/me), so an import is this request's by shape and time (rows, format, list, 30 s of clock skew); a concurrent identical import by the same Team is the ceiling. Upgrade when the API offers a caller id: also match the import's `created_by_user_id`.
  for (let tries = 0; ; tries++) {
    try {
      const page = (await c.leads.imports.list({ limit: 20 } as never)) as { items?: Array<Imp & { total_rows?: number; format?: string; list_id?: string | null; created_at?: string }> };
      found = (page.items ?? []).find(
        (i) =>
          !seen.includes(String(i.id)) &&
          i.total_rows === rows &&
          i.format === (body["csv"] !== undefined ? "csv" : "rows") &&
          (body["list_id"] === undefined || i.list_id === body["list_id"]) &&
          Date.parse(i.created_at ?? "") >= started - CLOCK_SKEW_MS,
      );
    } catch {
      throw fresh(`${err.message} The check for an import it made failed too: read \`curviate lead imports list\` before running this again, it may have been imported.`);
    }
    if (found || tries >= RELIST_TRIES) break;
    await sleep(relistMs());
  }
  if (!found) throw fresh(`${err.message} No import from this request appeared within 30 s, so nothing was imported so far. If the API is only slow, one may still appear: read \`curviate lead imports list\` before running this again.`);
  say(`Import ${k} of ${n}: the API did apply it. Import ${found.id} is ${found.status}${found.status === "completed" ? ` (${COUNTS.map((x) => `${x} ${found.counts?.[x] ?? 0}`).join(", ")})` : ""}.`);
  return found;
}

const SOURCE_KINDS = ["people_search", "company_people", "sales_nav_search", "sales_nav_lead_list", "sales_nav_account_list", "sales_nav_company_people", "recruiter_search", "post_engagers", "group_members"];

/** The kind a pasted search URL names, or undefined. */
function kindOfUrl(url: string): string | undefined {
  if (/linkedin\.com\/sales\/search\/compan/i.test(url)) return "sales_nav_company_people";
  if (/linkedin\.com\/sales\//i.test(url)) return "sales_nav_search";
  if (/linkedin\.com\/talent\//i.test(url)) return "recruiter_search";
  if (/\/search\/results\/people/i.test(url)) return "people_search";
  if (/\/search\/results\/companies/i.test(url)) return "company_people";
  return undefined;
}

/** `lead import --source`: one create request; the server reads the source page by page. */
async function runSourceImport(c: Curviate, f: ImportFlags): Promise<void> {
  if (f.file !== undefined) usage("--file and --source/--source-url cannot be combined: import a file, or a LinkedIn source.");
  const url = f["source-url"];
  const kind = f.source ?? (url !== undefined ? kindOfUrl(url) : undefined);
  if (kind === undefined) usage("--source is required: the URL names no kind it knows. One of " + SOURCE_KINDS.join(", ") + ".");
  if (f.account === undefined || f.account.trim() === "") usage("--account is required: the Account that reads the source (acc_...). Its limits and Active hours apply.");
  if (f.continue !== undefined && f.restart) usage("--continue and --restart cannot be combined.");
  const source: Body = { kind, account_id: f.account };
  if (url !== undefined) source["url"] = url;
  const pairs = listFlag("filter", f.filter);
  if (pairs.length && f["filters-json"] !== undefined) usage("--filter and --filters-json cannot be combined.");
  if (f["filters-json"] !== undefined) {
    try {
      source["filters"] = JSON.parse(f["filters-json"]);
    } catch {
      usage("--filters-json is not valid JSON: pass an object, for example '{\"keywords\":\"cto\"}'.");
    }
  } else if (pairs.length) {
    const filters: Body = {};
    for (const p of pairs) {
      const eq = p.indexOf("=");
      if (eq <= 0) usage("--filter takes key=value, for example --filter keywords=cto.");
      const k = p.slice(0, eq), v = p.slice(eq + 1);
      filters[k] = k in filters ? [filters[k], v].flat() : v;
    }
    source["filters"] = filters;
  }
  if (f["list-id"] !== undefined) source["list_id"] = f["list-id"];
  if (f["post-id"] !== undefined) source["post_id"] = f["post-id"];
  if (f["group-id"] !== undefined) source["group_id"] = f["group-id"];
  const titles = listFlag("titles", f.titles);
  if (titles.length) source["titles"] = titles;
  if (f.max !== undefined) source["max"] = intFlag("max", f.max, 1);
  const body: Body = { source };
  if (f.continue !== undefined) body["continue_from"] = f.continue;
  if (f.restart) body["restart"] = true;
  if (f.list !== undefined) body["list_id"] = f.list;
  if (f["list-name"] !== undefined) body["list_name"] = f["list-name"];
  const tags = listFlag("tag", f.tag);
  if (tags.length) body["tags"] = tags;
  if (f.preview) return preview("leads.imports.create", {}, body);
  try {
    const imp = await c.leads.imports.create(body as never);
    renderSuccess(readableObject(imp), importOpts(f, importHuman), process);
    if (!outputOpts(f).json) process.stderr.write(`Follow it with \`curviate lead imports get ${String((imp as Body)["id"])}\`; pause, resume or stop it with \`curviate lead imports pause|resume|stop\`.\n`);
  } catch (err) {
    await fail(err, f);
  }
}

async function runImport(c: Curviate, f: ImportFlags): Promise<void> {
  if (f.source !== undefined || f["source-url"] !== undefined) return runSourceImport(c, f);
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
  if (f["apply-lists"] === true) base["apply_lists"] = true;
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
  if (f.preview) return preview("leads.imports.create", chunks.length > 1 ? { imports: chunks.length, rows: total } : {}, bodyOf(chunks[0]!));

  // The parser reads `--no-wait` as the negation of a `wait` flag. `--async` is the same.
  const wait = !(f["no-wait"] === true || f.wait === false || f.async === true);
  const poll = async (made: Imp): Promise<Imp> => {
    let imp = made;
    while (wait && imp.status !== "completed" && imp.status !== "failed") {
      imp = readableObject((await c.leads.imports.get(String(imp.id))) as Imp);
      if (imp.status !== "completed" && imp.status !== "failed") await sleep(POLL_MS);
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
      const made = await createChunk(c, bodyOf(rows), rows.length, done.map((i) => String(i.id)), done.length + 1, chunks.length);
      const imp = await poll(made);
      offsets.push(at);
      at += rows.length;
      done.push(imp);
      if (imp.status === "failed") throw await failedImport(imp);
      if (!wait && imp.status !== "completed") say(`Import ${done.length} of ${chunks.length}: ${imp.id} is ${imp.status}; read its progress with \`curviate lead imports get ${imp.id}\`.`);
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
    const page = (await c.leads.imports.rows(String(imp.id), { outcome: "skipped", limit: 100, ...(cursor ? { cursor } : {}) } as never)) as { items?: Skipped[]; cursor?: string | null };
    rows.push(...(page.items ?? []));
    cursor = page.cursor;
  } while (cursor);
  return rows;
}

const importCmd = defineCommand({
  meta: {
    name: "import",
    description:
      `Import Leads from a CSV, JSON (an array of objects) or NDJSON file. The format comes from the extension; with --file - pass --format. A file above ${IMPORT_MAX_ROWS} rows or ${(IMPORT_MAX_BODY_BYTES / 1048576).toFixed(0)} MiB ` +
      "is split into several imports, run one after the other (a CSV's header is repeated), each awaited unless --async (or --no-wait); the first refused or failed import stops the run. " +
      "Each row names the person by linkedin_url, or by email alone (a Lead known by its email address; a CSV with an email column and no LinkedIn URL column imports). " +
      "Only the file's structure is checked here; the server skips bad rows and reports why (missing_linkedin_url_or_email: neither; email_on_several_leads: several LinkedIn Leads hold that address). Re-importing merges: a Lead already there is updated or left as it is. " +
      `If the request times out or the connection drops, the CLI looks up the Team's newest imports, again every 2 s for up to 30 s while none shows, and reports the one this request made (id and status; it waits on a running one); it says nothing was imported only when none appeared. A busy-Team 429 (RATE_LIMIT_TENANT) waits the advertised Retry-After (up to ${RETRY_AFTER_BOUND_S} s) and sends that import again, naming the import holding the Team's write lock when the API names one; a longer wait fails. Needs a subscription.`,
    risk: "write",
    rules: {
      changes: "Leads are created or updated, joined to --list (and, with --apply-lists, to the lists their `lists` column names) and tagged with --tag. Nothing is sent to LinkedIn or to the people.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "After a timeout the CLI reports the import it made; do not run it again then. Otherwise Leads converge: a second run reports them `unchanged`. A run stopped part way: read `curviate lead imports list`, then import the rest.",
      undo: "Cannot be undone as a whole. `curviate lead delete --import IMPORT_ID` deletes every Lead in its report, those it only updated included; Tags and list membership are undone with `curviate lead tags remove` and `curviate lead lists remove`.",
    },
    errors: {
      LEAD_LIMIT_REACHED: "the Team is at its Lead cap; rows past it are skipped.",
      IMPORT_QUEUE_FULL: "too many imports are queued (429); wait, then run it again.",
      RATE_LIMIT_TENANT: `the Team has other Lead or Campaign writes running (429, nothing imported); the CLI waits Retry-After (up to ${RETRY_AFTER_BOUND_S} s) and sends again, a longer wait stops the run. When an import holds the Team's write lock, the message and \`details.import_id\` name it: read it with \`curviate lead imports get\`.`,
      CLIENT_TIMEOUT: "no answer within --timeout; the CLI reads the Team's newest imports (again for up to 30 s while none shows) and reports the import this request made. None found: nothing was imported so far, but read `curviate lead imports list` before running it again.",
      NAME_TAKEN: "--list-name names a list that exists.",
      IMPORT_STATUS_CONFLICT: "an import of this source is still queued, running or paused: resume or stop it, or pass --restart.",
      IMPORT_CANNOT_CONTINUE: "--continue names an import that read LinkedIn's last results for its search: narrow the search or split it.",
    },
    output: ["With --json stdout is exactly one JSON document; progress and waits go to stderr. One report: `imports` (id and status each), `total_rows`, summed `counts` (created, updated, unchanged, skipped) and `skipped` rows with their number in the file, a reason and the field. With --async (or --no-wait): the imports' ids and statuses only, printed as soon as each is accepted; a queued one's progress is \`curviate lead imports get IMPORT_ID\` (stderr names it)."],
    seeAlso: ["curviate lead imports get", "curviate lead list"],
    examples: [
      "curviate lead import --file prospects.csv --list-name \"Q4 prospects\" --tag conference",
      "curviate lead import --source-url \"https://www.linkedin.com/search/results/people/?keywords=cto\" --account acc_YOUR_ACCOUNT_ID --max 200 --list-name CTOs",
      "curviate lead import --source company_people --filter keywords=fintech --titles CTO,VP Engineering --account acc_YOUR_ACCOUNT_ID",
    ],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    file: { type: "string", stdinArg: true, description: "The file: a path, or - to read it from stdin (then --format is required). Not with --source." },
    format: { type: "string", description: "csv | json | ndjson. Default: from the file extension (.csv, .json, .ndjson)." },
    list: { type: "string", description: "Add every imported Lead to this Lead list (cl_...)." },
    "list-name": { type: "string", description: "Add them to the list of this name (up to 100 characters), creating it. Not with --list." },
    tag: { type: "string", description: "Put this Tag on every imported Lead (up to 64 characters); repeatable." },
    "remove-tag": { type: "string", description: "Take this Tag off every imported Lead; repeatable." },
    "apply-lists": { type: "boolean", description: "Add each Lead to the Lead lists named in its `lists` (an export's column), creating a missing list by name. Only adds. A row past the Team's list limit is skipped (list_limit_reached). Default: the column is ignored." },
    map: { type: "string", description: "Map a file header to a Lead field: header=target, for example \"LinkedIn Profile=linkedin_url\"; repeatable." },
    delimiter: { type: "string", description: "A CSV's separator: comma, semicolon or tab. Default: found by the server." },
    async: { type: "boolean", description: "Print the imports' ids as soon as each is accepted and exit 0, without waiting for them to finish; follow one with `curviate lead imports get IMPORT_ID`. Stops only on a refused request." },
    "no-wait": { type: "boolean", description: "Same as --async." },
    source: { type: "string", description: "Import from LinkedIn instead of a file: people_search, sales_nav_search, recruiter_search (a pasted --source-url or --filter), company_people (a company search plus --titles), sales_nav_lead_list (--list-id), sales_nav_account_list (--list-id, --titles optional), sales_nav_company_people (a Sales Navigator account search --source-url or --filter, plus --titles), post_engagers (--post-id) or group_members (--group-id). Default with --source-url: the kind the URL names." },
    "source-url": { type: "string", description: "A pasted LinkedIn search URL (people, Sales Navigator lead or account, Recruiter or company search)." },
    filter: {
      type: "string",
      description:
        "A built search instead of a URL: key=value, repeatable (a key given twice becomes a list). The keys each kind offers: " +
        "people_search: keywords, advanced_keywords (job title as text, use --filters-json), location, current_company, past_company, school, industry, service, network_distance (location and network_distance exclude each other); " +
        "company_people (the company step): keywords, industry, location, headcount, has_job_postings; " +
        "recruiter_search: keywords, job_function, workplace_type (ON_SITE, HYBRID, REMOTE), group; " +
        "sales_nav_search: the Sales Navigator lead search filters (job titles are lookup ids from `curviate core sales-nav search parameters`); " +
        "sales_nav_company_people (the account step): the Sales Navigator account search filters. " +
        "Any other key is refused naming it (connections_of and followers_of are not offered on people_search).",
    },
    "filters-json": { type: "string", description: "The built search as one JSON object. Not with --filter." },
    "list-id": { type: "string", description: "The Sales Navigator lead list id (sales_nav_lead_list) or account list id (sales_nav_account_list)." },
    "post-id": { type: "string", description: "The post id or URL (post_engagers)." },
    "group-id": { type: "string", description: "A LinkedIn group id the Account belongs to (group_members)." },
    titles: { type: "string", description: "Job titles to keep, repeatable or a comma list (company_people and sales_nav_company_people: required; sales_nav_account_list: optional). Only people with one of them are imported, never a whole company." },
    max: { type: "string", description: "Stop after this many people (default and maximum: the kind's cap)." },
    continue: { type: "string", description: "Continue this earlier import of the same source (imp_...) from where it stopped." },
    restart: { type: "boolean", description: "Read the source from the beginning, even when an earlier import of it could continue." },
  },
  run: online(runImport),
});

// ---------------------------------------------------------------------------

const ID = { type: "positional" as const, description: "Import id (imp_...)." };

const importsList = defineCommand({
  meta: { name: "list", description: "List your Team's imports, newest first: status, counts and failure; an import from a LinkedIn source also its `progress` line without --json (the wait, when its next page is read, how long is left), and `next_page_at`, `waiting`, `estimate` as `lead imports get` describes.", risk: "read", examples: ["curviate lead imports list"] },
  args: { ...readOnly(GLOBAL_FLAGS) },
  run: online(async (c, f) => {
    rejectPaginationModifiersWithoutAll(f, process);
    const params: Body = {};
    if (f.limit !== undefined) params["limit"] = intFlag("limit", f.limit, 1, 100);
    const cursor = readCursorFlag(f, process);
    if (cursor) params["cursor"] = cursor;
    try {
      if (f.all) {
        const next = (p: Body) => c.leads.imports.list(p as never) as Promise<{ items?: unknown[]; cursor?: string | null }>;
        for await (const item of streamAll(next, params, { maxPages: readMaxPagesFlag(f, process), out: process, pageDelayMs: pageDelayFromFlags(f) })) writeNdjsonItem(process, item, f.fields);
      } else {
        renderSuccess(readablePage(await c.leads.imports.list(params as never)), importOpts(f, importsHuman), process);
      }
    } catch (err) {
      await fail(err, f);
    }
  }),
});

type ImportView = {
  status?: unknown; format?: unknown; next_page_at?: unknown; started_at?: unknown; finished_at?: unknown; finish_reason?: unknown;
  counts?: { found?: unknown } | null; failure?: { message?: unknown } | null;
  waiting?: { kind?: unknown; until?: unknown; budget?: unknown; import_id?: unknown } | null;
  estimate?: { seconds_min?: unknown; seconds_max?: unknown } | null;
};

// The dashboard's units and wording (minutes under 90, hours under 36, then days; en-GB numbers and clock), local time.
const UNITS: ReadonlyArray<readonly [string, number, number]> = [["minute", 60, 90 * 60], ["hour", 3600, 36 * 3600], ["day", 86_400, Infinity]];
const unitOf = (s: number) => UNITS.find(([, , below]) => s < below)!;
const plural = (n: number, unit: string) => `${n.toLocaleString("en-GB")} ${unit}${n === 1 ? "" : "s"}`;
const amount = (s: number, size: number) => Math.max(1, Math.round(s / size));
const HM = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const WD = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" });
const dayKey = (t: number) => new Date(t).toDateString();

/** A duration in the unit that fits: "12 minutes", "2 hours", "3 days". */
export function durationText(seconds: number): string {
  const [unit, size] = unitOf(seconds);
  return plural(amount(seconds, size), unit);
}

/** The estimate in words: "About 8 to 11 minutes", "About 2 hours", "Less than a minute"; never a range with equal ends. */
export function estimateText(min: number, max: number): string {
  if (max < 60) return "Less than a minute";
  const [ua, sa] = unitOf(min), [ub, sb] = unitOf(max);
  const a = amount(min, sa), b = amount(max, sb);
  if (ua !== ub) return `About ${plural(a, ua)} to ${plural(b, ub)}`;
  return a === b ? `About ${plural(a, ua)}` : `About ${a.toLocaleString("en-GB")} to ${plural(b, ub)}`;
}

/** When, relative to `now`: "in under a minute", "in 4 minutes", "at 14:05", "tomorrow at 09:00", "on Mon 24 Nov at 09:00". */
export function whenText(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const ms = at - now;
  if (ms < 60_000) return "in under a minute";
  if (ms < 90 * 60_000) return `in ${durationText(ms / 1000)}`;
  if (dayKey(at) === dayKey(now)) return `at ${HM.format(at)}`;
  if (dayKey(at) === dayKey(now + 86_400_000)) return `tomorrow at ${HM.format(at)}`;
  return `on ${WD.format(at)} at ${HM.format(at)}`;
}

const LIMIT: Record<string, string> = { hour: "Hourly search limit reached", month: "Monthly search limit reached", warm_up: "Warm-up holds this Account's search at 0 pages for now" };

/**
 * An import from a LinkedIn source in one line, in the dashboard's words: the wait with the time of the next page, how
 * long is left (from `estimate.seconds_*`), how long a finished one took. Null for row and CSV imports.
 */
export function importStatusLine(imp: unknown, now = Date.now()): string | null {
  const im = (imp ?? {}) as ImportView;
  if (im.format !== "source") return null;
  const w = im.waiting && typeof im.waiting === "object" ? im.waiting : null;
  const iso = (v: unknown) => (typeof v === "string" ? v : null);
  const nextAt = iso(im.next_page_at), until = iso(w?.until);
  const next = nextAt ? `Next page ${whenText(nextAt, now)}` : null;
  const e = im.estimate;
  const left = e && typeof e.seconds_min === "number" && typeof e.seconds_max === "number" && e.seconds_max > 0 ? `${estimateText(e.seconds_min, e.seconds_max)} left` : null;
  const join = (...parts: (string | null)[]) => parts.filter(Boolean).join(". ");
  const started = iso(im.started_at), finished = iso(im.finished_at);
  const took = started && finished ? ` in ${durationText(Math.max(1, (Date.parse(finished) - Date.parse(started)) / 1000))}` : "";
  switch (im.status) {
    case "queued":
      if (w?.kind === "import_ahead") return join(`Starts after the import ahead of it${typeof w.import_id === "string" ? ` (${w.import_id})` : ""}`, nextAt ? `First page ${whenText(nextAt, now)}` : null, left);
      return join("Starts in a moment", left);
    case "running":
      if (!w) return join(next, left) || "Reading";
      switch (w.kind) {
        case "account_unavailable": return "Resumes once the Account is reconnected";
        case "active_hours": return join("Outside the Account's Active hours", next, left);
        case "budget": return join(LIMIT[String(w.budget)] ?? "Daily search limit reached", next, left);
        case "pushback": return join("Paused: LinkedIn slowed this search down", next, left);
        case "search_limited": return join(`LinkedIn shows this Account only a few search results for now. Resumes when that lifts${until ? `, at the latest ${whenText(until, now)}` : ""}`, left);
        case "halt": return join("Held by a safety pause", until ? `Resumes ${whenText(until, now)}` : null, left);
        default: return join(`Waiting (${String(w.kind)})`, next ?? (until ? `Resumes ${whenText(until, now)}` : null), left);
      }
    case "paused": return "Paused. Nothing is read until you resume it";
    case "stopped": return `Stopped. The ${typeof im.counts?.found === "number" ? im.counts.found.toLocaleString("en-GB") : "people"} found stay in the list`;
    case "completed":
      return im.finish_reason === "max_reached" ? `Done${took}: reached its maximum` : im.finish_reason === "no_new_leads" ? `Done${took}: three pages in a row brought nobody new` : `Done${took}: read every result`;
    case "failed": return typeof im.failure?.message === "string" ? im.failure.message : "Failed";
    default: return null;
  }
}

/** Human output of an import: `progress` (the line above) after `status`, and the estimate in seconds only (the deprecated working days dropped). */
function importHuman(imp: unknown): unknown {
  if (!imp || typeof imp !== "object" || Array.isArray(imp)) return imp;
  const line = importStatusLine(imp);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(imp)) {
    if (k === "estimate" && v && typeof v === "object") {
      out[k] = Object.fromEntries(Object.entries(v).filter(([key]) => !key.startsWith("working_days_")));
    } else out[k] = v;
    if (k === "status" && line) out["progress"] = line;
  }
  return out;
}
const importsHuman = (page: unknown): unknown => {
  const p = page as { items?: unknown[] };
  return Array.isArray(p?.items) ? { ...p, items: p.items.map(importHuman) } : page;
};
/** Output options for an import: the human view above, unless --json (which passes the API's fields through unchanged). */
const importOpts = (f: Parameters<typeof outputOpts>[0], slim: (d: unknown) => unknown) => {
  const o = outputOpts(f);
  return isJsonMode(o) ? o : { ...o, slim };
};

const importsGet = defineCommand({
  meta: {
    name: "get",
    description:
      "One import: its status, counts, the columns it mapped or ignored, and its failure. An import from a LinkedIn source also carries `next_page_at` (when its next page is read), `waiting` (why no page is read now, with `until`: active_hours, outside the Account's Active hours; budget, a search limit of the Account is reached, named by `budget`: hour, day, lines, month, or warm_up when warm-up holds the Account's search at 0 pages; while an import runs it and the Account's plain searches each are sure of half the hour's and the day's pages; pushback, LinkedIn slowed this search down; search_limited, LinkedIn shows this Account only a few search results for now; halt, a safety pause; account_unavailable, the Account needs reconnecting; import_ahead, queued behind `import_id`, another import of the same Account) and `estimate` (`seconds_min`, `seconds_max`: how long it still runs; `working_days_*` are deprecated). Without --json, `progress` says it in one line, for example \"Daily search limit reached. Next page tomorrow at 09:00. About 2 to 3 days left\". Nothing to retry and no need to poll: it resumes by itself; look again at `next_page_at`. Only a reconnect needs you, and a search limit you may raise with `curviate account safety update`. `counts.updated`: Leads the import filled at least one field on. With --outcome, its rows instead: one per row of the file with what happened (created, updated, unchanged, skipped), the reason and the field. " +
      "Import records are kept for a limited time.",
    risk: "read",
    examples: ["curviate lead imports get imp_YOUR_IMPORT_ID", "curviate lead imports get imp_YOUR_IMPORT_ID --outcome skipped"],
  },
  args: {
    ...readOnly(GLOBAL_FLAGS),
    id: ID,
    outcome: { type: "string", description: "Read the rows instead: comma list of created, updated, unchanged, skipped." },
  },
  run: online(async (c, f: ContactFlags & { outcome?: string }) => {
    const id = String(f.id ?? "");
    try {
      if (f.outcome === undefined) {
        const imp = readableObject(await c.leads.imports.get(id));
        renderSuccess(imp, importOpts(f, importHuman), process);
        const line = importStatusLine(imp);
        if (line && isJsonMode(outputOpts(f))) process.stderr.write(line + "\n");
        return;
      }
      rejectPaginationModifiersWithoutAll(f, process);
      const params: Body = { outcome: listFlag("outcome", f.outcome).join(",") };
      if (f.limit !== undefined) params["limit"] = intFlag("limit", f.limit, 1, 100);
      const cursor = readCursorFlag(f, process);
      if (cursor) params["cursor"] = cursor;
      if (f.all) {
        const next = (p: Body) => c.leads.imports.rows(id, p as never) as Promise<{ items?: unknown[]; cursor?: string | null }>;
        for await (const item of streamAll(next, params, { maxPages: readMaxPagesFlag(f, process), out: process, pageDelayMs: pageDelayFromFlags(f) })) writeNdjsonItem(process, item, f.fields);
      } else {
        renderSuccess(readablePage(await c.leads.imports.rows(id, params as never)), outputOpts(f), process);
      }
    } catch (err) {
      await fail(err, f);
    }
  }),
});

const control = (name: "pause" | "resume" | "stop", description: string, changes: string, undo: string, conflict: string) =>
  defineCommand({
    meta: {
      name,
      description,
      risk: "write",
      rules: { changes, visible_to: "Your Team.", budget_rows: [], retry: "A repeat answers IMPORT_STATUS_CONFLICT; nothing changes.", undo },
      errors: { IMPORT_STATUS_CONFLICT: conflict, TIER_REQUIRED: "your Team needs a subscription for imports from LinkedIn." },
      seeAlso: ["curviate lead imports get"],
      examples: [`curviate lead imports ${name} imp_YOUR_IMPORT_ID`],
    },
    args: { ...WRITE_SINGLE_FLAGS, id: ID },
    run: online(async (c, f: ContactFlags) => {
      const id = String(f.id ?? "");
      if (id.trim() === "") usage("the import id is required (imp_...).");
      if (f.preview) return preview(`leads.imports.${name}`, { id });
      try {
        renderSuccess(readableObject(await c.leads.imports[name](id)), outputOpts(f), process);
      } catch (err) {
        await fail(err, f);
      }
    }),
  });

const importsPause = control("pause", "Pause an import from a LinkedIn source: no page is read until it resumes; the Account is free for its next import meanwhile.", "The import stops reading pages until resumed.", "`curviate lead imports resume IMPORT_ID`.", "the import is not queued or running.");
const importsResume = control("resume", "Resume a paused import: it reads on from where it stopped, after the Account's running import if there is one, at the same pace.", "The import reads pages again.", "`curviate lead imports pause IMPORT_ID`.", "the import is not paused.");
const importsStop = control("stop", "Stop an import for good: the people found so far stay and the position is kept, so `curviate lead import --source ... --continue IMPORT_ID` reads on from there.", "The import ends; its Leads stay.", "None for this import; continue it with a new import and --continue.", "the import has finished.");

export const contactImportCommand = importCmd;
export const contactImportsCommand = defineCommand({
  meta: { name: "imports", description: "Your Team's import records." },
  subCommands: { list: importsList, get: importsGet, pause: importsPause, resume: importsResume, stop: importsStop },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(contactImportsCommand, ["curviate", "lead", "imports"]);
  },
});

void READ_SINGLE_FLAGS;
