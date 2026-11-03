/**
 * `curviate do-not-contact`: your Team's one list of people no Motion contacts
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

type Flags = RootFlags & {
  id?: string;
  contact?: string;
  "linkedin-url"?: string;
  reason?: string;
  query?: string;
  limit?: string;
  cursor?: string;
  all?: boolean;
  "max-pages"?: string;
  "page-delay"?: string;
};
type Body = Record<string, unknown>;

const REASONS = ["asked_to_stop", "existing_customer", "competitor", "partner", "employee", "other"];

const online = (fn: (c: Curviate, f: Flags) => Promise<void>) => async ({ args }: { args: unknown }) => {
  const f = args as Flags;
  await fn(await rootClient(f), f);
};

const preview = (method: string, args: Body, body: Body = {}) =>
  void process.stdout.write(JSON.stringify(buildPreviewOutput({ method, args, body })) + "\n");

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
  if ((f.contact === undefined) === (f["linkedin-url"] === undefined)) usage("name the person with exactly one of --contact (con_...) or --linkedin-url.");
  for (const [flag, v] of [["contact", f.contact], ["linkedin-url", f["linkedin-url"]]] as const) if (v !== undefined && v.trim() === "") usage(`--${flag} was given an empty value.`);
  const body: Body = f.contact !== undefined ? { contact_id: f.contact } : { linkedin_url: f["linkedin-url"] };
  const why = reason(f, false);
  if (why) body["reason"] = why;
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

const ID = { type: "positional" as const, description: "Entry id (dnc_...), from `curviate do-not-contact list`." };
const REASON_ARG = { type: "string" as const, description: `Why: ${REASONS.join(" | ")}.` };

const listCmd = defineCommand({
  meta: {
    name: "list",
    description:
      "List your Team's do-not-contact list, newest first. No Motion contacts a person on it and writes toward them are refused (exit 10); a reply in a conversation they wrote in stays allowed. " +
      "An entry whose Contact was deleted still applies.",
    risk: "read",
    examples: ["curviate do-not-contact list", "curviate do-not-contact list --query jane"],
  },
  args: { ...readOnly(GLOBAL_FLAGS), query: { type: "string", description: "Only entries whose Contact name matches this text." } },
  run: online(runList),
});

const getCmd = defineCommand({
  meta: { name: "get", description: "One do-not-contact entry: the person, the reason, and who added it.", risk: "read", examples: ["curviate do-not-contact get dnc_YOUR_ENTRY_ID"] },
  args: { ...readOnly(READ_SINGLE_FLAGS), id: ID },
  run: online(runGet),
});

const addCmd = defineCommand({
  meta: {
    name: "add",
    description:
      "Put one person on the list, by Contact id or LinkedIn URL (a URL of someone who is not a Contact yet creates the Contact from stored data). No Motion contacts them afterwards and writes toward them are refused. " +
      "One person per call; loop for many. Any member may add. Needs Automate.",
    risk: "write",
    rules: {
      changes: "The person joins the list; Motions skip them and writes toward them are refused.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "Safe: a person already on the list answers with their existing entry.",
      undo: "`curviate do-not-contact remove <id>` (Owners and Managers).",
    },
    errors: { TIER_REQUIRED: "your plan does not include Do-not-contact writes (Automate).", RESOURCE_NOT_FOUND: "no Contact has this id." },
    seeAlso: ["curviate do-not-contact list"],
    examples: ["curviate do-not-contact add --contact con_YOUR_CONTACT_ID --reason asked_to_stop", "curviate do-not-contact add --linkedin-url https://www.linkedin.com/in/jane-doe"],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    contact: { type: "string", description: "The Contact (con_...). Not with --linkedin-url." },
    "linkedin-url": { type: "string", description: "The person's LinkedIn profile URL, in any spelling. Not with --contact." },
    reason: REASON_ARG,
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
    description: "Take a person off the list: Motions and writes may reach them again. Owners and Managers only.",
    risk: "high",
    rules: {
      changes: "The entry is deleted; Motions may enroll the person and writes toward them are allowed again.",
      visible_to: "The person, if a Motion or write then reaches them on LinkedIn.",
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

export const doNotContactCommand = defineCommand({
  meta: { name: "do-not-contact", description: DESCRIPTIONS["do-not-contact"] },
  subCommands: { list: listCmd, get: getCmd, add: addCmd, update: updateCmd, remove: removeCmd },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(doNotContactCommand, ["curviate", "do-not-contact"]);
  },
});
