/**
 * `curviate incoming`: incoming events. Each is a private URL any tool posts
 * to; Curviate finds the Contact in the post and moves the Enrollments waiting
 * for that event. The URL is a secret: shown whole only by `create` and
 * `rotate`, masked on every read.
 */
import { defineCommand } from "citty";
import type { Curviate } from "@curviate/sdk";
import { DESCRIPTIONS } from "./descriptions.js";
import { GLOBAL_FLAGS, READ_SINGLE_FLAGS, WRITE_SINGLE_FLAGS, readOnly } from "../lib/global-flags.js";
import { renderSuccess, writeNdjsonItem } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { streamAll, pageDelayFromFlags, readCursorFlag, readMaxPagesFlag, readablePage, rejectPaginationModifiersWithoutAll } from "../lib/paginate.js";
import { intFlag } from "../lib/int-flag.js";
import { fail, outputOpts, rootClient, usage, type RootFlags } from "../lib/root-command.js";

type Flags = RootFlags & {
  id?: string;
  event?: string;
  "event-name"?: string;
  "event-name-field"?: string;
  motion?: string;
  "match-enrollment-id"?: string;
  "match-linkedin-url"?: string;
  "match-email"?: string;
  "required-header"?: string;
  enabled?: boolean;
  limit?: string;
  cursor?: string;
  all?: boolean;
  "max-pages"?: string;
  "page-delay"?: string;
};
type Row = Record<string, unknown>;

/** The create/update body from the flags; only what was given. An empty value clears a nullable field. */
function body(f: Flags): Row {
  const b: Row = {};
  const nul = (v: string) => (v === "" ? null : v);
  if (f["event-name"] !== undefined) b["event_name"] = nul(f["event-name"]);
  if (f["event-name-field"] !== undefined) b["event_name_field"] = nul(f["event-name-field"]);
  if (f.motion !== undefined) b["motion_id"] = nul(f.motion);
  const match: Row = {};
  if (f["match-enrollment-id"] !== undefined) match["enrollment_id"] = nul(f["match-enrollment-id"]);
  if (f["match-linkedin-url"] !== undefined) match["linkedin_url"] = nul(f["match-linkedin-url"]);
  if (f["match-email"] !== undefined) match["email"] = nul(f["match-email"]);
  if (Object.keys(match).length) b["match"] = match;
  if (f["required-header"] !== undefined) {
    const h = f["required-header"];
    const i = h.indexOf(":");
    b["required_header"] = h === "" ? null : i < 0 ? { name: h.trim() } : { name: h.slice(0, i).trim(), value: h.slice(i + 1).trim() };
  }
  if (f.enabled !== undefined) b["enabled"] = f.enabled;
  return b;
}

const id = (f: Flags) => String(f.id ?? "");

const call = (method: string, fn: (c: Curviate, f: Flags) => Promise<unknown>, send: (f: Flags) => Row | undefined = () => undefined) =>
  async (c: Curviate, f: Flags): Promise<void> => {
    const b = send(f);
    if (f.preview) return void process.stdout.write(JSON.stringify(buildPreviewOutput({ method, args: f.id === undefined ? {} : { id: f.id }, body: b ?? {} })) + "\n");
    try {
      renderSuccess(await fn(c, f), outputOpts(f), process);
    } catch (err) {
      await fail(err, f);
    }
  };

async function runCreate(c: Curviate, f: Flags): Promise<void> {
  if ((f["event-name"] === undefined) === (f["event-name-field"] === undefined)) usage("pass exactly one of --event-name or --event-name-field.");
  await call("incomingEvents.create", (cl, fl) => cl.incomingEvents.create(body(fl) as never), body)(c, f);
}

