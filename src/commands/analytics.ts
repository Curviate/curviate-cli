/**
 * `curviate analytics`: Motion outcomes and the budget your Accounts used,
 * read from what Curviate recorded (no LinkedIn call). `get` is the overview
 * (`--motion` one Motion's, `--view activity` the core budget use); `events
 * list` the feed behind the numbers; `export` the tables as a file, streamed
 * now or built by a background job (`--job`, then `curviate export`).
 * Shared with `account overview`: the window and filter flags.
 */
import { defineCommand } from "citty";
import type { Curviate } from "@curviate/sdk";
import { DESCRIPTIONS } from "./descriptions.js";
import { GLOBAL_FLAGS, READ_SINGLE_FLAGS, readOnly } from "../lib/global-flags.js";
import { renderSuccess, writeNdjsonItem } from "../lib/output.js";
import { streamAll, pageDelayFromFlags, readCursorFlag, readMaxPagesFlag, readablePage, rejectPaginationModifiersWithoutAll } from "../lib/paginate.js";
import { intFlag } from "../lib/int-flag.js";
import { fail, listFlag, outputOpts, rootClient, usage, type RootFlags } from "../lib/root-command.js";
import { downloadBinary } from "../lib/client.js";
import { writeExport } from "../lib/export-file.js";
import { print, rate, table } from "../lib/table.js";

export type AnalyticsFlags = RootFlags & {
  view?: string;
  motion?: string;
  motions?: string | string[];
  accounts?: string | string[];
  from?: string;
  to?: string;
  range?: string;
  timezone?: string;
  bucket?: string;
  origin?: string | string[];
  include?: string;
  sort?: string;
  limit?: string;
  compare?: string;
  version?: string;
  step?: string;
  kind?: string;
  contact?: string;
  cursor?: string;
  all?: boolean;
  "max-pages"?: string;
  "page-delay"?: string;
  table?: string;
  format?: string;
  output?: string;
  job?: boolean;
  accountId?: string;
};
type Row = Record<string, unknown>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The window: `--from`/`--to` dates or `--range`, read in `--timezone`, grouped by `--bucket`. */
export function windowParams(f: AnalyticsFlags): Row {
  const q: Row = {};
  for (const k of ["from", "to"] as const) {
    const v = f[k];
    if (v === undefined) continue;
    if (!DATE.test(v)) usage(`--${k} takes a date, YYYY-MM-DD.`);
    q[k] = v;
  }
  if (f.range !== undefined) q["range"] = f.range;
  if (f.timezone !== undefined) q["timezone"] = f.timezone;
  if (f.bucket !== undefined) q["bucket"] = f.bucket;
  return q;
}

/** The overview grammar: which sections, their order and cut, and the previous-period comparison. */
export function grammarParams(f: AnalyticsFlags): Row {
  const q: Row = {};
  if (f.include !== undefined) q["include"] = listFlag("include", f.include);
  if (f.sort !== undefined) q["sort"] = listFlag("sort", f.sort);
  if (f.limit !== undefined) q["limit"] = intFlag("limit", f.limit);
  if (f.compare !== undefined) q["compare"] = f.compare;
  return q;
}

/** `--motions`, `--accounts`, `--origin`: each a comma list (or repeated). */
function filterParams(f: AnalyticsFlags, keys: Array<"motions" | "accounts" | "origin">): Row {
  const q: Row = {};
  if (keys.includes("motions") && f.motions !== undefined) q["motion_id"] = listFlag("motions", f.motions);
  if (keys.includes("accounts") && f.accounts !== undefined) q["account_id"] = listFlag("accounts", f.accounts);
  if (keys.includes("origin") && f.origin !== undefined) q["origin"] = listFlag("origin", f.origin);
  return q;
}

// ---------------------------------------------------------------------------
// Human rendering: compact tables, --json is the body
// ---------------------------------------------------------------------------

const outcomes = (s: Row | undefined) =>
  `acceptance ${rate(s?.["acceptance"], "accepted", "sent")} · reply ${rate(s?.["reply"], "replied", "messaged")} · InMail reply ${rate(s?.["inmail_reply"], "replied", "inmailed")} · replies ${s?.["replies"] ?? "-"}`;

