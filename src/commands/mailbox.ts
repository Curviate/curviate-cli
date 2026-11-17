/**
 * `curviate mailbox`: your Team's own email Mailboxes. Root-scoped
 * (`curviate.mailboxes.*`): list, read, change (Sends for, daily cap,
 * signature), pause, resume, remove. Each command makes one API call.
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

type Flags = RootFlags & {
  id?: string;
  state?: string;
  "sends-for"?: string;
  domain?: string;
  limit?: string;
  cursor?: string;
  all?: boolean;
  "max-pages"?: string;
  "page-delay"?: string;
  "daily-cap"?: string;
  "signature-file"?: string;
};
type Body = Record<string, unknown>;

const STATES = ["connected", "ramping", "paused", "paused_by_bounces", "paused_by_provider", "reconnect_needed"];
/** The API's cap and signature limits are its own: the CLI sends what it is given and prints the API's 400. */
const SIGNATURE_MAX_BYTES = 64 * 1024;

const online = (fn: (c: Curviate, f: Flags) => Promise<void>) => async ({ args }: { args: unknown }) => {
  const f = args as Flags;
  await fn(await rootClient(f), f);
};

const preview = (method: string, args: Body, body: Body = {}) =>
  void process.stdout.write(JSON.stringify(buildPreviewOutput({ method, args, body })) + "\n");

async function runList(c: Curviate, f: Flags): Promise<void> {
  rejectPaginationModifiersWithoutAll(f, process);
  const params: Body = {};
  if (f.state !== undefined) {
    if (!STATES.includes(f.state)) usage(`--state takes one of ${STATES.join(", ")}.`);
    params["state"] = f.state;
  }
  for (const [flag, key] of [["sends-for", "sends_for"], ["domain", "domain"]] as const) {
    const v = f[flag];
    if (v === undefined) continue;
    if (v.trim() === "") usage(`--${flag} was given an empty value.`);
    params[key] = v;
  }
  if (f.limit !== undefined) params["limit"] = intFlag("limit", f.limit, 1, 100);
  const cursor = readCursorFlag(f, process);
  if (cursor) params["cursor"] = cursor;
  try {
    if (f.all) {
      const page = (p: Body) => c.mailboxes.list(p as never) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(page, params, { maxPages: readMaxPagesFlag(f, process), out: process, pageDelayMs: pageDelayFromFlags(f) })) writeNdjsonItem(process, item, f.fields);
    } else {
      renderSuccess(readablePage(await c.mailboxes.list(params as never)), outputOpts(f), process);
    }
  } catch (err) {
    await fail(err, f);
  }
}

