/**
 * `curviate signal`: the Signal stream of the Accounts you may operate, each
 * Account's Signal watch, the Team's follow-up settings, and Signal rules.
 * Root-scoped (`curviate.signals.*`); every read is Curviate's own store.
 */
import { defineCommand } from "citty";
import type { Curviate } from "@curviate/sdk";
import { DESCRIPTIONS } from "./descriptions.js";
import { GLOBAL_FLAGS, READ_SINGLE_FLAGS, WRITE_SINGLE_FLAGS, readOnly } from "../lib/global-flags.js";
import { renderSuccess, writeNdjsonItem } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { streamAll, pageDelayFromFlags, readCursorFlag, readMaxPagesFlag, readableObject, readablePage, rejectPaginationModifiersWithoutAll } from "../lib/paginate.js";
import { intFlag } from "../lib/int-flag.js";
import { fail, listFlag, outputOpts, rootClient, usage, type RootFlags } from "../lib/root-command.js";
import { print, table } from "../lib/table.js";

type Flags = RootFlags & {
  id?: string;
  kind?: string | string[];
  "account-id"?: string;
  match?: string;
  listed?: boolean;
  since?: string;
  enabled?: boolean;
  name?: string;
  accounts?: string | string[];
  "all-accounts"?: boolean;
  "add-to-list"?: string;
  "send-event"?: boolean;
  "unknown-people"?: string;
  on?: boolean;
  off?: boolean;
  "post-engaged"?: string;
  "profile-viewed"?: string;
  limit?: string;
  cursor?: string;
  all?: boolean;
  "max-pages"?: string;
  "page-delay"?: string;
};
type Row = Record<string, unknown>;
type Page = { items?: unknown[]; cursor?: string | null };

const KINDS = ["post_engaged", "post_reposted", "network_posted", "profile_viewed", "followed_you", "mentioned_you", "connection_added", "post_engaged.reaction", "post_engaged.comment"];
const MATCHES = ["lead", "connection", "followed", "unknown", "anonymous"];

const online = (fn: (c: Curviate, f: Flags) => Promise<void>) => async ({ args }: { args: unknown }) => {
  const f = args as Flags;
  await fn(await rootClient(f), f);
};
const preview = (method: string, args: Row, body: unknown) => process.stdout.write(JSON.stringify(buildPreviewOutput({ method, args, body: body as Row })) + "\n");
const nonEmpty = (what: string, v: string | undefined) => (v !== undefined && v.trim() !== "" ? v : usage(`${what} is required.`));

/** One page, or every page as NDJSON with --all. */
async function paged(f: Flags, params: Row, fetch: (p: Row) => Promise<unknown>, human: (items: Row[]) => void): Promise<void> {
  rejectPaginationModifiersWithoutAll(f, process);
  if (f.limit !== undefined) params["limit"] = intFlag("limit", f.limit, 1, 100);
  const cursor = readCursorFlag(f, process);
  if (cursor) params["cursor"] = cursor;
  if (f.all) {
    for await (const item of streamAll((p) => fetch(p) as Promise<Page>, params, { maxPages: readMaxPagesFlag(f, process), out: process, pageDelayMs: pageDelayFromFlags(f) })) writeNdjsonItem(process, item, f.fields);
    return;
  }
  const page = readablePage(await fetch(params)) as Row & { items: Row[] };
  if (outputOpts(f).json) return renderSuccess(page, outputOpts(f), process);
  human(page.items);
  if (page["cursor"]) print(`next page: --cursor ${String(page["cursor"])}`);
}

