/**
 * `curviate lead lists` and `curviate lead tags`: Lead lists and Tags.
 * Root-scoped (`curviate.contactLists.*`, `tags.*`; membership and tagging are
 * the Leads bulk update). Membership and tag changes name Leads by id
 * (sent in requests of BULK_MAX_IDS) or by filter (one request).
 */
import { defineCommand } from "citty";
import type { Curviate } from "@curviate/sdk";
import { GLOBAL_FLAGS, READ_SINGLE_FLAGS, WRITE_SINGLE_FLAGS, readOnly } from "../lib/global-flags.js";
import { renderSuccess, writeNdjsonItem } from "../lib/output.js";
import { streamAll, pageDelayFromFlags, readCursorFlag, readMaxPagesFlag, readableObject, readablePage, rejectPaginationModifiersWithoutAll } from "../lib/paginate.js";
import { intFlag } from "../lib/int-flag.js";
import { sendInChunks } from "../lib/chunks.js";
import { fail, listFlag, outputOpts, usage } from "../lib/root-command.js";
import { FILTER_ARGS, hasFilter, readFilter } from "../lib/contact-filter.js";
import { BULK_MAX_IDS, contactIds, mergeChunks, online, preview, type ContactFlags } from "./contact.js";

type Body = Record<string, unknown>;
const show = (result: unknown, f: ContactFlags) => renderSuccess(result, outputOpts(f), process);
const required = (flag: string, v: string | undefined, what: string): string => {
  if (v === undefined || v.trim() === "") usage(`--${flag} is required: ${what}.`);
  return v;
};

/** A page read: one page, or every page as NDJSON with --all. */
async function page(f: ContactFlags, params: Body, fetchPage: (p: Body) => Promise<unknown>): Promise<void> {
  rejectPaginationModifiersWithoutAll(f, process);
  if (f.limit !== undefined) params["limit"] = intFlag("limit", f.limit, 1, 100);
  const cursor = readCursorFlag(f, process);
  if (cursor) params["cursor"] = cursor;
  try {
    if (f.all) {
      const next = (p: Body) => fetchPage(p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(next, params, { maxPages: readMaxPagesFlag(f, process), out: process, pageDelayMs: pageDelayFromFlags(f) })) writeNdjsonItem(process, item, f.fields);
    } else {
      show(readablePage(await fetchPage(params)), f);
    }
  } catch (err) {
    await fail(err, f);
  }
}

/** Positional-or-flag text that must not be blank. */
const named = (what: string, v: string | undefined): string => {
  if (v === undefined || v.trim() === "") usage(`${what} is empty.`);
  return v;
};

/**
 * Membership and tagging: the bulk update, with Leads named by id (after the
 * first `skip` positionals) or by filter flags, never both and never neither.
 */
async function bulkUpdate(c: Curviate, f: ContactFlags, skip: number, change: Body): Promise<void> {
  const ids = contactIds(f, skip);
  const filtered = hasFilter(f);
  if (filtered && ids.length) usage("name the Leads either by id or with filter flags, not both.");
  if (!filtered && !ids.length) usage("name the Leads: one or more Lead ids (con_...), --ids, or filter flags such as --list or --tag.");
  try {
    if (filtered) {
      const body = { filter: await readFilter(c, f, "body"), ...change };
      if (f.preview) return preview("leads.updateMany", {}, body);
      return show(await c.leads.updateMany(body as never), f);
    }
    if (f.preview) return preview("leads.updateMany", {}, { lead_ids: ids.slice(0, BULK_MAX_IDS), ...change });
    show(mergeChunks(await sendInChunks(ids, BULK_MAX_IDS, (chunk) => c.leads.updateMany({ lead_ids: chunk, ...change } as never), f)), f);
  } catch (err) {
    await fail(err, f);
  }
}

// ---------------------------------------------------------------------------
// Lead lists
// ---------------------------------------------------------------------------

const ID = { type: "positional" as const, description: "Lead list id (cl_...)." };
const IDS = {
  id: { type: "positional" as const, required: false, variadic: true, description: "Lead id (con_...); several may follow." },
  ids: { type: "string" as const, description: `Lead ids (con_...); repeatable, or a comma list. Sent in requests of up to ${BULK_MAX_IDS} ids, in order; a failed request stops the run and reports what was sent.` },
};
const SEE_LISTS = ["curviate lead lists get", "curviate lead list"];
const BULK_ERRORS = { INSUFFICIENT_ROLE: "your role cannot change Leads here.", LEAD_LIMIT_REACHED: "a Tag or list-membership cap would be exceeded (the Lead is under `refused`)." };
const BULK_OUTPUT = ["`updated`, `unchanged`, `not_found` (ids that did not exist) and `refused` (a Lead over a cap, with the reason). Counts are summed over every request."];
const BULK_RADIUS = `By id: up to ${BULK_MAX_IDS} Leads per request. By filter: every Lead the filter matches; count it first with \`curviate lead list <same filters> --total --limit 1\`.`;