async function runGet(c: Curviate, f: Flags): Promise<void> {
  try {
    renderSuccess(readableObject(await c.mailboxes.get(String(f.id ?? ""))), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

async function runUpdate(c: Curviate, f: Flags): Promise<void> {
  const id = String(f.id ?? "");
  const body: Body = {};
  const link = f["sends-for"];
  if (link !== undefined) {
    if (link.trim() === "") usage("--sends-for was given an empty value: an Account id (acc_...) or shared.");
    body["sends_for"] = link === "shared" ? { kind: "shared" } : { kind: "account", account_id: link };
  }
  if (f["daily-cap"] !== undefined) body["daily_cap"] = intFlag("daily-cap", f["daily-cap"]);
  if (f["signature-file"] !== undefined) body["signature"] = (await readFileFlag("signature-file", f["signature-file"], { maxBytes: SIGNATURE_MAX_BYTES, others: f as Record<string, unknown> })).trimEnd();
  if (Object.keys(body).length === 0) usage("pass at least one of --sends-for, --daily-cap, --signature-file.");
  if (f.preview) return preview("mailboxes.update", { id }, body);
  try {
    renderSuccess(readableObject(await c.mailboxes.update(id, body as never)), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

const act = (verb: "pause" | "resume" | "remove") => async (c: Curviate, f: Flags): Promise<void> => {
  const id = String(f.id ?? "");
  if (f.preview) return preview(`mailboxes.${verb}`, { id });
  try {
    renderSuccess(readableObject(await c.mailboxes[verb](id)), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
};

const ID = { type: "positional" as const, description: "The Mailbox (mbx_...), from `curviate mailbox list`." };
const NOT_FOUND = { MAILBOX_NOT_FOUND: "no Mailbox of your Team has this id (another Team's id answers the same)." };

const listCmd = defineCommand({
  meta: {
    name: "list",
    description:
      "List your Team's Mailboxes, newest first: state, Sends for, daily cap, sent today, bounces over 7 days, paused until. Every role reads. " +
      "A Mailbox in `ramping` works up to its cap; the steps are never shown. No secret is ever in the answer.",
    risk: "read",
    seeAlso: ["curviate mailbox get", "curviate domain check"],
    examples: ["curviate mailbox list", "curviate mailbox list --state paused --domain acme.example", "curviate mailbox list --sends-for none"],
  },
  args: {
    ...readOnly(GLOBAL_FLAGS),
    limit: { ...GLOBAL_FLAGS.limit, description: "Mailboxes per page (1 to 100)." },
    state: { type: "string", description: `Only Mailboxes in this state: ${STATES.join(" | ")}.` },
    "sends-for": { type: "string", description: "Only Mailboxes linked to this Account (acc_...), or shared (any Account may send), or none (linked to nothing, sends nothing)." },
    domain: { type: "string", description: "Only Mailboxes on this domain." },
  },
  run: online(runList),
});

const getCmd = defineCommand({
  meta: {
    name: "get",
    description:
      "One Mailbox: address, state, Sends for and its suggestion, daily cap (and cap_lowered_to when a spam reading lowered it), sent today, bounces over 7 days, signature, which Accounts and Campaigns used it. Every role reads.",
    risk: "read",
    errors: NOT_FOUND,
    seeAlso: ["curviate mailbox list", "curviate mailbox update"],
    examples: ["curviate mailbox get mbx_YOUR_MAILBOX_ID"],
  },
  args: { ...readOnly(READ_SINGLE_FLAGS), id: ID },
  run: online(runGet),
});

const updateCmd = defineCommand({
  meta: {
    name: "update",
    description:
      "Change one Mailbox: who it sends for (--sends-for an Account id, or shared), its daily cap (--daily-cap, 1 to 50, one cap across every Campaign and Account, a hard maximum for every caller) " +
      "and its signature (--signature-file, plain text, up to 2,000 characters, available as {{mailbox.signature}}; nothing adds it to an email by itself). Flags you leave out stay as they are. " +
      "A Mailbox linked to no Account sends nothing. Owners and Managers change any Mailbox; a Member only the ones they connected.",
    risk: "write",
    rules: {
      changes: "The Mailbox's link, daily cap or signature, from the next email on. Open threads stay on it.",
      visible_to: "Your Team; the signature reaches recipients where a step uses {{mailbox.signature}}.",
      budget_rows: [],
      retry: "Safe: the same flags leave the same Mailbox.",
      undo: "Update again with the previous values.",
      blast_radius: "One Mailbox's sending, in every Campaign that uses it.",
    },
    errors: { ...NOT_FOUND, ACCOUNT_NOT_FOUND: "--sends-for names an Account outside your Team.", INVALID_REQUEST: "a value is out of range (a cap above 50, a signature over 2,000 characters); the message names the limit.", INSUFFICIENT_ROLE: "a Member changes only the Mailboxes they connected." },
    seeAlso: ["curviate mailbox get", "curviate mailbox pause"],
    examples: [
      "curviate mailbox update mbx_YOUR_MAILBOX_ID --sends-for acc_YOUR_ACCOUNT_ID",
      "curviate mailbox update mbx_YOUR_MAILBOX_ID --sends-for shared --daily-cap 40",
      "curviate mailbox update mbx_YOUR_MAILBOX_ID --signature-file signature.txt",
    ],
    requires: ["at least one of --sends-for, --daily-cap, --signature-file."],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    id: ID,
    "sends-for": { type: "string", description: "An Account id (acc_..., it then sends only for that Account) or shared (any Account of your Team may send from it)." },
    "daily-cap": { type: "string", description: "Emails a day across every Campaign and Account, 1 to 50. The API refuses a higher value (exit 2, the message names 50)." },
    "signature-file": { type: "string", stdinArg: true, description: "A plain-text file with the sign-off: a path, or - to read it from stdin. Up to 2,000 characters." },
  },
  run: online(runUpdate),
});

const pauseCmd = defineCommand({
  meta: {
    name: "pause",
    description: "Stop a Mailbox sending until you resume it. Emails due from it wait; nothing is sent from it meanwhile.",
    risk: "write",
    rules: {
      changes: "The Mailbox's state becomes paused; no email leaves it.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "Safe to repeat.",
      undo: "`curviate mailbox resume <id>`.",
      blast_radius: "One Mailbox's sending.",
    },
    errors: { ...NOT_FOUND, MAILBOX_STATE_CONFLICT: "the Mailbox is not in a state that can be paused." },
    seeAlso: ["curviate mailbox resume"],
    examples: ["curviate mailbox pause mbx_YOUR_MAILBOX_ID"],
  },
  args: { ...WRITE_SINGLE_FLAGS, id: ID },
  run: online(act("pause")),
});

const resumeCmd = defineCommand({
  meta: {
    name: "resume",
    description: "Let a paused Mailbox send again. A Mailbox that is not paused, or one paused by bounces or by its provider with no date, is refused with MAILBOX_STATE_CONFLICT and stays as it was.",
    risk: "write",
    rules: {
      changes: "The Mailbox sends again, under its daily cap.",
      visible_to: "Your Team; recipients of what it then sends.",
      budget_rows: [],
      retry: "Safe: a second call on a Mailbox that already sends answers MAILBOX_STATE_CONFLICT.",
      undo: "`curviate mailbox pause <id>`.",
      blast_radius: "One Mailbox's sending.",
    },
    errors: { ...NOT_FOUND, MAILBOX_STATE_CONFLICT: "the Mailbox is not paused by a person, or its pause is not yours to lift." },
    seeAlso: ["curviate mailbox pause"],
    examples: ["curviate mailbox resume mbx_YOUR_MAILBOX_ID"],
  },
  args: { ...WRITE_SINGLE_FLAGS, id: ID },
  run: online(act("resume")),
});

const removeCmd = defineCommand({
  meta: {
    name: "remove",
    description: "Remove a Mailbox and delete its stored credentials in one step. Changes no seat count and makes no billing call. Connect it again to use the address afterwards.",
    risk: "high",
    rules: {
      changes: "The Mailbox and its credentials are deleted; emails due from it are not sent.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "Safe: a second call answers MAILBOX_NOT_FOUND.",
      undo: "None: connect the address again.",
      blast_radius: "One Mailbox and every Campaign that sends from it.",
    },
    errors: NOT_FOUND,
    seeAlso: ["curviate mailbox list", "curviate mailbox pause"],
    examples: ["curviate mailbox remove mbx_YOUR_MAILBOX_ID"],
  },
  args: { ...WRITE_SINGLE_FLAGS, id: ID },
  run: online(act("remove")),
});

export const mailboxCommand = defineCommand({
  meta: { name: "mailbox", description: DESCRIPTIONS["mailbox"] },
  subCommands: { list: listCmd, get: getCmd, update: updateCmd, pause: pauseCmd, resume: resumeCmd, remove: removeCmd },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(mailboxCommand, ["curviate", "mailbox"]);
  },
});