async function runList(c: Curviate, f: Flags): Promise<void> {
  const q: Row = {};
  if (f.kind !== undefined) {
    const kind = String(f.kind);
    if (!KINDS.includes(kind)) usage(`--kind takes one of ${KINDS.join(", ")}.`);
    q["kind"] = kind;
  }
  if (f["account-id"] !== undefined) q["account_id"] = f["account-id"];
  if (f.match !== undefined) {
    if (!MATCHES.includes(f.match)) usage(`--match takes one of ${MATCHES.join(", ")}.`);
    q["match"] = f.match;
  }
  if (f.listed !== undefined) q["listed"] = f.listed;
  if (f.since !== undefined) q["since"] = f.since;
  try {
    await paged(f, q, (p) => c.signals.list(p as never) as unknown as Promise<unknown>, (items) =>
      print(table(["SIGNAL", "KIND", "ACCOUNT", "PERSON", "AT"], items.map((i) => [i["id"], i["sub_kind"] ? `${String(i["kind"])}.${String(i["sub_kind"])}` : i["kind"], i["account_id"], (i["person"] as Row | null)?.["name"] ?? (i["anonymous"] ? "anonymous" : ""), i["occurred_at"]]))));
  } catch (err) {
    await fail(err, f);
  }
}

async function one(f: Flags, run: () => Promise<unknown>): Promise<void> {
  try {
    renderSuccess(readableObject(await run()), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

async function runWatch(c: Curviate, f: Flags): Promise<void> {
  try {
    const res = (await c.signals.watch()) as unknown as { items?: Row[] };
    if (outputOpts(f).json) return renderSuccess(res, outputOpts(f), process);
    print(table(["ACCOUNT", "WATCH", "STATE", "PAUSED UNTIL", "LAST VISIT", "VISITS TODAY", "READS TODAY"],
      (res.items ?? []).map((i) => [i["account_id"], i["signal_watch"] ? "on" : "off", i["pause_reason"] ? `${String(i["state"])} (${String(i["pause_reason"])})` : i["state"], i["paused_until"], i["last_visit_at"], i["visits_today"], i["reads_today"]])));
  } catch (err) {
    await fail(err, f);
  }
}

const onOff = (flag: string, v: string | undefined): boolean | undefined =>
  v === undefined ? undefined : v === "on" ? true : v === "off" ? false : usage(`--${flag} takes on or off.`);

function settingsBody(f: Flags): Row {
  const follow_up: Row = {};
  const pe = onOff("post-engaged", f["post-engaged"]);
  const pv = onOff("profile-viewed", f["profile-viewed"]);
  if (pe !== undefined) follow_up["post_engaged"] = pe;
  if (pv !== undefined) follow_up["profile_viewed"] = pv;
  if (!Object.keys(follow_up).length) usage("pass --post-engaged on|off, --profile-viewed on|off, or both.");
  return { follow_up };
}

/** A rule body from flags: only what was passed, so `update` changes only that. */
function ruleBody(f: Flags, create: boolean): Row {
  const body: Row = {};
  if (f.name !== undefined) body["name"] = f.name;
  if (f.on && f.off) usage("pass --on or --off, not both.");
  if (f.on || f.off) body["enabled"] = Boolean(f.on);
  if (f.kind !== undefined) {
    const kinds = listFlag("kind", f.kind);
    const bad = kinds.find((k) => !KINDS.includes(k));
    if (bad !== undefined) usage(`--kind ${bad} is not a Signal kind: one of ${KINDS.join(", ")}.`);
    body["kinds"] = kinds;
  }
  if (f.accounts !== undefined && f["all-accounts"]) usage("--accounts and --all-accounts cannot be combined.");
  if (f.accounts !== undefined) body["account_ids"] = listFlag("accounts", f.accounts);
  if (f["all-accounts"]) body["account_ids"] = null;
  if (f["unknown-people"] !== undefined) {
    if (!["skip", "visit_profile"].includes(f["unknown-people"])) usage("--unknown-people takes skip or visit_profile.");
    body["unknown_people"] = f["unknown-people"];
  }
  const outcomes: Row[] = [];
  if (f["add-to-list"] !== undefined) outcomes.push({ type: "add_to_list", list_id: nonEmpty("--add-to-list", f["add-to-list"]) });
  if (f["send-event"]) outcomes.push({ type: "send_event" });
  if (outcomes.length) body["outcomes"] = outcomes;
  if (create) {
    if (body["name"] === undefined) usage("--name is required: the rule's name, 1 to 100 characters.");
    if (body["kinds"] === undefined) usage("--kind is required: the Signal kinds the rule acts on, repeatable or a comma list.");
    if (!outcomes.length) usage("pass --add-to-list <cl_...>, --send-event, or both: what the rule does.");
  } else if (!Object.keys(body).length) usage("pass what changes: --name, --kind, --accounts, --all-accounts, --add-to-list, --send-event, --unknown-people, --on or --off.");
  return body;
}

// ---------------------------------------------------------------------------
// citty definitions
// ---------------------------------------------------------------------------

const ID = { type: "positional" as const, description: "Signal id (sig_...)." };
const RULE_ID = { type: "positional" as const, description: "Rule id (sgr_...)." };

const listCmd = defineCommand({
  meta: {
    name: "list",
    description:
      "The Signals of the Accounts you may operate, newest first, at most 7 days old and only for Accounts whose Signal watch is on. " +
      "Filter by --kind, --account-id, --match (lead, connection, followed, unknown, anonymous), --listed and --since. No LinkedIn call.",
    risk: "read",
    output: ["A table of Signal, kind, Account, person and when it happened; --json (or piped) prints the API page."],
    seeAlso: ["curviate signal watch", "curviate signal rules list"],
    examples: ["curviate signal list", "curviate signal list --kind profile_viewed --match lead", "curviate signal list --since 2026-11-17T00:00:00Z --all"],
  },
  args: {
    ...readOnly(GLOBAL_FLAGS),
    limit: { ...GLOBAL_FLAGS.limit, description: "Signals per page (1 to 100)." },
    kind: { type: "string" as const, description: "Only this kind: post_engaged, post_reposted, network_posted, profile_viewed, followed_you, mentioned_you, connection_added, post_engaged.reaction or post_engaged.comment." },
    "account-id": { type: "string" as const, description: "Only the Signals this Account caught (acc_...)." },
    match: { type: "string" as const, description: "Only Signals whose person is a lead, connection, followed, unknown or anonymous." },
    listed: { type: "boolean" as const, description: "--listed: only people on your Do-not-contact list; --no-listed: only people who are not." },
    since: { type: "string" as const, description: "Only Signals Curviate wrote after this time (ISO 8601)." },
  },
  run: online(runList),
});

const getCmd = defineCommand({
  meta: { name: "get", description: "One Signal, while it is at most 7 days old; an older or unknown one is RESOURCE_NOT_FOUND.", risk: "read", examples: ["curviate signal get sig_YOUR_SIGNAL_ID"] },
  args: { ...readOnly(READ_SINGLE_FLAGS), id: ID },
  run: online((c, f) => one(f, () => c.signals.get(nonEmpty("the Signal id", f.id)))),
});

const kindsCmd = defineCommand({
  meta: { name: "kinds", description: "Every Signal kind with its sub-kinds, the follow-up read a card of that kind can trigger (engagers, viewers or none), whether it is on for your Team, and the limit rows it uses.", risk: "read", examples: ["curviate signal kinds"] },
  args: readOnly(READ_SINGLE_FLAGS),
  run: online((c, f) => one(f, () => c.signals.kinds())),
});

const watchCmd = defineCommand({
  meta: {
    name: "watch",
    description: "For each Account you may operate: whether its Signal watch is on, its state (watching, paused with a reason, or off, the default), its last visit and today's visits and reads. No LinkedIn call.",
    risk: "read",
    examples: ["curviate signal watch"],
  },
  args: readOnly(READ_SINGLE_FLAGS),
  run: online(runWatch),
});

const settingsCmd = defineCommand({
  meta: {
    name: "settings",
    description:
      "Turn the Team's follow-up reads on or off: --post-engaged (read a post's reactions or comments when a card shows someone engaged; off: the Signal names the card's first person only) " +
      "and --profile-viewed (read the viewer list when a card shows views; off: no Signal for a viewer the card does not name). Both on by default. Owners and Managers.",
    risk: "write",
    rules: {
      changes: "The Team's follow-up reads, for every Account's next visits.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "Safe to repeat: the same settings again.",
      undo: "Run it again with the other value.",
    },
    errors: { INSUFFICIENT_ROLE: "only an Owner or a Manager changes the Signal settings." },
    examples: ["curviate signal settings --profile-viewed off"],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    "post-engaged": { type: "string" as const, description: "on or off." },
    "profile-viewed": { type: "string" as const, description: "on or off." },
  },
  run: async ({ args }: { args: unknown }) => {
    const f = args as Flags;
    const body = settingsBody(f);
    if (f.preview) return void preview("signals.updateSettings", {}, body);
    await one(f, async () => (await rootClient(f)).signals.updateSettings(body as never));
  },
});

const RULE_FLAGS = {
  name: { type: "string" as const, description: "The rule's name, 1 to 100 characters." },
  kind: { type: "string" as const, description: "The Signal kinds it acts on, repeatable or a comma list (see `curviate signal kinds`)." },
  accounts: { type: "string" as const, description: "Only these Accounts (acc_...), a comma list. Default on create: every Account of the Team, now and later." },
  "all-accounts": { type: "boolean" as const, description: "Every Account of the Team, now and later." },
  "add-to-list": { type: "string" as const, description: "Outcome: add the person to this Lead list (cl_...)." },
  "send-event": { type: "boolean" as const, description: "Outcome: send signal.matched to your webhooks." },
  "unknown-people": { type: "string" as const, description: "skip (default): a person Curviate knows nothing about is skipped. visit_profile: read their profile once; the person may see the visit." },
  on: { type: "boolean" as const, description: "Turn the rule on." },
  off: { type: "boolean" as const, description: "Turn the rule off: it acts on no Signal." },
};
const RULE_ERRORS = {
  INSUFFICIENT_ROLE: "your role does not allow adding Leads to a Lead list, which the rule does.",
  ACCOUNT_NOT_SHARED: "--accounts names an Account you may not operate.",
};

const rulesCmd = defineCommand({
  meta: { name: "rules", description: "Signal rules: what happens to a person when a Signal of a kind arrives on an Account (add them to a Lead list, send signal.matched to your webhooks)." },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "This Team's rules, newest first, each with its one-sentence summary. Every role may read them.", risk: "read", examples: ["curviate signal rules list", "curviate signal rules list --no-enabled"] },
      args: { ...readOnly(GLOBAL_FLAGS), enabled: { type: "boolean" as const, description: "--enabled: only rules that are on; --no-enabled: only rules that are off." } },
      run: online(async (c, f) => {
        const q: Row = {};
        if (f.enabled !== undefined) q["enabled"] = f.enabled;
        try {
          await paged(f, q, (p) => c.signals.rules.list(p as never) as unknown as Promise<unknown>, (items) =>
            print(table(["RULE", "ON", "NAME", "SUMMARY"], items.map((r) => [r["id"], r["enabled"] ? "on" : "off", r["name"], r["summary"]]))));
        } catch (err) {
          await fail(err, f);
        }
      }),
    }),
    get: defineCommand({
      meta: { name: "get", description: "One rule of this Team.", risk: "read", examples: ["curviate signal rules get sgr_YOUR_RULE_ID"] },
      args: { ...readOnly(READ_SINGLE_FLAGS), id: RULE_ID },
      run: online((c, f) => one(f, () => c.signals.rules.get(nonEmpty("the rule id", f.id)))),
    }),
    create: defineCommand({
      meta: {
        name: "create",
        description:
          "Create a rule: for --kind on --accounts (default every Account), add the person to a Lead list (--add-to-list) and/or send signal.matched to your webhooks (--send-event). " +
          "--unknown-people visit_profile reads the profile of a person Curviate does not know, once; the person may see the visit. The answer's summary is the rule as one sentence.",
        risk: "write",
        rules: {
          changes: "A rule that acts on every matching Signal from now on: Leads join the list, events are sent.",
          visible_to: "Your Team; with --unknown-people visit_profile, the people whose profiles are read.",
          budget_rows: [],
          retry: "A second call creates a second rule: list them first.",
          undo: "`curviate signal rules delete <rule_id>`; Leads it added stay.",
        },
        errors: RULE_ERRORS,
        examples: ["curviate signal rules create --name \"Viewers to list\" --kind profile_viewed --add-to-list cl_YOUR_LIST_ID", "curviate signal rules create --name \"Engagers\" --kind post_engaged --send-event --accounts acc_YOUR_ACCOUNT_ID"],
      },
      args: { ...WRITE_SINGLE_FLAGS, ...RULE_FLAGS },
      run: async ({ args }: { args: unknown }) => {
        const f = args as Flags;
        const body = ruleBody(f, true);
        if (f.preview) return void preview("signals.rules.create", {}, body);
        await one(f, async () => (await rootClient(f)).signals.rules.create(body as never));
      },
    }),
    update: defineCommand({
      meta: {
        name: "update",
        description: "Change a rule; only what you pass changes (an outcome flag replaces the outcomes). --off switches it off, --on on again.",
        risk: "write",
        rules: {
          changes: "The rule, for every Signal from now on.",
          visible_to: "Your Team.",
          budget_rows: [],
          retry: "Safe to repeat: the same values again.",
          undo: "Run it again with the previous values (`curviate signal rules get` prints them).",
        },
        errors: RULE_ERRORS,
        examples: ["curviate signal rules update sgr_YOUR_RULE_ID --off", "curviate signal rules update sgr_YOUR_RULE_ID --kind profile_viewed,followed_you"],
      },
      args: { ...WRITE_SINGLE_FLAGS, id: RULE_ID, ...RULE_FLAGS },
      run: async ({ args }: { args: unknown }) => {
        const f = args as Flags;
        const id = nonEmpty("the rule id", f.id);
        const body = ruleBody(f, false);
        if (f.preview) return void preview("signals.rules.update", { id }, body);
        await one(f, async () => (await rootClient(f)).signals.rules.update(id, body as never));
      },
    }),
    delete: defineCommand({
      meta: {
        name: "delete",
        description: "Delete a rule. What it did stays: the Leads, their list memberships and the records of its actions.",
        risk: "write",
        rules: { changes: "The rule is gone; it acts on no further Signal.", visible_to: "Your Team.", budget_rows: [], retry: "A second call answers RESOURCE_NOT_FOUND.", undo: "Create it again with `curviate signal rules create`." },
        examples: ["curviate signal rules delete sgr_YOUR_RULE_ID"],
      },
      args: { ...WRITE_SINGLE_FLAGS, id: RULE_ID },
      run: async ({ args }: { args: unknown }) => {
        const f = args as Flags;
        const id = nonEmpty("the rule id", f.id);
        if (f.preview) return void preview("signals.rules.delete", { id }, {});
        try {
          await (await rootClient(f)).signals.rules.delete(id);
          renderSuccess({ deleted: true, id }, outputOpts(f), process);
        } catch (err) {
          await fail(err, f);
        }
      },
    }),
  },
});

export const signalCommand = defineCommand({
  meta: { name: "signal", description: DESCRIPTIONS.signal },
  subCommands: { list: listCmd, get: getCmd, kinds: kindsCmd, watch: watchCmd, settings: settingsCmd, rules: rulesCmd },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(signalCommand, ["curviate", "signal"]);
  },
});