const listsList = defineCommand({
  meta: {
    name: "list",
    description: "List your Team's Lead lists, with how many Leads each holds.",
    risk: "read",
    examples: ["curviate lead lists list", "curviate lead lists list --query warm"],
  },
  args: { ...readOnly(GLOBAL_FLAGS), query: { type: "string", description: "Only lists whose name matches this text." } },
  run: online((c, f) => page(f, f.query !== undefined ? { q: named("--query", f.query) } : {}, (p) => c.leadLists.list(p as never))),
});

const listsGet = defineCommand({
  meta: { name: "get", description: "One Lead list: its name, description and Lead count.", risk: "read", examples: ["curviate lead lists get cl_YOUR_LIST_ID"] },
  args: { ...readOnly(READ_SINGLE_FLAGS), id: ID },
  run: online(async (c, f) => {
    try {
      show(readableObject(await c.leadLists.get(String(f.id ?? ""))), f);
    } catch (err) {
      await fail(err, f);
    }
  }),
});

const listsCreate = defineCommand({
  meta: {
    name: "create",
    description: "Create an empty Lead list. Fill it with `curviate lead lists add`, `curviate lead import --list`, or build it from other lists with `curviate lead lists combine`. Needs Automate.",
    risk: "write",
    rules: {
      changes: "A new, empty Lead list.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "Not safe: a list name is unique, so a repeat answers NAME_TAKEN.",
      undo: "`curviate lead lists delete <id>`.",
    },
    errors: { NAME_TAKEN: "a list of that name exists (409)." },
    examples: ["curviate lead lists create \"Q4 prospects\" --description \"From the conference\""],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    name: { type: "positional", description: "The list's name (up to 100 characters)." },
    description: { type: "string", description: "What the list is for (up to 500 characters)." },
  },
  run: online(async (c, f) => {
    const body: Body = { name: named("the list name", (f as { name?: string }).name) };
    if ((f as { description?: string }).description !== undefined) body["description"] = (f as { description?: string }).description;
    if (f.preview) return preview("leadLists.create", {}, body);
    try {
      show(readableObject(await c.leadLists.create(body as never)), f);
    } catch (err) {
      await fail(err, f);
    }
  }),
});

const listsCombine = defineCommand({
  meta: {
    name: "combine",
    description:
      "Create a new Lead list from other lists: the Leads in any of them (--list a --list b), in all of them (--list-match all), minus those in some others (--not-list). " +
      "Any other filter flag narrows it too. The new list holds the Leads that match now; it does not follow later changes to the source lists. Needs Automate.",
    risk: "write",
    rules: {
      changes: "A new Lead list holding every Lead the filter matches at this moment. The source lists are unchanged.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "Not safe: a list name is unique, so a repeat answers NAME_TAKEN.",
      undo: "`curviate lead lists delete <id>`; the Leads stay.",
    },
    errors: { NAME_TAKEN: "a list of that name exists (409).", LEAD_LIMIT_REACHED: "the Team is at a list-membership cap." },
    seeAlso: SEE_LISTS,
    examples: [
      "curviate lead lists combine \"Hot or warm\" --list cl_HOT --list cl_WARM",
      "curviate lead lists combine \"Hot and replied\" --list cl_HOT --list cl_REPLIED --list-match all --not-list cl_DNC",
    ],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    name: { type: "positional", description: "The new list's name (up to 100 characters)." },
    ...FILTER_ARGS,
    description: { type: "string", description: "What the list is for (up to 500 characters)." },
  },
  run: online(async (c, f) => {
    if (listFlag("list", f.list).length === 0) usage("--list is required: the source list or lists (cl_...), repeatable.");
    const body: Body = { name: named("the list name", (f as { name?: string }).name), from: await readFilter(c, f, "body") };
    if ((f as { description?: string }).description !== undefined) body["description"] = (f as { description?: string }).description;
    if (f.preview) return preview("leadLists.create", {}, body);
    try {
      show(readableObject(await c.leadLists.create(body as never)), f);
    } catch (err) {
      await fail(err, f);
    }
  }),
});