const rowsTable = (label: string, id: string, name: string, items: unknown) =>
  Array.isArray(items) && items.length
    ? table([label, "NAME", "ACCEPTANCE", "REPLY", "INMAIL REPLY", "REPLIES"],
      (items as Row[]).map((r) => [r[id], r[name], rate(r["acceptance"], "accepted", "sent"), rate(r["reply"], "replied", "messaged"), rate(r["inmail_reply"], "replied", "inmailed"), r["replies"]]))
    : null;

const reasons = (r: unknown) =>
  Object.entries((r ?? {}) as Record<string, Record<string, number>>)
    .flatMap(([k, m]) => Object.entries(m ?? {}).map(([code, n]) => `${k} ${code} ${n}`))
    .join(", ");

/** The window line, plus where daily detail and the path split stop. */
function windowLines(body: Row): string[] {
  const w = (body["window"] ?? {}) as Row;
  const lines = [`${w["from"]} to ${w["to"]} (${w["timezone"]})`];
  if (w["counts_only_through"]) lines.push(`daily counts only through ${w["counts_only_through"]}: step, variant and seen detail covers the days after it`);
  return lines;
}

/** The overview bodies (Team, one Motion, one Account) as compact tables. Exported for `account overview`. */
export function renderOverview(body: Row): void {
  const out: Array<string | null> = [...windowLines(body)];
  const profile = body["profile"] as Row | undefined;
  if (profile) out.push(`${profile["name"]} · ${profile["status"]}${profile["status_reason"] ? ` (${profile["status_reason"]})` : ""}`);
  const metrics = body["metrics"] as Row | undefined;
  if (metrics) out.push(`connections ${metrics["connections"]} · followers ${metrics["followers"]} · profile viewers 90d ${metrics["profile_viewers_90d"]} · search appearances ${metrics["search_appearances_week"]} (as of ${metrics["as_of"]})`);
  const s = (body["totals"] ?? body["performance"]) as Row | undefined;
  if (s) out.push(outcomes(s));
  const steps = body["steps"] as Row[] | undefined;
  if (Array.isArray(steps) && steps.length) {
    out.push(table(["STEP", "ACTION", "EXECUTED", "SKIPPED", "FAILED", "ACCEPTANCE", "REPLY", "SEEN"],
      steps.map((t) => [t["step_id"], t["action"] ?? t["kind"], t["executed"], t["skipped"], t["failed"], rate(t["acceptance"], "accepted", "sent"), rate(t["reply"], "replied", "messaged"), rate(t["seen"], "seen", "sent")])));
    for (const t of steps) if (reasons(t["reasons"])) out.push(`  ${t["step_id"]}: ${reasons(t["reasons"])}`);
  }
  const paths = body["paths"] as Row[] | undefined;
  if (Array.isArray(paths) && paths.length) {
    out.push(table(["PATH", "ACCEPTANCE", "REPLY", "INMAIL REPLY", "REPLIES"],
      paths.map((p) => { const t = (p["totals"] ?? {}) as Row; return [p["path"], rate(t["acceptance"], "accepted", "sent"), rate(t["reply"], "replied", "messaged"), rate(t["inmail_reply"], "replied", "inmailed"), t["replies"]]; })));
    const through = (body["window"] as Row | undefined)?.["paths_through"];
    if (through) out.push(`paths cover days after ${through}`);
  }
  const limits = (body["limits"] as Row | undefined)?.["rows"];
  if (Array.isArray(limits) && limits.length) out.push(table(["BUDGET ROW", "USED", "CEILING", "LEFT"], (limits as Row[]).map((r) => [r["budget_row"], r["used"], r["effective_ceiling"], r["remaining"]])));
  out.push(rowsTable("MOTION", "motion_id", "name", body["motions"]));
  out.push(rowsTable("ACCOUNT", "account_id", "account_name", body["accounts"]));
  for (const fl of (body["flags"] ?? []) as Row[]) out.push(`${fl["code"]}: ${fl["message"]}${fl["next"] ? ` (${fl["next"]})` : ""}`);
  print(out.filter((x): x is string => !!x).join("\n"));
}

function renderActivity(body: Row): void {
  const out = [...windowLines(body), table(["BUDGET ROW", "USED", "FAILED", "REFUSED"], ((body["types"] ?? []) as Row[]).map((t) => [t["budget_row"], t["used"], t["failed"], t["refused"]]))];
  for (const a of (body["accounts"] ?? []) as Row[]) out.push(`${a["account_name"] ?? a["account_id"]}: ${((a["types"] ?? []) as Row[]).map((t) => `${t["budget_row"]} ${t["used"]}`).join(", ")}`);
  print(out.join("\n"));
}

