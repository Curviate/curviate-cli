/**
 * `curviate company`: your Team's own record of a company, by LinkedIn's
 * numeric company id. Stored data only (`curviate.companies.*`): no LinkedIn
 * call. The LinkedIn company page itself is `curviate core company`.
 */
import { defineCommand } from "citty";
import type { Curviate } from "@curviate/sdk";
import { DESCRIPTIONS } from "./descriptions.js";
import { READ_SINGLE_FLAGS, WRITE_SINGLE_FLAGS, readOnly } from "../lib/global-flags.js";
import { renderSuccess } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { readableObject } from "../lib/paginate.js";
import { fail, listFlag, outputOpts, rootClient, usage, type RootFlags } from "../lib/root-command.js";
import { readFileFlag } from "../lib/document.js";
import { csvRecords } from "./contact-import.js";

type Flags = RootFlags & { id?: string; set?: string | string[]; unset?: string | string[]; file?: string };

/** The most companies one file may set: one request each, sequential. */
const FILE_MAX_COMPANIES = 1000;

/** One CSV record's cells: commas outside quotes split, `""` inside quotes is a quote. */
function csvCells(record: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < record.length; i++) {
    const ch = record[i]!;
    if (ch === '"') {
      if (quoted && record[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/** A JSON value (a number, true, a list) is stored as JSON, anything else as text: the --set rule. */
const cellValue = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

/** `--file`: header `company_id,<key>,...`; each row one company, a non-empty cell sets its key, an empty one leaves it. */
export function companyRows(text: string): Array<{ id: string; extra: Record<string, unknown> }> {
  const [header, ...rows] = csvRecords(text);
  const cols = csvCells(header ?? "");
  if (cols[0] !== "company_id") usage("--file: the first column is company_id (LinkedIn's numeric company id), then one column per field key.");
  const keys = cols.slice(1);
  const badKey = keys.find((k) => !KEY.test(k));
  if (!keys.length || badKey !== undefined) usage(`--file: each field column is a key of 1 to 64 letters, digits or _${badKey !== undefined ? ` (got ${JSON.stringify(badKey)})` : ""}.`);
  if (new Set(keys).size !== keys.length) usage("--file: a key appears twice in the header.");
  if (rows.length > FILE_MAX_COMPANIES) usage(`--file: at most ${FILE_MAX_COMPANIES} companies a file (one request each); split it.`);
  const seen = new Set<string>();
  return rows.map((r, n) => {
    const cells = csvCells(r);
    const id = cells[0] ?? "";
    if (!/^\d+$/.test(id)) usage(`--file line ${n + 2}: company_id must be LinkedIn's numeric company id.`);
    if (seen.has(id)) usage(`--file line ${n + 2}: company ${id} appears twice.`);
    seen.add(id);
    const extra: Record<string, unknown> = {};
    keys.forEach((k, i) => {
      const raw = cells[i + 1] ?? "";
      if (raw !== "") extra[k] = cellValue(raw);
    });
    if (!Object.keys(extra).length) usage(`--file line ${n + 2}: no field to set for company ${id}.`);
    return { id, extra };
  });
}

const KEY = /^[A-Za-z0-9_]{1,64}$/;
const companyId = (f: Flags) => {
  const id = String(f.id ?? "").trim();
  if (!/^\d+$/.test(id)) usage("the company id is LinkedIn's numeric company id (the `id` of `curviate core company <handle>`), for example 1234567.");
  return id;
};

/** `--set key=value` (a JSON value is parsed, anything else is text) and `--unset key`, into one `extra` merge. */
function extraBody(f: Flags): { extra: Record<string, unknown> } {
  const extra: Record<string, unknown> = {};
  for (const pair of listFlag("set", f.set)) {
    const eq = pair.indexOf("=");
    const k = eq < 0 ? "" : pair.slice(0, eq);
    if (!KEY.test(k)) usage("--set takes key=value; the key is 1 to 64 letters, digits or _.");
    const raw = pair.slice(eq + 1);
    if (raw === "") usage(`--set ${k}=: an empty value is refused; use --unset ${k} to remove the key.`);
    let v: unknown = raw;
    try {
      v = JSON.parse(raw);
    } catch {
      /* text */
    }
    extra[k] = v;
  }
  for (const k of listFlag("unset", f.unset)) {
    if (!KEY.test(k)) usage("--unset takes a key: 1 to 64 letters, digits or _.");
    extra[k] = null;
  }
  if (!Object.keys(extra).length) usage("pass --set key=value or --unset key, at least one.");
  return { extra };
}

const online = (fn: (c: Curviate, f: Flags) => Promise<void>) => async ({ args }: { args: unknown }) => {
  const f = args as Flags;
  await fn(await rootClient(f), f);
};

const ID = { type: "positional" as const, description: "LinkedIn's numeric company id, for example 1234567." };

const getCmd = defineCommand({
  meta: {
    name: "get",
    description:
      "What your Team holds for one company: the stored record (name, industry, website, size, headcount growth, location, read_at; all null when it was never read) and your own company fields. " +
      "No LinkedIn call, no budget. Every role may read it.",
    risk: "read",
    seeAlso: ["curviate company fields", "curviate core company"],
    errors: { RESOURCE_NOT_FOUND: "no Lead of your Team works at this company and your Team never read it." },
    examples: ["curviate company get 1234567"],
  },
  args: { ...readOnly(READ_SINGLE_FLAGS), id: ID },
  run: online(async (c, f) => {
    const id = companyId(f);
    try {
      renderSuccess(readableObject(await c.companies.get(id)), outputOpts(f), process);
    } catch (err) {
      await fail(err, f);
    }
  }),
});

const fieldsCmd = defineCommand({
  meta: {
    name: "fields",
    description:
      "Set or remove your Team's own fields for one company, merged by key: set once for every Lead who works there and read in a Sequence as {{company.extra.<key>}}. " +
      "Keys left out stay. At most 100 keys and 32 KiB once merged. --file sets many companies from a CSV (header company_id, then one column per key; an empty cell leaves that key): " +
      "one request per company, in file order; it stops at the first refusal, and the companies before it are set.",
    risk: "write",
    rules: {
      changes: "The company's fields in your Team; every Campaign text using {{company.extra.<key>}} reads the new value from its next send.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "Safe to repeat: the same values again.",
      undo: "Run it again with the previous values, or --unset the key.",
    },
    errors: { RESOURCE_NOT_FOUND: "no Lead of your Team works at this company and your Team never read it.", INVALID_REQUEST: "a key outside the pattern, or the fields would pass 100 keys or 32 KiB once merged." },
    seeAlso: ["curviate company get", "curviate campaign lint"],
    examples: ["curviate company fields 1234567 --set tier=A --set owner=\"Ana Lopez\"", "curviate company fields 1234567 --unset owner", "curviate company fields --file companies.csv"],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    id: { ...ID, required: false, description: "LinkedIn's numeric company id, for example 1234567. Not with --file." },
    set: { type: "string" as const, description: "key=value, repeatable. A JSON value (a number, true, a list) is stored as JSON, anything else as text." },
    unset: { type: "string" as const, description: "A key to remove, repeatable or a comma list." },
    file: { type: "string" as const, stdinArg: true, description: "A CSV of many companies: a path, or - for stdin. Header company_id, then one column per key. Not with an id, --set or --unset." },
  },
  run: async ({ args }: { args: unknown }) => {
    const f = args as Flags;
    if (f.file !== undefined) {
      if (f.id !== undefined || f.set !== undefined || f.unset !== undefined) usage("--file sets companies from the file: pass no company id, --set or --unset with it.");
      const rows = companyRows(await readFileFlag("file", f.file, { others: f as Record<string, unknown> }));
      if (!rows.length) usage("--file holds no company row.");
      if (f.preview) return void process.stdout.write(JSON.stringify(buildPreviewOutput({ method: "companies.update", args: { company_ids: rows.map((r) => r.id) }, body: { extra: rows[0]!.extra } })) + "\n");
      const c = await rootClient(f);
      const done: unknown[] = [];
      for (const r of rows) {
        try {
          done.push(readableObject(await c.companies.update(r.id, { extra: r.extra })));
        } catch (err) {
          process.stderr.write(`Stopped at company ${r.id}; the ${done.length} before it are set.\n`);
          return void (await fail(err, f));
        }
      }
      return renderSuccess({ object: "list", items: done }, outputOpts(f), process);
    }
    const id = companyId(f);
    const body = extraBody(f);
    if (f.preview) return void process.stdout.write(JSON.stringify(buildPreviewOutput({ method: "companies.update", args: { company_id: id }, body })) + "\n");
    const c = await rootClient(f);
    try {
      renderSuccess(readableObject(await c.companies.update(id, body)), outputOpts(f), process);
    } catch (err) {
      await fail(err, f);
    }
  },
});

export const companyRecordCommand = defineCommand({
  meta: { name: "company", description: DESCRIPTIONS.companyRecord },
  subCommands: { get: getCmd, fields: fieldsCmd },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(companyRecordCommand, ["curviate", "company"]);
  },
});