const listsUpdate = defineCommand({
  meta: {
    name: "update",
    description: "Rename a Lead list or change its description (--description \"\" clears it). Needs Automate.",
    risk: "write",
    rules: {
      changes: "The list's name or description.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "Safe: the same call leaves the same list.",
      undo: "Update again with the old values.",
    },
    errors: { NAME_TAKEN: "a list of that name exists (409)." },
    examples: ["curviate lead lists update cl_YOUR_LIST_ID --name \"Q4 prospects\""],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    id: ID,
    name: { type: "string", description: "The new name (up to 100 characters)." },
    description: { type: "string", description: "The new description (up to 500 characters); empty clears it." },
  },
  run: online(async (c, f) => {
    const { name, description } = f as { name?: string; description?: string };
    const body: Body = {};
    if (name !== undefined) body["name"] = named("--name", name);
    if (description !== undefined) body["description"] = description === "" ? null : description;
    if (Object.keys(body).length === 0) usage("name what to change: --name or --description.");
    if (f.preview) return preview("leadLists.update", { id: f.id }, body);
    try {
      show(readableObject(await c.leadLists.update(String(f.id ?? ""), body as never)), f);
    } catch (err) {
      await fail(err, f);
    }
  }),
});

const listsDelete = defineCommand({
  meta: {
    name: "delete",
    description: "Delete a Lead list. Its Leads stay; a Campaign that enrolls from it needs another list. Any role may.",
    risk: "high",
    rules: {
      changes: "The list and its memberships are deleted; the Leads are not.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "Safe: a second call answers RESOURCE_NOT_FOUND.",
      undo: "Cannot be undone for the list itself: create it again and add the Leads.",
      blast_radius: "One list and its membership; no Lead is deleted.",
    },
    errors: { RESOURCE_IN_USE: "a Campaign still uses the list (409)." },
    seeAlso: SEE_LISTS,
    examples: ["curviate lead lists delete cl_YOUR_LIST_ID"],
  },
  args: { ...WRITE_SINGLE_FLAGS, id: ID },
  run: online(async (c, f) => {
    if (f.preview) return preview("leadLists.delete", { id: f.id });
    try {
      await c.leadLists.delete(String(f.id ?? ""));
      show({}, f);
    } catch (err) {
      await fail(err, f);
    }
  }),
});

const membership = (verb: "add" | "remove") =>
  defineCommand({
    meta: {
      name: verb,
      description:
        `${verb === "add" ? "Add Leads to" : "Remove Leads from"} a Lead list. Name the Leads by id, or with filter flags (the same as \`curviate lead list\`) to act on every match. ` +
        "Count a filter first: `curviate lead list <same filters> --total --limit 1`. The list being changed is the positional id; to filter by another list use --from-list (`lead list` calls it --list). Needs Automate.",
      risk: "high",
      rules: {
        changes: verb === "add" ? "The Leads join the list." : "The Leads leave the list; they are not deleted.",
        visible_to: "Your Team; a Campaign enrolling from the list sees the change.",
        budget_rows: [],
        retry: "Safe: a Lead already in (or out) is `unchanged`.",
        undo: verb === "add" ? "`curviate lead lists remove` with the same Leads." : "`curviate lead lists add` with the same Leads.",
        blast_radius: BULK_RADIUS,
      },
      errors: BULK_ERRORS,
      output: BULK_OUTPUT,
      seeAlso: SEE_LISTS,
      examples: [
        `curviate lead lists ${verb} cl_YOUR_LIST_ID con_A con_B`,
        `curviate lead lists ${verb} cl_YOUR_LIST_ID --tag hot --no-email`,
        `curviate lead lists ${verb} cl_YOUR_LIST_ID --from-list cl_SOURCE_LIST_ID --connected`,
      ],
    },
    args: {
      ...WRITE_SINGLE_FLAGS,
      listId: { type: "positional", description: "Lead list id (cl_...)." },
      ...IDS,
      ...Object.fromEntries(Object.entries(FILTER_ARGS).filter(([k]) => k !== "list")),
      "from-list": { type: "string", description: "Filter: only Leads in this Lead list (cl_...); repeatable, or a comma list." },
    },
    run: online(async (c, f) => {
      const listId = named("the list id", (f._ ?? [])[0]);
      // `--from-list` is the filter's `--list` here: the list being changed already took that word.
      const fromList = (f as { "from-list"?: string | string[] })["from-list"];
      const filtered = { ...f, ...(fromList !== undefined ? { list: fromList } : {}) } as ContactFlags;
      await bulkUpdate(c, filtered, 1, verb === "add" ? { add_list_id: listId } : { remove_list_id: listId });
    }),
  });

export const contactListsCommand = defineCommand({
  meta: { name: "lists", description: "Lead lists: named sets of Leads a Campaign enrolls from." },
  subCommands: { list: listsList, get: listsGet, create: listsCreate, combine: listsCombine, update: listsUpdate, delete: listsDelete, add: membership("add"), remove: membership("remove") },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(contactListsCommand, ["curviate", "lead", "lists"]);
  },
});

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