// ---------------------------------------------------------------------------
// Run functions
// ---------------------------------------------------------------------------

async function runGet(c: Curviate, f: AnalyticsFlags): Promise<void> {
  const view = f.view ?? "motions";
  if (view !== "motions" && view !== "activity") usage("--view takes motions or activity.");
  if (view === "activity") {
    const motionOnly = (["motion", "motions", "origin", "include", "sort", "limit", "compare", "version"] as const).find((k) => f[k] !== undefined);
    if (motionOnly) usage(`--${motionOnly} reads Motions: --view activity takes the window and --accounts only.`);
  }
  if (f.version !== undefined && f.motion === undefined) usage("--version needs --motion.");
  const q = { ...windowParams(f), ...filterParams(f, view === "activity" ? ["accounts"] : ["accounts", "origin"]) };
  try {
    if (view === "activity") {
      const body = (await c.analytics.activity(q as never)) as unknown as Row;
      return outputOpts(f).json ? renderSuccess(body, outputOpts(f), process) : renderActivity(body);
    }
    Object.assign(q, grammarParams(f));
    if (f.version !== undefined) q["version"] = intFlag("version", f.version);
    let body: Row;
    if (f.motion !== undefined) body = (await c.analytics.motions.get(f.motion, q as never)) as unknown as Row;
    else body = (await c.analytics.motions.list({ ...q, ...filterParams(f, ["motions"]) } as never)) as unknown as Row;
    return outputOpts(f).json ? renderSuccess(body, outputOpts(f), process) : renderOverview(body);
  } catch (err) {
    await fail(err, f);
  }
}

async function runEvents(c: Curviate, f: AnalyticsFlags): Promise<void> {
  rejectPaginationModifiersWithoutAll(f, process);
  if (f.step !== undefined && f.motion === undefined) usage("--step needs --motion: a step id names a step of one Motion.");
  const q: Row = { ...filterParams(f, ["origin"]) };
  if (f.motion !== undefined) q["motion_id"] = f.motion;
  if (f.step !== undefined) q["step_id"] = f.step;
  if (f.contact !== undefined) q["contact_id"] = f.contact;
  if (f.accounts !== undefined) q["account_id"] = listFlag("accounts", f.accounts).join(",");
  if (f.kind !== undefined) q["kind"] = listFlag("kind", f.kind);
  if (f.limit !== undefined) q["limit"] = intFlag("limit", f.limit, 1, 100);
  const cursor = readCursorFlag(f, process);
  if (cursor) q["cursor"] = cursor;
  try {
    if (f.all) {
      const page = (p: Row) => c.analytics.events.list(p as never) as unknown as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(page, q, { maxPages: readMaxPagesFlag(f, process), out: process, pageDelayMs: pageDelayFromFlags(f) })) writeNdjsonItem(process, item, f.fields);
      return;
    }
    const page = readablePage(await c.analytics.events.list(q as never)) as Row & { items: Row[] };
    if (outputOpts(f).json) return renderSuccess(page, outputOpts(f), process);
    print(table(["AT", "KIND", "ORIGIN", "MOTION", "STEP", "OUTCOME", "REASON", "CONTACT"],
      page.items.map((e) => [e["occurred_at"], e["kind"], e["origin"], e["motion_name"], e["step_id"], e["outcome"], e["reason"] ? `${e["reason"]}: ${e["reason_message"] ?? ""}` : null, (e["contact"] as Row | null)?.["full_name"]])));
    if (page["cursor"]) print(`next page: --cursor ${String(page["cursor"])}`);
  } catch (err) {
    await fail(err, f);
  }
}

const ANALYTICS_TABLES = ["daily", "accounts", "motions", "enrollments"];
const JOB_ENTITIES = ["motion_activity", "account_activity", "account_metrics"];

