/**
 * `curviate notification`: Curviate's own Notifications (an account needing
 * reconnection, a paused Motion, a finished import, a member leaving). Yours,
 * per Team. Root-scoped (`curviate.notifications.*`).
 *
 * Not LinkedIn's notification cards: those are `curviate core notification`
 * (`src/commands/notification.ts`), which is why the card verbs (`delete`,
 * `show-less`) are not declared here: a stale `notification delete <card_urn>`
 * must exit 2, not act on a different object.
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
  _?: string[];
  unread?: boolean;
  archived?: boolean;
  to?: string;
  limit?: string;
  cursor?: string;
  all?: boolean;
  "max-pages"?: string;
  "page-delay"?: string;
};

type Item = { id?: string; read?: boolean };

const online = (fn: (c: Curviate, f: Flags) => Promise<void>) => async ({ args }: { args: unknown }) => {
  const f = args as Flags;
  await fn(await rootClient(f), f);
};

function preview(method: string, args: Record<string, unknown>, body: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(buildPreviewOutput({ method, args, body })) + "\n");
}

/** The ids given (citty's `_` holds every positional, the declared one included), none empty. */
function ids(f: Flags): string[] {
  const all = (f._ && f._.length > 0 ? f._ : f.id !== undefined ? [f.id] : []).map(String);
  if (all.length === 0 || all.some((v) => v.trim() === "")) usage("pass one or more notification ids (from `curviate notification list`).");
  return all;
}

// ---------------------------------------------------------------------------

async function runList(c: Curviate, f: Flags): Promise<void> {
  rejectPaginationModifiersWithoutAll(f, process);
  // --unread / --archived pick the stream; --no-unread keeps the read items of it (client side); --no-archived is what "all" already is.
  if (f.unread === true && f.archived === true) usage("--unread and --archived cannot be combined: an item is archived or unread, not both. Pass one.");
  const params: Record<string, unknown> = { filter: f.unread === true ? "unread" : f.archived === true ? "archived" : "all" };
  if (f.limit !== undefined) params["limit"] = intFlag("limit", f.limit, 1, 100);
  const cursor = readCursorFlag(f, process);
  if (cursor) params["cursor"] = cursor;
  const keep = (item: Item) => f.unread !== false || item.read === true;
  const opts = outputOpts(f);
  try {
    if (f.all) {
      const page = (p: Record<string, unknown>) => c.notifications.list(p as never) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(page, params, { maxPages: readMaxPagesFlag(f, process), out: process, pageDelayMs: pageDelayFromFlags(f) })) {
        if (keep(item as Item)) writeNdjsonItem(process, item, f.fields);
      }
      return;
    }
    const result = readablePage(await c.notifications.list(params as never)) as { items: Item[] };
    renderSuccess({ ...result, items: result.items.filter(keep) }, opts, process);
  } catch (err) {
    await fail(err, f);
  }
}

