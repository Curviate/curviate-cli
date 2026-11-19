/**
 * `curviate account safety get|update <account>`: one Account's safety policy
 * (limits per budget row, Active hours), read and written whole as a document.
 * `curviate account team-access on|off <account>`: whether the Team may use it.
 */
import { defineCommand } from "citty";
import { READ_SINGLE_FLAGS, WRITE_SINGLE_FLAGS, readOnly, setTeamFlag } from "../lib/global-flags.js";
import { intFlag } from "../lib/int-flag.js";
import { parseDocument, readFileFlag } from "../lib/document.js";
import { renderSuccess } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { fail, outputOpts, rootClient, usage, type RootFlags } from "../lib/root-command.js";

type Flags = RootFlags & {
  accountId?: string;
  file?: string;
  "activity-level"?: string;
  team?: string;
  "email-default-cap"?: string;
  "email-opt-out-scope"?: string;
  "email-opt-out-text"?: string;
  "email-opt-out-link-text"?: string;
  "email-opt-out-link-word"?: string;
};
const LEVELS = ["normal", "increased"];
const SCOPES = ["everything", "email_only"];
const ACCOUNT = { type: "positional" as const, required: false, description: "The Account (acc_...). Not with --team." };
const ACCOUNT_REQUIRED = { type: "positional" as const, description: "The Account (acc_...)." };
const TEAM = {
  type: "string" as const,
  description: "The Team's safety policy instead of one Account's: pass --team alone for the Team your key or profile names, or --team tnt_... for another of your Teams. Not with an Account id.",
};
const EMAIL_FLAGS = {
  "email-default-cap": { type: "string" as const, description: "With --team: the daily cap a Mailbox gets when it connects, at most 50 (default 30). Mailboxes already connected keep theirs. The API refuses a higher value." },
  "email-opt-out-scope": { type: "string" as const, description: `With --team: what an email opt-out covers, ${SCOPES.join(" | ")} (default everything).` },
  "email-opt-out-text": { type: "string" as const, description: "With --team: the opt-out line in every email step, up to 200 characters, one plain line, no variables. \"\" restores the shipped default." },
  "email-opt-out-link-text": { type: "string" as const, description: "With --team: the text before the opt-out link, up to 100 characters, one plain line, no variables. \"\" restores the shipped default." },
  "email-opt-out-link-word": { type: "string" as const, description: "With --team: the opt-out link's word, up to 30 characters, for example Abmelden. \"\" restores the shipped default." },
};

/** `--team` as a scope switch: the Team policy (true) or one Account's (false). A bare `--team` names no Team id, so it must not reach the Team-selector check. */
function teamScope(f: Flags): boolean {
  const asked = f.team !== undefined;
  const id = String(f.accountId ?? "");
  if (asked && id !== "") usage("--team reads or changes the Team's policy: leave the Account id out.");
  if (!asked && id === "") usage("name the Account (acc_...), or pass --team for the Team's policy.");
  if (!asked) return false;
  if (f.team === "") setTeamFlag(undefined);
  else if (!/^tnt_/.test(f.team!)) usage("--team takes a Team id (tnt_...), or no value for your current Team.");
  return true;
}

const getCmd = defineCommand({
  meta: {
    name: "get",
    description: "With --team, the Team's own policy: its defaults per limit profile and budget row and `email` (default_daily_cap, opt_out_scope and the three opt-out texts in force, the shipped default when none is set). Otherwise one Account's safety policy: every budget row with its ceiling, effective_ceiling and (strict rows) target and effective_target, Active hours, warm-up, pacing, auto_withdraw and the Activity level (activity_level, and activity_level_effective with activity_level_reason when it runs lower). A read: no LinkedIn call.",
    risk: "read",
    seeAlso: ["curviate account safety update", "curviate account get"],
    examples: ["curviate account safety get acc_YOUR_ACCOUNT_ID", "curviate account safety get acc_YOUR_ACCOUNT_ID --fields active_hours,warm_up", "curviate account safety get --team"],
  },
  args: { ...readOnly(READ_SINGLE_FLAGS), team: TEAM, accountId: ACCOUNT },
  async run({ args }) {
    const f = args as Flags;
    const team = teamScope(f);
    const c = await rootClient(f);
    try {
      renderSuccess(team ? await c.accounts.getTeamSafetyPolicy() : await c.accounts.getSafetyPolicy(String(f.accountId ?? "")), outputOpts(f), process);
    } catch (err) {
      await fail(err, f);
    }
  },
});