const TAG_ID = { type: "positional" as const, description: "Tag id, from `curviate lead tags list`." };

const tagsList = defineCommand({
  meta: { name: "list", description: "List your Team's Tags with how many Leads carry each.", risk: "read", examples: ["curviate lead tags list"] },
  args: { ...readOnly(GLOBAL_FLAGS) },
  run: online((c, f) => page(f, {}, (p) => c.tags.list(p as never))),
});

const tagsUpdate = defineCommand({
  meta: {
    name: "update",
    description: "Rename a Tag on every Lead that carries it. A name another Tag has is refused. Needs Automate.",
    risk: "write",
    rules: {
      changes: "The Tag's name, on all its Leads.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "Safe: the same call leaves the same name.",
      undo: "Rename it back.",
    },
    errors: { NAME_TAKEN: "a Tag of that name exists (409)." },
    examples: ["curviate lead tags update TAG_ID --name warm-lead"],
  },
  args: { ...WRITE_SINGLE_FLAGS, id: TAG_ID, name: { type: "string", required: true, description: "The new name (up to 64 characters)." } },
  run: online(async (c, f) => {
    const name = required("name", (f as { name?: string }).name, "the Tag's new name");
    if (f.preview) return preview("tags.update", { id: f.id }, { name });
    try {
      show(readableObject(await c.tags.update(String(f.id ?? ""), { name })), f);
    } catch (err) {
      await fail(err, f);
    }
  }),
});

const tagsDelete = defineCommand({
  meta: {
    name: "delete",
    description: "Delete a Tag and take it off every Lead that carries it. Owners and Managers only.",
    risk: "high",
    rules: {
      changes: "The Tag is removed from every Lead; the Leads stay.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "Safe: a second call answers RESOURCE_NOT_FOUND.",
      undo: "Cannot be undone: tag the Leads again.",
      blast_radius: "One Tag, on every Lead that carries it (its `lead_count`).",
    },
    errors: { INSUFFICIENT_ROLE: "deleting Tags is for Owners and Managers." },
    seeAlso: ["curviate lead tags list"],
    examples: ["curviate lead tags delete TAG_ID"],
  },
  args: { ...WRITE_SINGLE_FLAGS, id: TAG_ID },
  run: online(async (c, f) => {
    if (f.preview) return preview("tags.delete", { id: f.id });
    try {
      await c.tags.delete(String(f.id ?? ""));
      show({}, f);
    } catch (err) {
      await fail(err, f);
    }
  }),
});

const tagging = (verb: "add" | "remove") =>
  defineCommand({
    meta: {
      name: verb,
      description:
        `${verb === "add" ? "Put a Tag on" : "Take a Tag off"} Leads, named by id or with filter flags (the same as \`curviate lead list\`) to act on every match. ` +
        "Count a filter first: `curviate lead list <same filters> --total --limit 1`. Needs Automate.",
      risk: "high",
      rules: {
        changes: verb === "add" ? "The Tag is put on the Leads (created if new)." : "The Tag is taken off the Leads.",
        visible_to: "Your Team.",
        budget_rows: [],
        retry: "Safe: a Lead already tagged (or not) is `unchanged`.",
        undo: verb === "add" ? "`curviate lead tags remove` with the same Leads." : "`curviate lead tags add` with the same Leads.",
        blast_radius: BULK_RADIUS,
      },
      errors: BULK_ERRORS,
      output: BULK_OUTPUT,
      seeAlso: ["curviate lead tags list", "curviate lead list"],
      examples: [`curviate lead tags ${verb} hot con_A con_B`, `curviate lead tags ${verb} hot --list cl_YOUR_LIST_ID`],
    },
    args: {
      ...WRITE_SINGLE_FLAGS,
      tagName: { type: "positional", description: "The Tag's name (up to 64 characters), any casing." },
      ...IDS,
      ...FILTER_ARGS,
    },
    run: online(async (c, f) => {
      const tag = named("the Tag name", (f._ ?? [])[0]);
      await bulkUpdate(c, f, 1, verb === "add" ? { add_tags: [tag] } : { remove_tags: [tag] });
    }),
  });

export const contactTagsCommand = defineCommand({
  meta: { name: "tags", description: "Tags: labels on Leads." },
  subCommands: { list: tagsList, update: tagsUpdate, delete: tagsDelete, add: tagging("add"), remove: tagging("remove") },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(contactTagsCommand, ["curviate", "lead", "tags"]);
  },
});

