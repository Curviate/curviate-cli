/**
 * `curviate network`: each Account's synced LinkedIn Connections, stored by
 * Curviate. `list` and `export` read the store (no LinkedIn call, no budget);
 * `status` says how far each Account's sync is; `resync` asks for a fresh walk.
 * Root-scoped: `--accounts` filters explicitly and is never filled from the
 * profile's default Account.
 */
import { defineCommand } from "citty";
import type { Curviate } from "@curviate/sdk";
import { DESCRIPTIONS } from "./descriptions.js";
import { GLOBAL_FLAGS, WRITE_SINGLE_FLAGS, readOnly } from "../lib/global-flags.js";
import { renderSuccess, writeNdjsonItem } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { streamAll, pageDelayFromFlags, readCursorFlag, readMaxPagesFlag, readablePage, rejectPaginationModifiersWithoutAll } from "../lib/paginate.js";
import { intFlag } from "../lib/int-flag.js";
import { fail, listFlag, outputOpts, rootClient, usage, type RootFlags } from "../lib/root-command.js";
import { formatRows, writeExport, type ExportFormat } from "../lib/export-file.js";
import { print, table } from "../lib/table.js";

type NetworkFlags = RootFlags & {
  accounts?: string | string[];
  query?: string;
  "include-removed"?: boolean;
  limit?: string;
  cursor?: string;
  all?: boolean;
  "max-pages"?: string;
  "page-delay"?: string;
  format?: string;
  output?: string;
  accountId?: string;
};
type Row = Record<string, unknown>;

/** The Connection item's fields, in the served order: `export`'s default columns. */
export const CONNECTION_FIELDS = [
  "account_id", "member_id", "public_identifier", "public_profile_url", "first_name", "last_name", "headline",
  "job_title", "company", "location", "profile_picture_url", "connected_at", "first_seen_at", "removed_at", "observed_at",
];

function listParams(f: NetworkFlags): Row {
  const q: Row = {};
  if (f.accounts !== undefined) q["account_id"] = listFlag("accounts", f.accounts);
  if (f.query !== undefined) q["q"] = f.query;
  if (f["include-removed"]) q["include_removed"] = true;
  return q;
}

async function runList(c: Curviate, f: NetworkFlags): Promise<void> {
  rejectPaginationModifiersWithoutAll(f, process);
  const params = listParams(f);
  if (f.limit !== undefined) params["limit"] = intFlag("limit", f.limit, 1, 1000);
  const cursor = readCursorFlag(f, process);
  if (cursor) params["cursor"] = cursor;
  try {
    if (f.all) {
      const page = (p: Row) => c.network.connections.list(p as never) as unknown as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(page, params, { maxPages: readMaxPagesFlag(f, process), out: process, pageDelayMs: pageDelayFromFlags(f) })) writeNdjsonItem(process, item, f.fields);
      return;
    }
    const page = readablePage(await c.network.connections.list(params as never)) as Row & { items: Row[] };
    if (outputOpts(f).json) return renderSuccess(page, outputOpts(f), process);
    print(table(["NAME", "HEADLINE", "ACCOUNT", "CONNECTED"], page.items.map((i) => [[i["first_name"], i["last_name"]].filter(Boolean).join(" "), i["headline"], i["account_id"], i["connected_at"] ?? i["first_seen_at"]])));
    coverageNote(page["coverage"]);
    if (page["cursor"]) print(`next page: --cursor ${String(page["cursor"])}`);
  } catch (err) {
    await fail(err, f);
  }
}

/** Empty with incomplete coverage means "not synced yet", never "no Connections". */
function coverageNote(coverage: unknown): void {
  const cov = coverage as { complete?: boolean; accounts_incomplete?: number; as_of?: string | null } | undefined;
  if (cov?.complete === false) process.stderr.write(`warning: ${cov.accounts_incomplete ?? "some"} Account(s) in scope have not finished their first sync; the list is incomplete. See \`curviate network status\`.\n`);
}