async function runCount(c: Curviate, f: Flags): Promise<void> {
  try {
    renderSuccess(readableObject(await c.notifications.unreadCount()), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

/** read / archive / unarchive: one PATCH per id. A 404 is reported and the rest still apply; its exit comes last. */
const update = (body: { read?: true; archived?: boolean }) => async (c: Curviate, f: Flags): Promise<void> => {
  const all = ids(f);
  if (f.preview) return preview("notifications.update", { ids: all }, body);
  const { CurviateError } = await import("@curviate/sdk");
  const updated: unknown[] = [];
  const notFound: string[] = [];
  let notFoundError: unknown;
  for (const id of all) {
    try {
      updated.push(readableObject(await c.notifications.update(id, body)));
    } catch (err) {
      if (err instanceof CurviateError && err.code === "RESOURCE_NOT_FOUND") {
        notFound.push(id);
        notFoundError ??= err;
      } else {
        return fail(err, f);
      }
    }
  }
  renderSuccess({ updated, not_found: notFound }, outputOpts(f), process);
  if (notFoundError) {
    process.stderr.write(`error: ${notFound.length} of ${all.length} notifications were not found (not yours, or already gone): ${notFound.join(", ")}. The others were applied.\n`);
    const { getExitCode } = await import("../lib/exit-codes.js");
    process.exit(getExitCode(notFoundError as never));
  }
};

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

async function runReadAll(c: Curviate, f: Flags): Promise<void> {
  if (f.to !== undefined && !ISO_WITH_OFFSET.test(f.to)) usage("--to takes an ISO 8601 instant with an offset, e.g. 2026-10-08T10:00:00Z.");
  const body = f.to === undefined ? {} : { before: f.to };
  if (f.preview) return preview("notifications.markAllRead", {}, body);
  try {
    renderSuccess(readableObject(await c.notifications.markAllRead(body)), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

// ---------------------------------------------------------------------------

const ID = { type: "positional" as const, variadic: true, description: "Notification id (ntf_...), from `curviate notification list`. Several may follow." };
const IDS_OUTPUT = ["`updated` (the notifications as they now stand) and `not_found` (ids that are not yours). Exit 4 when any was not found; the others were still applied."];
const SEE = ["curviate notification list", "curviate core notification"];

const listCmd = defineCommand({
  meta: {
    name: "list",
    description:
      "List your Curviate Notifications, newest first, with the unread count. Curviate's own, per Team; LinkedIn's notification cards are `curviate core notification list`. " +
      "--unread lists unread ones, --archived archived ones, neither all (archived kept apart); --no-unread keeps only read ones. Kept for 90 days.",
    risk: "read",
    output: ["`items`, a `cursor` for the next page, and `unread_count`, the Team-wide unread badge, not a count of the items shown."],
    examples: ["curviate notification list", "curviate notification list --unread", "curviate notification list --archived --limit 50"],
  },
  args: {
    ...readOnly(GLOBAL_FLAGS),
    unread: { type: "boolean", description: "Only unread notifications (--no-unread: only read ones). Not with --archived." },
    archived: { type: "boolean", description: "Only archived notifications (--no-archived: not archived, which is also the default)." },
  },
  run: online(runList),
});

const countCmd = defineCommand({
  meta: {
    name: "count",
    description: "Your unread Curviate Notifications: the number only. Check it at the start of a session.",
    risk: "read",
    examples: ["curviate notification count"],
  },
  args: { ...readOnly(READ_SINGLE_FLAGS) },
  run: online(runCount),
});

const markRules = (changes: string, undo: string) => ({
  changes,
  visible_to: "Only you; no one else's notifications change.",
  budget_rows: [] as string[],
  retry: "Safe: setting a flag that is already set changes nothing.",
  undo,
});

const readCmd = defineCommand({
  meta: {
    name: "read",
    description: "Mark one or more of your notifications read. Each id is its own request; one that is not yours is reported and the rest still apply.",
    risk: "write",
    rules: markRules("The notifications are marked read.", "Cannot be undone: a notification cannot be marked unread."),
    errors: { RESOURCE_NOT_FOUND: "an id is not one of your notifications (reported, exit 4, the others still apply)." },
    output: IDS_OUTPUT,
    examples: ["curviate notification read ntf_YOUR_NOTIFICATION_ID", "curviate notification read ntf_A ntf_B"],
  },
  args: { ...WRITE_SINGLE_FLAGS, id: ID },
  run: online(update({ read: true })),
});

const archiveCmd = defineCommand({
  meta: {
    name: "archive",
    description: "Archive one or more of your notifications: marked read and moved out of `list` into `list --archived`. A notification that is not yours is reported and the rest still apply.",
    risk: "write",
    rules: markRules("The notifications are archived (and marked read).", "`curviate notification unarchive <id>`; the read mark stays."),
    errors: { RESOURCE_NOT_FOUND: "an id is not one of your notifications (reported, exit 4, the others still apply)." },
    output: IDS_OUTPUT,
    seeAlso: ["curviate notification unarchive"],
    examples: ["curviate notification archive ntf_YOUR_NOTIFICATION_ID", "curviate notification archive ntf_A ntf_B"],
  },
  args: { ...WRITE_SINGLE_FLAGS, id: ID },
  run: online(update({ archived: true })),
});

const unarchiveCmd = defineCommand({
  meta: {
    name: "unarchive",
    description: "Move one or more archived notifications back into your list; they stay read.",
    risk: "write",
    rules: markRules("The notifications are unarchived.", "`curviate notification archive <id>`."),
    errors: { RESOURCE_NOT_FOUND: "an id is not one of your notifications (reported, exit 4, the others still apply)." },
    output: IDS_OUTPUT,
    seeAlso: ["curviate notification archive"],
    examples: ["curviate notification unarchive ntf_YOUR_NOTIFICATION_ID"],
  },
  args: { ...WRITE_SINGLE_FLAGS, id: ID },
  run: online(update({ archived: false })),
});

const readAllCmd = defineCommand({
  meta: {
    name: "read-all",
    description:
      "Mark all your unread notifications read, up to a moment: --to, an ISO 8601 instant with an offset (default: now). One that arrives after it stays unread; a future --to acts as now.",
    risk: "high",
    rules: {
      changes: "Every unread notification of yours created at or before the instant is marked read.",
      visible_to: "Only you.",
      budget_rows: [],
      retry: "Safe: a second call marks only what arrived since.",
      undo: "Cannot be undone: a notification cannot be marked unread.",
      blast_radius: "All of your unread notifications in this Team up to the instant: `marked` in the answer says how many.",
    },
    output: ["`before` (the instant used, UTC), `marked`, and the `unread_count` that remains."],
    seeAlso: SEE,
    examples: ["curviate notification read-all", "curviate notification read-all --to 2026-10-08T10:00:00Z"],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    to: { type: "string", description: "Mark read what was created up to this instant (ISO 8601 with offset). Default: now." },
  },
  run: online(runReadAll),
});

export const notificationsCommand = defineCommand({
  meta: { name: "notification", description: DESCRIPTIONS.notification },
  subCommands: { list: listCmd, count: countCmd, read: readCmd, "read-all": readAllCmd, archive: archiveCmd, unarchive: unarchiveCmd },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(notificationsCommand, ["curviate", "notification"]);
  },
});
