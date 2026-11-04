/**
 * `curviate account safety get|update <account>`: one Account's safety policy
 * (limits per budget row, Active hours), read and written whole as a document.
 * `curviate account team-access on|off <account>`: whether the Team may use it.
 */
import { defineCommand } from "citty";
import { READ_SINGLE_FLAGS, WRITE_SINGLE_FLAGS, readOnly } from "../lib/global-flags.js";
import { parseDocument, readFileFlag } from "../lib/document.js";
import { renderSuccess } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { fail, outputOpts, rootClient, type RootFlags } from "../lib/root-command.js";

type Flags = RootFlags & { accountId?: string; file?: string; "activity-level"?: string };
const LEVELS = ["normal", "increased"];
const ACCOUNT = { type: "positional" as const, description: "The Account (acc_...)." };

const getCmd = defineCommand({
  meta: {
    name: "get",
    description: "One Account's safety policy: every budget row with its ceiling, effective_ceiling and (strict rows) target and effective_target, Active hours, warm-up, pacing, auto_withdraw and the Activity level (activity_level, and activity_level_effective with activity_level_reason when it runs lower). A read: no LinkedIn call.",
    risk: "read",
    seeAlso: ["curviate account safety update", "curviate account get"],
    examples: ["curviate account safety get acc_YOUR_ACCOUNT_ID", "curviate account safety get acc_YOUR_ACCOUNT_ID --fields active_hours,warm_up"],
  },
  args: { ...readOnly(READ_SINGLE_FLAGS), accountId: ACCOUNT },
  async run({ args }) {
    const f = args as Flags;
    const c = await rootClient(f);
    try {
      renderSuccess(await c.accounts.getSafetyPolicy(String(f.accountId ?? "")), outputOpts(f), process);
    } catch (err) {
      await fail(err, f);
    }
  },
});

const updateCmd = defineCommand({
  meta: {
    name: "update",
    description: "Change one Account's safety policy from a JSON document: `rows`, for example {\"rows\":[{\"budget_row\":\"profile_views\",\"ceiling\":40}]}, `active_hours`, for example {\"active_hours\":{\"days\":[\"mon\",\"tue\"],\"start\":\"09:00\",\"end\":\"17:00\"}}, `auto_withdraw` (true or false: Curviate withdraws its own invitations older than 14 days once more than 400 are pending) and `activity_level`. --activity-level normal|increased sets the Activity level alone, or beside --file: how close the Account's daily targets sit to its limits. normal (the default) aims about midway between the green figure and the limit; increased works close to the limit, never past it, and raises the chance LinkedIn notices the activity. It runs as normal, and the setting stays, while warm-up is on or the Account's health is not healthy; the printed policy's activity_level_effective and activity_level_reason say which level is in force. Active hours hold Motions and other live writes, never a direct message (send, new chat, edit, delete, reaction, read mark). A row's `green` is its target, what Motions aim at; the ceiling is the most it may do. Fields you leave out stay as they are; null clears an override. Prints the policy.",
    risk: "write",
    rules: {
      changes: "The Account's limits, Active hours or Activity level, from the next action on.",
      visible_to: "Your Team. Nothing is posted on LinkedIn; a higher limit lets more actions reach it.",
      budget_rows: [],
      retry: "Safe: the same document leaves the same policy.",
      undo: "Send the previous values, or null to fall back to the Team's default.",
      blast_radius: "One Account's pace, in every Motion and every direct action.",
    },
    errors: { INVALID_REQUEST: "a field is unknown or not settable; the message names it." },
    seeAlso: ["curviate account safety get", "curviate account warm-up"],
    examples: [
      "curviate account safety update acc_YOUR_ACCOUNT_ID --file policy.json",
      "curviate account safety update acc_YOUR_ACCOUNT_ID --activity-level increased",
    ],
    requires: ["--file or --activity-level, or both (the flag wins over the document's activity_level)."],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    accountId: ACCOUNT,
    file: { type: "string", description: "The JSON document: a path, or - to read it from stdin." },
    "activity-level": { type: "string", description: "normal (default) or increased: how close the Account's daily targets sit to its limits. increased raises the chance LinkedIn notices the activity; it runs as normal while warm-up is on or health is not healthy." },
  },
  async run({ args }) {
    const f = args as Flags;
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
  meta: { name: "safety", description: "Read or change one Account's safety policy: limits per budget row, Active hours and the Activity level." },
  subCommands: { get: getCmd, update: updateCmd },
  async run() {
    process.stderr.write("Usage: curviate account safety get|update <account>\n");
  },
});

const accessCommand = (name: "on" | "off") => defineCommand({
  meta: {
    name,
    description: name === "on"
      ? "Share the Account with its Team again (it does not rejoin a Motion). Only the person who connected it can."
      : "Keep the Account to its person: it leaves every Motion that held it and its queued enrichment visits are dropped. Only the person who connected it can.",
    risk: "write",
    rules: {
      changes: name === "on" ? "The Team may use the Account again." : "The Team loses the Account; it leaves every Motion that held it.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "Safe to repeat: the switch ends in the same state.",
      undo: name === "on" ? "Run `curviate account team-access off <account>`." : "Run `curviate account team-access on <account>`, then add it back to its Motions.",
    },
    errors: { ACCOUNT_OWNER_ONLY: "only the person who connected the Account can change this." },
    seeAlso: ["curviate account get", "curviate team members"],
    examples: [`curviate account team-access ${name} acc_YOUR_ACCOUNT_ID`],
  },
  args: { ...WRITE_SINGLE_FLAGS, accountId: ACCOUNT },
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