/** The Team's email defaults: only the flags given are sent; the API holds every limit (a cap above 50, a word over 30) and answers 400 naming it. */
async function updateTeam(f: Flags): Promise<void> {
  const email: Record<string, unknown> = {};
  if (f["email-default-cap"] !== undefined) email["default_daily_cap"] = intFlag("email-default-cap", f["email-default-cap"]);
  const scope = f["email-opt-out-scope"];
  if (scope !== undefined) {
    if (!SCOPES.includes(scope)) usage(`--email-opt-out-scope is ${SCOPES.join(" or ")}, not "${scope}".`);
    email["opt_out_scope"] = scope;
  }
  for (const [flag, key] of [["email-opt-out-text", "opt_out_text"], ["email-opt-out-link-text", "opt_out_link_text"], ["email-opt-out-link-word", "opt_out_link_word"]] as const) {
    if (f[flag] !== undefined) email[key] = f[flag];
  }
  if (f.file !== undefined || f["activity-level"] !== undefined) usage("--team takes the --email-* flags, not --file or --activity-level.");
  if (Object.keys(email).length === 0) usage("pass at least one --email-* flag with --team.");
  const body = { email };
  if (f.preview) {
    process.stdout.write(JSON.stringify(buildPreviewOutput({ method: "accounts.updateTeamSafetyPolicy", args: {}, body })) + "\n");
    return;
  }
  const c = await rootClient(f);
  try {
    renderSuccess(await c.accounts.updateTeamSafetyPolicy(body as never), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

const eventsCmd = defineCommand({
  meta: {
    name: "events",
    description: "One Account's limit hits, newest first: each entry is an action Curviate refused at a safety limit or pause (blocked true), or a pause lifted early. Filter by --budget-row, --since and --until. A read: no LinkedIn call, one API call per page.",
    risk: "read",
    seeAlso: ["curviate account safety get", "curviate account safety update"],
    examples: ["curviate account safety events acc_YOUR_ACCOUNT_ID", "curviate account safety events acc_YOUR_ACCOUNT_ID --budget-row profile_views --since 2026-11-01T00:00:00Z"],
  },
  args: {
    ...readOnly(READ_SINGLE_FLAGS),
    accountId: ACCOUNT_REQUIRED,
    "budget-row": { type: "string", description: "Only hits on this budget row, for example profile_views." },
    since: { type: "string", description: "Only hits at or after this time (ISO 8601)." },
    until: { type: "string", description: "Only hits before this time (ISO 8601)." },
    limit: { type: "string", description: "Hits per page (1 to 100)." },
    cursor: { type: "string", description: "The cursor from the previous page." },
  },
  async run({ args }) {
    const f = args as Flags & { "budget-row"?: string; since?: string; until?: string; limit?: string; cursor?: string };
    const params: Record<string, unknown> = {};
    for (const [flag, key] of [["budget-row", "budget_row"], ["since", "since"], ["until", "until"], ["cursor", "cursor"]] as const) {
      const v = f[flag];
      if (v === undefined) continue;
      if (v.trim() === "") usage(`--${flag} was given an empty value.`);
      params[key] = v;
    }
    if (f.limit !== undefined) params["limit"] = intFlag("limit", f.limit, 1, 100);
    const c = await rootClient(f);
    try {
      renderSuccess(await c.accounts.listSafetyEvents(String(f.accountId ?? ""), params as never), outputOpts(f), process);
    } catch (err) {
      await fail(err, f);
    }
  },
});

const updateCmd = defineCommand({
  meta: {
    name: "update",
    description: "With --team, change the Team's email defaults instead, with the --email-* flags: the daily cap a new Mailbox gets (--email-default-cap, at most 50), what an opt-out covers (--email-opt-out-scope everything|email_only) and the three opt-out texts every email step carries (--email-opt-out-text up to 200 characters, --email-opt-out-link-text up to 100, --email-opt-out-link-word up to 30; one plain line, no variables; \"\" restores the shipped default). Prints the Team policy. Otherwise change one Account's safety policy from a JSON document: `rows`, for example {\"rows\":[{\"budget_row\":\"profile_views\",\"ceiling\":40}]}, `active_hours`, for example {\"active_hours\":{\"days\":[\"mon\",\"tue\"],\"start\":\"09:00\",\"end\":\"17:00\"}}, `auto_withdraw` (true or false: Curviate withdraws its own invitations older than 14 days once more than 400 are pending) and `activity_level`. --activity-level normal|increased sets the Activity level alone, or beside --file: how close the Account's daily targets sit to its limits. normal (the default) aims about midway between the green figure and the limit; increased works close to the limit, never past it, and raises the chance LinkedIn notices the activity. It runs as normal, and the setting stays, while warm-up is on or the Account's health is not healthy; the printed policy's activity_level_effective and activity_level_reason say which level is in force. Active hours hold Campaigns and other live writes, never a direct message (send, new chat, edit, delete, reaction, read mark). A row's `green` is its target, what Campaigns aim at; the ceiling is the most it may do. Fields you leave out stay as they are; null clears an override. Prints the policy.",
    risk: "write",
    rules: {
      changes: "The Account's limits, Active hours or Activity level, from the next action on.",
      visible_to: "Your Team. Nothing is posted on LinkedIn; a higher limit lets more actions reach it.",
      budget_rows: [],
      retry: "Safe: the same document leaves the same policy.",
      undo: "Send the previous values, or null to fall back to the Team's default.",
      blast_radius: "One Account's pace, in every Campaign and every direct action.",
    },
    errors: { INVALID_REQUEST: "a field is unknown or not settable; the message names it." },
    seeAlso: ["curviate account safety get", "curviate account warm-up"],
    examples: [
      "curviate account safety update acc_YOUR_ACCOUNT_ID --file policy.json",
      "curviate account safety update acc_YOUR_ACCOUNT_ID --activity-level increased",
      "curviate account safety update --team --email-default-cap 40 --email-opt-out-link-word Abmelden",
    ],
    requires: ["an Account id with --file or --activity-level, or both (the flag wins over the document's activity_level); or --team with at least one --email-* flag."],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    team: TEAM,
    ...EMAIL_FLAGS,
    accountId: ACCOUNT,
    file: { type: "string", description: "The JSON document: a path, or - to read it from stdin." },
    "activity-level": { type: "string", description: "normal (default) or increased: how close the Account's daily targets sit to its limits. increased raises the chance LinkedIn notices the activity; it runs as normal while warm-up is on or health is not healthy." },
  },
  async run({ args }) {
    const f = args as Flags;
    if (teamScope(f)) return updateTeam(f);
    const emailFlag = Object.keys(EMAIL_FLAGS).find((k) => f[k as keyof typeof EMAIL_FLAGS] !== undefined);
    if (emailFlag) usage(`--${emailFlag} changes the Team's policy: add --team and leave the Account id out.`);
    const accountId = String(f.accountId ?? "");
    const level = f["activity-level"];
    if (level !== undefined && !LEVELS.includes(level)) {
      process.stderr.write(`error: --activity-level is normal or increased, not "${level}".\n`);
      process.exit(2);
    }
    if (f.file === undefined && level === undefined) {
      process.stderr.write("error: pass --file <policy.json> or --activity-level normal|increased.\n");
      process.exit(2);
    }
    const doc = f.file === undefined ? {} : (parseDocument("file", await readFileFlag("file", f.file, { others: f })) as Record<string, unknown>);
    const body = level === undefined ? doc : { ...doc, activity_level: level };
    if (f.preview) {
      process.stdout.write(JSON.stringify(buildPreviewOutput({ method: "accounts.updateSafetyPolicy", args: { accountId }, body })) + "\n");
      return;
    }
    const c = await rootClient(f);
    try {
      renderSuccess(await c.accounts.updateSafetyPolicy(accountId, body as never), outputOpts(f), process);
    } catch (err) {
      await fail(err, f);
    }
  },
});

export const accountSafetyCommand = defineCommand({
  meta: { name: "safety", description: "Read or change one Account's safety policy (limits per budget row, Active hours, the Activity level), read its limit hits (events), or with --team your Team's email defaults." },
  subCommands: { get: getCmd, update: updateCmd, events: eventsCmd },
  async run() {
    process.stderr.write("Usage: curviate account safety get|update <account> | --team\n");
  },
});

const accessCommand = (name: "on" | "off") => defineCommand({
  meta: {
    name,
    description: name === "on"
      ? "Share the Account with its Team again (it does not rejoin a Campaign). Only the person who connected it can."
      : "Keep the Account to its person: it leaves every Campaign that held it and its queued enrichment visits are dropped. Only the person who connected it can.",
    risk: "write",
    rules: {
      changes: name === "on" ? "The Team may use the Account again." : "The Team loses the Account; it leaves every Campaign that held it.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "Safe to repeat: the switch ends in the same state.",
      undo: name === "on" ? "Run `curviate account team-access off <account>`." : "Run `curviate account team-access on <account>`, then add it back to its Campaigns.",
    },
    errors: { ACCOUNT_OWNER_ONLY: "only the person who connected the Account can change this." },
    seeAlso: ["curviate account get", "curviate team members"],
    examples: [`curviate account team-access ${name} acc_YOUR_ACCOUNT_ID`],
  },
  args: { ...WRITE_SINGLE_FLAGS, accountId: ACCOUNT_REQUIRED },
  async run({ args }) {
    const f = args as Flags;
    const accountId = String(f.accountId ?? "");
    if (f.preview) {
      process.stdout.write(JSON.stringify(buildPreviewOutput({ method: "accounts.setTeamAccess", args: { accountId }, body: { team_access: name === "on" } })) + "\n");
      return;
    }
    const c = await rootClient(f);
    try {
      renderSuccess(await c.accounts.setTeamAccess(accountId, name === "on"), outputOpts(f), process);
    } catch (err) {
      await fail(err, f);
    }
  },
});

export const accountTeamAccessCommand = defineCommand({
  meta: { name: "team-access", description: "Share an Account with its Team, or keep it to the person who connected it." },
  subCommands: { on: accessCommand("on"), off: accessCommand("off") },
  async run() {
    process.stderr.write("Usage: curviate account team-access on|off <account>\n");
  },
});