async function runStatus(c: Curviate, f: NetworkFlags): Promise<void> {
  const params: Row = {};
  if (f.accounts !== undefined) params["account_id"] = listFlag("accounts", f.accounts);
  try {
    const res = (await c.network.syncStatus(params as never)) as unknown as { items?: Row[] };
    if (outputOpts(f).json) return renderSuccess(res, outputOpts(f), process);
    const win = (w: unknown) => {
      const r = w as Row | null;
      return r ? `${r["start"]}-${r["end"]} ${r["effective_timezone"] ?? "no zone"} (${r["zone_state"]})` : null;
    };
    print(table(
      ["ACCOUNT", "STATE", "PAUSED", "STORED", "LAST FULL SYNC", "NEXT READ", "RESYNC FROM", "READ WINDOW"],
      (res.items ?? []).map((i) => [i["account_id"], i["state"], i["paused_reason"], i["connections_stored"], i["last_full_sync_at"], i["next_run_at"], i["next_manual_resync_at"], win(i["read_window"])]),
    ));
  } catch (err) {
    await fail(err, f);
  }
}

async function runExport(c: Curviate, f: NetworkFlags): Promise<void> {
  if (f.json) usage("export commands take no --json: pass --format json.");
  const format = (f.format ?? "ndjson") as ExportFormat;
  if (!["csv", "json", "ndjson"].includes(format)) usage("--format takes csv, json or ndjson.");
  const fields = f.fields === undefined ? CONNECTION_FIELDS : listFlag("fields", f.fields);
  const rows: Row[] = [];
  let first = true;
  try {
    // ponytail: buffers the whole export before writing (the 0600 rename needs it whole); stream to the temp file if networks pass ~100k.
    for (let cursor: string | null | undefined; first || cursor; first = false) {
      const page = readablePage(await c.network.connections.list({ ...listParams(f), limit: 1000, ...(cursor ? { cursor } : {}) } as never)) as Row & { items: Row[] };
      if (first) coverageNote(page["coverage"]);
      rows.push(...page.items);
      cursor = page["cursor"] as string | null | undefined;
    }
    await writeExport(f.output, formatRows(rows, fields, format));
  } catch (err) {
    await fail(err, f);
  }
  process.stderr.write(`${rows.length} Connections exported.\n`);
}