async function runExport(c: Curviate, f: AnalyticsFlags): Promise<void> {
  if (f.json) usage("export commands take no --json: pass --format json.");
  const tables = f.table === undefined ? [] : listFlag("table", f.table);
  const entity = tables.length === 1 && JOB_ENTITIES.includes(tables[0]!) ? tables[0]! : "analytics";
  if (entity !== "analytics" && !f.job) usage(`--table ${entity} is built by a background job: add --job.`);
  const unknown = tables.find((t) => !ANALYTICS_TABLES.includes(t) && t !== entity);
  if (unknown !== undefined) usage(`--table takes ${ANALYTICS_TABLES.join(", ")}, or one of ${JOB_ENTITIES.join(", ")} with --job.`);
  const format = f.format ?? "csv";
  const filters = { ...windowParams(f), ...filterParams(f, ["motions", "accounts", "origin"]) };
  try {
    if (f.job) {
      const exp = (await c.exports.create({ entity, tables: tables.length ? tables : ANALYTICS_TABLES, format, filters } as never)) as unknown as Row;
      renderSuccess(exp, outputOpts(f), process);
      process.stderr.write(`Export ${exp["id"]} is ${exp["status"]}. Read it with \`curviate export get ${exp["id"]}\`, then \`curviate export download ${exp["id"]} -o <file>\` once ready.\n`);
      return;
    }
    if (f.output === undefined && process.stdout.isTTY && tables.length !== 1) usage("several tables come as one ZIP file: pass -o <file>, or one --table.");
    const bytes = await downloadBinary(() => c.analytics.export({ ...filters, format, ...(tables.length ? { table: tables } : {}) } as never));
    await writeExport(f.output, new Uint8Array(bytes as ArrayBuffer));
  } catch (err) {
    await fail(err, f);
  }
}

// ---------------------------------------------------------------------------
// citty definitions
// ---------------------------------------------------------------------------

const online = (fn: (c: Curviate, f: AnalyticsFlags) => Promise<void>) => async ({ args }: { args: unknown }) => {
  const f = args as AnalyticsFlags;
  await fn(await rootClient(f), f);
};

/** The window flags, shared with `account overview` and `account metrics`. */
export const WINDOW_ARGS = {
  from: {
    type: "string" as const,
    description:
      "First day, YYYY-MM-DD, inclusive, in --timezone. A Motion read (with or without --motion) or an Account overview may start more than a year back: " +
      "up to `window.counts_only_through` the figures come from daily counts (UTC days, no step, variant or seen detail), and `paths` cover only the days after `window.paths_through`. " +
      "--view activity and the activity exports keep their own cap, named in the refusal.",
  },
  to: { type: "string" as const, description: "Last day, YYYY-MM-DD, inclusive, in --timezone (default today). Same rules as --from." },
  range: { type: "string" as const, description: "Instead of --from/--to: 7d, 30d, 90d, 12m or all." },
  timezone: { type: "string" as const, description: "IANA zone the days are read in (default UTC)." },
  bucket: { type: "string" as const, description: "Daily series grouping: auto, day, week or month." },
};
const FILTER_ARGS = {
  accounts: { type: "string" as const, description: "Only these Accounts: a comma list of ids (acc_...). Never filled from your profile's default Account." },
  origin: { type: "string" as const, description: "Who sent the actions: a comma list of motion, unibox, api; direct is an alias for unibox and api." },
};
export const GRAMMAR_ARGS = {
  include: { type: "string" as const, description: "Sections to return, comma list (for example performance,motions,accounts,steps,variants,paths,flags)." },
  sort: { type: "string" as const, description: "Order of the Motion and Account lists, comma list of sent, acceptance.rate, reply.rate, inmail_reply.rate, last_activity_at, name; a leading - sorts descending." },
  limit: { type: "string" as const, description: "How many Motions and Accounts to return." },
  compare: { type: "string" as const, description: "previous_period: add the same number of days before --from to every rate (`previous`, `delta`)." },
};

const getCmd = defineCommand({
  meta: {
    name: "get",
    description:
      "Motion outcomes over a window: invitations, acceptance, messages, reply and InMail reply as outcomes so far, with each Motion and Account. " +
      "With --motion: one Motion's steps, paths and Accounts. With --view activity: the budget rows your Accounts used. Each Contact counts once per Account.",
    risk: "read",
    output: [
      "acceptance: invitations accepted over invitations sent in the window, so far.",
      "reply: people who replied over people messaged; InMail reply the same for InMails. Rates move as replies and acceptances arrive; `maturing` counts what was sent under 7 days ago and `low_sample` marks fewer than 30.",
      "seen (--motion): messages read or replied over messages sent, per message step.",
      "A compact table by default; --json (or piped) prints the API body.",
    ],
    seeAlso: ["curviate analytics events list", "curviate account overview", "Judgement on reading the numbers: https://github.com/curviate/curviate-plugin"],
    examples: [
      "curviate analytics get --range 30d",
      "curviate analytics get --motion mot_YOUR_MOTION_ID --include steps,paths --range 90d",
      "curviate analytics get --view activity --from 2026-10-01 --to 2026-10-28",
    ],
  },
  args: {
    ...readOnly(READ_SINGLE_FLAGS),
    view: { type: "string" as const, description: "motions (default): Motion outcomes; activity: budget rows used, not with --motion." },
    motion: { type: "string" as const, description: "One Motion (mot_...): its steps, paths and Accounts." },
    motions: { type: "string" as const, description: "Without --motion: only these Motions, comma list (mot_...)." },
    version: { type: "string" as const, description: "With --motion: only this Sequence version." },
    ...WINDOW_ARGS,
    ...FILTER_ARGS,
    ...GRAMMAR_ARGS,
  },
  run: online(runGet),
});