async function runList(c: Curviate, f: Flags): Promise<void> {
  rejectPaginationModifiersWithoutAll(f, process);
  const q: Row = {};
  if (f.event !== undefined) q["event"] = f.event;
  if (f.limit !== undefined) q["limit"] = intFlag("limit", f.limit, 1, 100);
  const cursor = readCursorFlag(f, process);
  if (cursor) q["cursor"] = cursor;
  try {
    if (f.all) {
      const page = (p: Row) => c.incomingEvents.list(p as never) as unknown as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(page, q, { maxPages: readMaxPagesFlag(f, process), out: process, pageDelayMs: pageDelayFromFlags(f) })) writeNdjsonItem(process, item, f.fields);
      return;
    }
    renderSuccess(readablePage(await c.incomingEvents.list(q as never)), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

const online = (fn: (c: Curviate, f: Flags) => Promise<void>) => async ({ args }: { args: unknown }) => {
  const f = args as Flags;
  await fn(await rootClient(f), f);
};

const ID = { type: "positional" as const, description: "Incoming event id (inc_...)." };
const EDITOR = { INSUFFICIENT_ROLE: "only its creator (or an Owner, when it has none) can change it." };
const FIELDS = {
  "event-name": { type: "string" as const, description: "The fixed event name every post carries (for example reply_received). Exactly one of this and --event-name-field on create." },
  "event-name-field": { type: "string" as const, description: "The path in the post the event name is read from (for example event_type)." },
  motion: { type: "string" as const, description: "Only this Motion's Enrollments move (mot_...); empty for any Motion's." },
  "match-enrollment-id": { type: "string" as const, description: "Path in the post to an Enrollment id (for example custom_variables.enrollment_id); empty removes it." },
  "match-linkedin-url": { type: "string" as const, description: "Path in the post to the person's LinkedIn URL; empty removes it." },
  "match-email": { type: "string" as const, description: "Path in the post to an email address the Contact already has (for example lead_email); empty removes it. Paths are tried in the order enrollment id, LinkedIn URL, email." },
  "required-header": { type: "string" as const, description: "NAME:VALUE every post must carry, else 401; NAME alone keeps the stored value; empty removes it." },
};

const createCmd = defineCommand({
  meta: {
    name: "create",
    description: "Create an incoming event: a private URL, printed once, that any tool posts to. Treat the URL like a password. Needs Automate.",
    risk: "write",
    rules: {
      changes: "Creates the URL; posts to it move the matching Enrollments waiting for the event.",
      visible_to: "Your Team (the URL masked); whoever you give the URL to can post.",
      budget_rows: [],
      retry: "Each call creates another URL.",
      undo: "`curviate incoming delete <id>`.",
    },
    errors: { MOTION_NOT_FOUND: "no Motion with that id." },
    examples: ["curviate incoming create --event-name reply_received --match-email lead_email"],
  },
  args: { ...WRITE_SINGLE_FLAGS, ...FIELDS },
  run: online(runCreate),
});

const listCmd = defineCommand({
  meta: {
    name: "list",
    description: "Your Team's incoming events, URLs masked, with the last arrival and the Motion steps waiting for each.",
    risk: "read",
    examples: ["curviate incoming list", "curviate incoming list --event reply_received"],
  },
  args: { ...readOnly(GLOBAL_FLAGS), event: { type: "string" as const, description: "Only incoming events with this event name." } },
  run: online(runList),
});

const getCmd = defineCommand({
  meta: { name: "get", description: "One incoming event, URL masked: its match paths, captured sample shape, arrivals and where it is used.", risk: "read", examples: ["curviate incoming get inc_YOUR_INCOMING_ID"] },
  args: { ...readOnly(READ_SINGLE_FLAGS), id: ID },
  run: online(call("incomingEvents.get", (c, f) => c.incomingEvents.get(id(f)))),
});

const updateCmd = defineCommand({
  meta: {
    name: "update",
    description: "Change an incoming event's name, Motion, match paths, required header or turn it off; the URL stays.",
    risk: "write",
    rules: { changes: "Changes how later posts are read.", visible_to: "Your Team.", budget_rows: [], retry: "Safe to repeat: the same values again.", undo: "Update it back." },
    errors: EDITOR,
    examples: ["curviate incoming update inc_YOUR_INCOMING_ID --no-enabled"],
  },
  args: { ...WRITE_SINGLE_FLAGS, id: ID, ...FIELDS, enabled: { type: "boolean" as const, description: "--enabled turns it on, --no-enabled off (posts answer 404)." } },
  run: online(call("incomingEvents.update", (c, f) => c.incomingEvents.update(id(f), body(f) as never), body)),
});

const deleteCmd = defineCommand({
  meta: {
    name: "delete",
    description: "Delete an incoming event: its URL stops working at once, and Motion steps waiting for it wait until their timeout.",
    risk: "high",
    rules: {
      changes: "Deletes the URL; later posts answer 404.",
      visible_to: "The tools posting to it.",
      budget_rows: [],
      retry: "A second delete answers RESOURCE_NOT_FOUND.",
      undo: "Cannot be undone; create a new one (a new URL).",
      blast_radius: "One URL and every Enrollment that would have moved on it.",
    },
    errors: EDITOR,
    seeAlso: ["curviate incoming list"],
    examples: ["curviate incoming delete inc_YOUR_INCOMING_ID"],
  },
  args: { ...WRITE_SINGLE_FLAGS, id: ID },
  run: online(call("incomingEvents.delete", async (c, f) => (await c.incomingEvents.delete(id(f))) ?? {})),
});

const rotateCmd = defineCommand({
  meta: {
    name: "rotate",
    description: "Replace the URL's secret: the new URL is printed once and the old one stops working at once. Needs Automate.",
    risk: "high",
    rules: {
      changes: "A new URL; posts to the old one answer 404.",
      visible_to: "Every tool posting to the old URL, until you give it the new one.",
      budget_rows: [],
      retry: "Each call issues another URL.",
      undo: "Cannot be undone.",
      blast_radius: "One URL and every tool posting to it.",
    },
    errors: EDITOR,
    seeAlso: ["curviate incoming get"],
    examples: ["curviate incoming rotate inc_YOUR_INCOMING_ID"],
  },
  args: { ...WRITE_SINGLE_FLAGS, id: ID },
  run: online(call("incomingEvents.rotate", (c, f) => c.incomingEvents.rotate(id(f)))),
});

const captureCmd = defineCommand({
  meta: {
    name: "capture",
    description: "Capture the next post as the sample: its field paths (never its values' meaning) become the shape the match paths and Sequences are checked against. Needs Automate.",
    risk: "write",
    rules: { changes: "The next post's shape replaces the captured sample.", visible_to: "Your Team.", budget_rows: [], retry: "Safe to repeat: it waits for the next post.", undo: "Capture again." },
    errors: EDITOR,
    examples: ["curviate incoming capture inc_YOUR_INCOMING_ID"],
  },
  args: { ...WRITE_SINGLE_FLAGS, id: ID },
  run: online(call("incomingEvents.capture", (c, f) => c.incomingEvents.capture(id(f)))),
});

const arrivalsCmd = defineCommand({
  meta: { name: "arrivals", description: "The latest posts to the URL: when, the event name, which Contact matched and how many Enrollments moved.", risk: "read", examples: ["curviate incoming arrivals inc_YOUR_INCOMING_ID"] },
  args: { ...readOnly(READ_SINGLE_FLAGS), id: ID },
  run: online(call("incomingEvents.arrivals", (c, f) => c.incomingEvents.arrivals(id(f)))),
});

export const incomingCommand = defineCommand({
  meta: { name: "incoming", description: DESCRIPTIONS.incoming },
  subCommands: { create: createCmd, list: listCmd, get: getCmd, update: updateCmd, delete: deleteCmd, rotate: rotateCmd, capture: captureCmd, arrivals: arrivalsCmd },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(incomingCommand, ["curviate", "incoming"]);
  },
});