async function runResync(c: Curviate, f: NetworkFlags): Promise<void> {
  if ((f.accountId === undefined) === !f.all) usage("name one Account (`curviate network resync <account_id>`) or pass --all for every Account you may operate, not both.");
  const body = f.accountId === undefined ? {} : { account_id: f.accountId };
  if (f.preview) return print(JSON.stringify(buildPreviewOutput({ method: "network.resync", args: {}, body })));
  try {
    renderSuccess(await c.network.resync(body as never), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

// ---------------------------------------------------------------------------
// citty definitions
// ---------------------------------------------------------------------------

const online = (fn: (c: Curviate, f: NetworkFlags) => Promise<void>) => async ({ args }: { args: unknown }) => {
  const f = args as NetworkFlags;
  await fn(await rootClient(f), f);
};

const FILTERS = {
  accounts: { type: "string" as const, description: "Only these Accounts: a comma list of ids (acc_...). Never filled from your profile's default Account." },
  query: { type: "string" as const, description: "Name or headline contains this text (3 to 100 characters)." },
  "include-removed": { type: "boolean" as const, description: "Also list Connections that have left (removed_at set)." },
};

const listCmd = defineCommand({
  meta: {
    name: "list",
    description:
      "List the stored Connections of the Accounts you may operate, newest first: one item per Account and person. Read from Curviate's store: no LinkedIn call, no budget. " +
      "An empty list with incomplete coverage means not synced yet, never no Connections.",
    risk: "read",
    output: ["A table of name, headline, Account and connection time; --json (or piped) prints the API page with `coverage`."],
    seeAlso: ["curviate network status", "curviate network export"],
    examples: ["curviate network list", "curviate network list --query founder --accounts acc_YOUR_ACCOUNT_ID"],
  },
  args: { ...readOnly(GLOBAL_FLAGS), ...FILTERS },
  run: online(runList),
});

const statusCmd = defineCommand({
  meta: {
    name: "status",
    description: "How far each Account's Connection sync is: state, why it is paused, Connections stored, the last full sync, the next read, when a manual resync is allowed again, and the read window.",
    risk: "read",
    examples: ["curviate network status", "curviate network status --accounts acc_YOUR_ACCOUNT_ID"],
  },
  args: { ...readOnly(WRITE_SINGLE_FLAGS), accounts: FILTERS.accounts },
  run: online(runStatus),
});

const exportCmd = defineCommand({
  meta: {
    name: "export",
    description:
      "Export the stored Connections, every page, with the list filters. Writes ndjson (default), json or csv to stdout or a file (mode 0600). " +
      "A count goes to stderr, and a warning when an Account in scope has not finished its first sync (exit 0).",
    risk: "read",
    output: ["Data only on stdout or the --output file; the count and warnings on stderr. CSV is UTF-8 with a BOM; a cell starting with = + - @ or ' gets a leading '."],
    examples: ["curviate network export --format csv -o connections.csv", "curviate network export --accounts acc_YOUR_ACCOUNT_ID --fields first_name,last_name,public_profile_url"],
  },
  args: {
    "api-key": GLOBAL_FLAGS["api-key"],
    profile: GLOBAL_FLAGS.profile,
    team: GLOBAL_FLAGS.team,
    "base-url": GLOBAL_FLAGS["base-url"],
    timeout: GLOBAL_FLAGS.timeout,
    ...FILTERS,
    format: { type: "string" as const, description: "csv, json or ndjson (default ndjson)." },
    output: { type: "string" as const, alias: "o", description: "File to write (mode 0600; replaced only when the export completes), or - for stdout (default)." },
    fields: { type: "string" as const, description: `Columns, comma-separated, in order (default: ${CONNECTION_FIELDS.join(", ")}).` },
    json: { type: "boolean" as const, description: "Not taken by exports: pass --format json." },
  },
  run: online(runExport),
});

const resyncCmd = defineCommand({
  meta: {
    name: "resync",
    description:
      "Start a fresh walk of an Account's Connections now, or of every Account you may operate with --all. Once per Account per day; pages are read inside the Account's read window. " +
      "Answers queued, cooldown, in_progress or paused per Account: answers, not errors. Needs Automate.",
    risk: "high",
    rules: {
      changes: "Opens a sync walk; Curviate reads the Account's Connections from LinkedIn over the next hours.",
      visible_to: "Nobody: reads only.",
      budget_rows: ["connections_sync"],
      retry: "A second call within the same day answers cooldown; nothing new starts.",
      undo: "Cannot be stopped once queued; the walk ends on its own.",
      blast_radius: "One Account, or with --all every Account you may operate.",
    },
    errors: { ACCOUNT_NOT_FOUND: "the Account is not in your Team.", INSUFFICIENT_ROLE: "your role cannot operate the Account.", ACCOUNT_NOT_SHARED: "the Account is not shared with you.", TIER_REQUIRED: "your plan does not include Network." },
    seeAlso: ["curviate network status"],
    examples: ["curviate network resync --all", "curviate network resync acc_YOUR_ACCOUNT_ID"],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    accountId: { type: "positional" as const, required: false, description: "The Account to resync (acc_...). Omit it with --all." },
    all: { type: "boolean" as const, description: "Resync every Account you may operate." },
  },
  run: online(runResync),
});

export const networkCommand = defineCommand({
  meta: { name: "network", description: DESCRIPTIONS.network },
  subCommands: { list: listCmd, status: statusCmd, export: exportCmd, resync: resyncCmd },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(networkCommand, ["curviate", "network"]);
  },
});