const eventsListCmd = defineCommand({
  meta: {
    name: "list",
    description: "The records behind the numbers, newest first: steps executed or failed, invitations accepted, replies; each reason with its sentence. Metadata only, never message text.",
    risk: "read",
    examples: [
      "curviate analytics events list --motion mot_YOUR_MOTION_ID --step opener",
      "curviate analytics events list --contact con_YOUR_CONTACT_ID --origin unibox,api --all",
    ],
  },
  args: {
    ...readOnly(GLOBAL_FLAGS),
    motion: { type: "string" as const, description: "Only this Motion's records (mot_...)." },
    step: { type: "string" as const, description: "With --motion: only this step's records." },
    contact: { type: "string" as const, description: "Only this Contact's records (con_...): its Motion records and its direct ones." },
    kind: { type: "string" as const, description: "Comma list of step.executed, step.failed, invite.accepted, message.replied." },
    accounts: FILTER_ARGS.accounts,
    origin: FILTER_ARGS.origin,
  },
  run: online(runEvents),
});

const exportCmd = defineCommand({
  meta: {
    name: "export",
    description:
      "Export the Analytics tables (daily, accounts, motions, enrollments) under the same window and filters: streamed now, or with --job built in the background " +
      "(then `curviate export get` and `curviate export download`). One table is one file; several are one ZIP. Never message text. Owners and Managers only.",
    risk: "read",
    output: ["Data only on stdout or the --output file (mode 0600); with --job the export record."],
    errors: { INSUFFICIENT_ROLE: "Members cannot export: ask an Owner or Manager.", EXPORT_IN_PROGRESS: "your Team already has an export running; read it with `curviate export get <export_id>`." },
    seeAlso: ["curviate export get", "curviate export download"],
    examples: [
      "curviate analytics export --table enrollments --format csv --range 30d -o enrollments.csv",
      "curviate analytics export --table daily,accounts,motions,enrollments --format csv --range 90d --job",
    ],
  },
  args: {
    "api-key": GLOBAL_FLAGS["api-key"],
    profile: GLOBAL_FLAGS.profile,
    team: GLOBAL_FLAGS.team,
    "base-url": GLOBAL_FLAGS["base-url"],
    timeout: GLOBAL_FLAGS.timeout,
    table: { type: "string" as const, description: "Comma list of daily, accounts, motions, enrollments (default all four); or, with --job, one of motion_activity, account_activity, account_metrics." },
    format: { type: "string" as const, description: "csv (default), json or ndjson (ndjson takes one table)." },
    output: { type: "string" as const, alias: "o", description: "File to write (mode 0600), or - for stdout (default)." },
    job: { type: "boolean" as const, description: "Build it in the background and print the export record instead of streaming it." },
    motions: { type: "string" as const, description: "Only these Motions, comma list (mot_...)." },
    ...WINDOW_ARGS,
    ...FILTER_ARGS,
    json: { type: "boolean" as const, description: "Not taken by exports: pass --format json." },
  },
  run: online(runExport),
});

const eventsCommand = defineCommand({
  meta: { name: "events", description: "The records behind the analytics numbers." },
  subCommands: { list: eventsListCmd },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(eventsCommand, ["curviate", "analytics", "events"]);
  },
});

export const analyticsCommand = defineCommand({
  meta: { name: "analytics", description: DESCRIPTIONS.analytics },
  subCommands: {
    get: getCmd,
    events: eventsCommand,
    export: exportCmd,
  },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(analyticsCommand, ["curviate", "analytics"]);
  },
});
