/**
 * `curviate unibox`: one inbox over the chats of every Account you may
 * operate, served from Curviate's store (reads call nothing on LinkedIn).
 * `messages`, `reply` and `mark` act on one chat through the core chat routes
 * of its Account, which the positional `<account_id>` names.
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
import { print, table } from "../lib/table.js";

type UniboxFlags = RootFlags & {
  accountId?: string;
  chatId?: string;
  text?: string;
  accounts?: string | string[];
  motion?: string | string[];
  person?: string;
  tag?: string | string[];
  unread?: boolean;
  read?: boolean;
  "last-from"?: string;
  type?: string;
  query?: string;
  total?: boolean;
  on?: boolean;
  off?: boolean;
  limit?: string;
  cursor?: string;
  all?: boolean;
  "max-pages"?: string;
  "page-delay"?: string;
};
type Row = Record<string, unknown>;
type Page = { items?: unknown[]; cursor?: string | null };

const ids = (f: UniboxFlags) => ({ accountId: String(f.accountId ?? ""), chatId: String(f.chatId ?? "") });
const preview = (method: string, args: Row, body: Row = {}) => print(JSON.stringify(buildPreviewOutput({ method, args, body })));

/** One page, or every page as NDJSON with --all. */
async function paged(f: UniboxFlags, params: Row, fetch: (p: Row) => Promise<unknown>, human: (page: Row & { items: Row[] }) => void): Promise<void> {
  rejectPaginationModifiersWithoutAll(f, process);
  const cursor = readCursorFlag(f, process);
  if (cursor) params["cursor"] = cursor;
  if (f.all) {
    for await (const item of streamAll((p) => fetch(p) as Promise<Page>, params, { maxPages: readMaxPagesFlag(f, process), out: process, pageDelayMs: pageDelayFromFlags(f) })) writeNdjsonItem(process, item, f.fields);
    return;
  }
  const page = readablePage(await fetch(params)) as Row & { items: Row[] };
  if (outputOpts(f).json) return renderSuccess(page, outputOpts(f), process);
  human(page);
  if (page["cursor"]) print(`next page: --cursor ${String(page["cursor"])}`);
}

async function runList(c: Curviate, f: UniboxFlags): Promise<void> {
  const q: Row = {};
  if (f.accounts !== undefined) q["account_ids"] = listFlag("accounts", f.accounts);
  if (f.motion !== undefined) q["motion_ids"] = listFlag("motion", f.motion);
  if (f.tag !== undefined) q["tags"] = listFlag("tag", f.tag);
  if (f.person !== undefined) q["person"] = f.person;
  if (f.unread !== undefined) q["unread"] = f.unread;
  if (f["last-from"] !== undefined) q["last_message_from"] = f["last-from"];
  if (f.type !== undefined) q["type"] = f.type;
  if (f.query !== undefined) q["q"] = f.query;
  if (f.total) q["include_total"] = true;
  if (f.limit !== undefined) q["limit"] = intFlag("limit", f.limit, 1, 100);
  try {
    await paged(f, q, (p) => c.unibox.list(p as never) as unknown as Promise<unknown>, (page) => {
      const unread = (i: Row) => (i["unread"] ? (i["marked_unread"] ? "marked" : "yes") : "");
      const motion = (i: Row) => (i["motion_context"] as Row | null)?.["motion_name"];
      print(table(["ACCOUNT", "CHAT", "WITH", "UNREAD", "LAST", "FROM", "MOTION", "TAGS"],
        page.items.map((i) => [i["account_id"], i["chat_id"], (i["counterpart"] as Row | null)?.["name"], unread(i), i["last_activity_at"], i["last_message_from"], motion(i), (i["tags"] as string[] | undefined)?.join(", ")])));
      if (typeof page["total"] === "number") print(`total: ${page["total"]} chats match`);
    });
  } catch (err) {
    await fail(err, f);
  }
}

async function runGet(c: Curviate, f: UniboxFlags): Promise<void> {
  const { accountId, chatId } = ids(f);
  try {
    renderSuccess(await c.unibox.get(accountId, chatId), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

async function runUnread(c: Curviate, f: UniboxFlags): Promise<void> {
  try {
    renderSuccess(await c.unibox.unreadCount(f.accounts === undefined ? {} : { account_ids: listFlag("accounts", f.accounts) }), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

async function runMessages(c: Curviate, f: UniboxFlags): Promise<void> {
  const { accountId, chatId } = ids(f);
  const q: Row = {};
  if (f.limit !== undefined) q["limit"] = intFlag("limit", f.limit, 1, 25);
  try {
    await paged(f, q, (p) => c.account(accountId).messaging.listMessages(chatId, p as never) as Promise<unknown>, (page) =>
      print(table(["AT", "FROM", "ORIGIN", "TEXT"], page.items.map((m) => [m["timestamp"], m["is_sender"] ? "me" : ((m["sender"] as Row | null)?.["display_name"] ?? m["sender_id"]), m["origin"], m["text"]]))));
  } catch (err) {
    await fail(err, f);
  }
}

async function runReply(c: Curviate, f: UniboxFlags): Promise<void> {
  const { accountId, chatId } = ids(f);
  if (!f.text) usage("the message text is required: `curviate unibox reply <account_id> <chat_id> \"<text>\"`.");
  const body = { text: f.text };
  if (f.preview) return preview("messaging.sendMessage", { account_id: accountId, chat_id: chatId }, body);
  try {
    renderSuccess(await c.account(accountId).messaging.sendMessage(chatId, body), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

async function runMark(c: Curviate, f: UniboxFlags): Promise<void> {
  const { accountId, chatId } = ids(f);
  if ((f.read === undefined) === (f.unread === undefined)) usage("pass exactly one of --read or --unread.");
  const body = { read: f.read ?? !f.unread };
  if (f.preview) return preview("messaging.markChatRead", { account_id: accountId, chat_id: chatId }, body);
  try {
    renderSuccess(await c.account(accountId).messaging.markChatRead(chatId, body), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

async function runTag(c: Curviate, f: UniboxFlags): Promise<void> {
  const { accountId, chatId } = ids(f);
  const body = f.tag === undefined ? {} : { tags: listFlag("tag", f.tag) };
  if (f.preview) return preview("unibox.tagContact", { account_id: accountId, chat_id: chatId }, body);
  try {
    renderSuccess(await c.unibox.tagContact(accountId, chatId, body), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

async function runEnroll(c: Curviate, f: UniboxFlags): Promise<void> {
  const { accountId, chatId } = ids(f);
  const motion = typeof f.motion === "string" && f.motion.trim() !== "" ? f.motion : usage("--motion is required: the Motion to enroll the person in (mot_...).");
  const body = { motion_id: motion };
  if (f.preview) return preview("unibox.enroll", { account_id: accountId, chat_id: chatId }, body);
  try {
    renderSuccess(await c.unibox.enroll(accountId, chatId, body), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

async function runRefresh(c: Curviate, f: UniboxFlags): Promise<void> {
  const body = f.accounts === undefined ? {} : { account_ids: listFlag("accounts", f.accounts) };
  if (f.preview) return preview("unibox.refresh", {}, body);
  try {
    renderSuccess(await c.unibox.refresh(body), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

async function runAccounts(c: Curviate, f: UniboxFlags): Promise<void> {
  try {
    const res = (await c.unibox.accounts.list()) as unknown as { items?: Row[] };
    if (outputOpts(f).json) return renderSuccess(res, outputOpts(f), process);
    print(table(["ACCOUNT", "STATUS", "FULL INBOX", "SYNC", "NEXT READ"],
      (res.items ?? []).map((i) => [i["account_id"], i["account_status"], i["sync_full_inbox"] ? "on" : "off", (i["sync"] as Row | null)?.["state"], (i["sync"] as Row | null)?.["next_run_at"]])));
  } catch (err) {
    await fail(err, f);
  }
}

async function runConsent(c: Curviate, f: UniboxFlags): Promise<void> {
  if (Boolean(f.on) === Boolean(f.off)) usage("pass exactly one of --on or --off.");
  const accountId = String(f.accountId ?? "");
  const body = { sync_full_inbox: Boolean(f.on) };
  if (f.preview) return preview("unibox.accounts.update", { account_id: accountId }, body);
  try {
    renderSuccess(await c.unibox.accounts.update(accountId, body), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

// ---------------------------------------------------------------------------
// citty definitions
// ---------------------------------------------------------------------------

const online = (fn: (c: Curviate, f: UniboxFlags) => Promise<void>) => async ({ args }: { args: unknown }) => {
  const f = args as UniboxFlags;
  await fn(await rootClient(f), f);
};

const ACCOUNT = { type: "positional" as const, description: "The chat's Account (acc_...), as `curviate unibox list` prints it." };
const CHAT = { type: "positional" as const, description: "The chat id, as `curviate unibox list` prints it." };
const ACCOUNTS = { type: "string" as const, description: "Only these Accounts: a comma list of ids (acc_...). Never filled from your profile's default Account." };
const AUTOMATE = { TIER_REQUIRED: "your plan does not include the Unibox actions (Automate)." };
const ONE_TO_ONE = { CHAT_NOT_ONE_TO_ONE: "the chat is a group chat: there is no one person to save." };

const listCmd = defineCommand({
  meta: {
    name: "list",
    description:
      "List the chats of every Account you may operate, newest activity first. Served from Curviate's store: no LinkedIn call, no budget. " +
      "An Account without full-inbox sync shows only its Motion chats; a disconnected Account's chats are listed read-only.",
    risk: "read",
    output: ["A table of Account, chat, person, unread (`marked` when made unread without a newer message), last activity, Motion and tags; with --total the count of matching chats. --json (or piped) prints the API page."],
    examples: ["curviate unibox list --unread", "curviate unibox list --person con_YOUR_CONTACT_ID --motion none --total"],
  },
  args: {
    ...readOnly(GLOBAL_FLAGS),
    accounts: ACCOUNTS,
    motion: { type: "string" as const, description: "Only chats linked to these Motions (mot_...), repeatable or a comma list; `none` for chats no Motion links." },
    person: { type: "string" as const, description: "Only chats with this person: a Contact id (con_...) or a LinkedIn id (ACo...)." },
    tag: { type: "string" as const, description: "Only chats whose Contact has this tag; repeatable or a comma list." },
    unread: { type: "boolean" as const, description: "--unread for unread chats only, --no-unread for read ones; omit for both." },
    "last-from": { type: "string" as const, description: "Who wrote the last message: me or them." },
    type: { type: "string" as const, description: "classic, inmail, sales_navigator or recruiter." },
    query: { type: "string" as const, description: "Person name or message text contains this (3 characters or more)." },
    total: { type: "boolean" as const, description: "Also count every chat that matches the filters (`total`)." },
  },
  run: online(runList),
});

const getCmd = defineCommand({
  meta: {
    name: "get",
    description: "One chat as the Unibox lists it, with `marked_unread` ({origin, at}, or null) and its Motion context.",
    risk: "read",
    examples: ["curviate unibox get acc_YOUR_ACCOUNT_ID YOUR_CHAT_ID"],
  },
  args: { ...readOnly(WRITE_SINGLE_FLAGS), accountId: ACCOUNT, chatId: CHAT },
  run: online(runGet),
});

const unreadCmd = defineCommand({
  meta: {
    name: "unread",
    description: "Count unread chats (chats, not messages) across your Accounts; cheap to poll.",
    risk: "read",
    examples: ["curviate unibox unread", "curviate unibox unread --accounts acc_YOUR_ACCOUNT_ID"],
  },
  args: { ...readOnly(WRITE_SINGLE_FLAGS), accounts: ACCOUNTS },
  run: online(runUnread),
});

const messagesCmd = defineCommand({
  meta: {
    name: "messages",
    description: "Read one chat's messages, newest first. Each message carries `origin` when known: motion, unibox, api or linkedin.",
    risk: "read",
    seeAlso: ["curviate core inbox messages"],
    examples: ["curviate unibox messages acc_YOUR_ACCOUNT_ID YOUR_CHAT_ID", "curviate unibox messages acc_YOUR_ACCOUNT_ID YOUR_CHAT_ID --all"],
  },
  args: { ...readOnly(GLOBAL_FLAGS), accountId: ACCOUNT, chatId: CHAT },
  run: online(runMessages),
});

const replyCmd = defineCommand({
  meta: {
    name: "reply",
    description: "Send a message into the chat from its Account. The send marks the chat read.",
    risk: "write",
    rules: {
      changes: "Sends one LinkedIn message and marks the chat read.",
      visible_to: "The other people in the chat, at once.",
      budget_rows: [],
      retry: "A retry after a timeout can send the message twice: read `curviate unibox messages` first.",
      undo: "`curviate core message delete` removes it on LinkedIn; it may have been read already.",
    },
    errors: { REAUTH_REQUIRED: "the Account is disconnected: reconnect it to write.", CHAT_NOT_VISIBLE: "the chat is not visible to you." },
    examples: ["curviate unibox reply acc_YOUR_ACCOUNT_ID YOUR_CHAT_ID \"Thanks, Tuesday works.\""],
  },
  args: { ...WRITE_SINGLE_FLAGS, accountId: ACCOUNT, chatId: CHAT, text: { type: "positional" as const, description: "The message text (1 to 8000 characters)." } },
  run: online(runReply),
});

const markCmd = defineCommand({
  meta: {
    name: "mark",
    description: "Mark the chat read or unread on LinkedIn, for everyone who sees this Account's inbox.",
    risk: "write",
    rules: {
      changes: "Sets the chat's read state on LinkedIn.",
      visible_to: "Your Team and the Account's own LinkedIn inbox; not the other person.",
      budget_rows: [],
      retry: "Safe to repeat: the same state again.",
      undo: "Mark it the other way.",
    },
    errors: { REAUTH_REQUIRED: "the Account is disconnected: reconnect it to write." },
    examples: ["curviate unibox mark acc_YOUR_ACCOUNT_ID YOUR_CHAT_ID --read"],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    accountId: ACCOUNT,
    chatId: CHAT,
    read: { type: "boolean" as const, description: "Mark it read." },
    unread: { type: "boolean" as const, description: "Mark it unread." },
  },
  run: online(runMark),
});

const tagCmd = defineCommand({
  meta: {
    name: "tag",
    description: "Save the other person of a one-to-one chat as a Contact (or find the one you hold) and add tags, never removing any. Needs Automate.",
    risk: "write",
    rules: {
      changes: "Creates or finds the Contact and adds the tags.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "Safe to repeat: the same Contact, tags already there stay.",
      undo: "Remove the tags or the Contact with `curviate contact`.",
    },
    errors: { ...AUTOMATE, ...ONE_TO_ONE },
    examples: ["curviate unibox tag acc_YOUR_ACCOUNT_ID YOUR_CHAT_ID --tag warm"],
  },
  args: { ...WRITE_SINGLE_FLAGS, accountId: ACCOUNT, chatId: CHAT, tag: { type: "string" as const, description: "A tag to add; repeatable or a comma list. Omit to only save the Contact." } },
  run: online(runTag),
});

const enrollCmd = defineCommand({
  meta: {
    name: "enroll",
    description:
      "Save the other person of a one-to-one chat as a Contact and enroll them in a Motion through this chat's Account (one of its sending Accounts). " +
      "A direct add: the rule that skips people you already chat with does not apply; every other rule does. Needs Automate.",
    risk: "high",
    rules: {
      changes: "Creates the Enrollment; the Motion's Steps run for this person from this Account.",
      visible_to: "The person, once a Step reaches LinkedIn.",
      budget_rows: [],
      retry: "A second call answers that the person is already enrolled.",
      undo: "`curviate enrollment stop <enrollment_id>`; what was sent stays sent.",
      blast_radius: "One person, from one Account.",
    },
    errors: { ...AUTOMATE, ...ONE_TO_ONE, ALREADY_ENROLLED_ON_ACCOUNT: "the person is already in this Motion on this Account." },
    seeAlso: ["curviate enrollment get"],
    examples: ["curviate unibox enroll acc_YOUR_ACCOUNT_ID YOUR_CHAT_ID --motion mot_YOUR_MOTION_ID"],
  },
  args: { ...WRITE_SINGLE_FLAGS, accountId: ACCOUNT, chatId: CHAT, motion: { type: "string" as const, required: true, description: "The Motion (mot_...)." } },
  run: online(runEnroll),
});

const refreshCmd = defineCommand({
  meta: {
    name: "refresh",
    description:
      "Queue a re-read of the newest chats (up to 100) of each Account the inbox poll covers, or of --accounts; it runs within minutes. " +
      "Once per Account every 2 minutes: a repeat answers cooldown with next_allowed_at. " +
      "An Account without Sync full inbox is re-read for its Motion conversations only; one with neither answers not_synced. " +
      "The poll keeps the Account's active hours: on a Team whose active days are Monday to Friday nothing is polled at the weekend, and a refresh then answers paused until the next active day. Needs Automate.",
    risk: "write",
    rules: {
      changes: "Queues one read of each Account's newest chats.",
      visible_to: "Nobody: reads only.",
      budget_rows: ["inbox_sync"],
      retry: "A repeat within 2 minutes answers cooldown; nothing new is queued.",
      undo: "Nothing to undo: a refresh only reads.",
    },
    errors: AUTOMATE,
    examples: ["curviate unibox refresh", "curviate unibox refresh --accounts acc_YOUR_ACCOUNT_ID"],
  },
  args: { ...WRITE_SINGLE_FLAGS, accounts: ACCOUNTS },
  run: online(runRefresh),
});

const accountsCmd = defineCommand({
  meta: {
    name: "accounts",
    description: "For every Account you may operate: whether Sync full inbox is on, and how far the chat-list sync is. Read `sync` before trusting an empty Unibox.",
    risk: "read",
    examples: ["curviate unibox accounts"],
  },
  args: readOnly(WRITE_SINGLE_FLAGS),
  run: online(runAccounts),
});

const consentCmd = defineCommand({
  meta: {
    name: "consent",
    description:
      "Turn Sync full inbox on or off for one Account. Only the person who connected the Account can. On starts a paced listing that takes hours (needs Automate); " +
      "off hides the Account's non-Motion chats at once and deletes them within 15 minutes.",
    risk: "high",
    rules: {
      changes: "Copies the Account's whole inbox into the Unibox (on), or removes the non-Motion chats from it (off).",
      visible_to: "Your Team: every teammate who may operate the Account reads its whole inbox while on.",
      budget_rows: ["inbox_sync"],
      retry: "Safe to repeat: the same setting again.",
      undo: "Run it with the other flag; chats removed by off are listed again by a new sync.",
      blast_radius: "One Account's whole inbox.",
    },
    errors: { ...AUTOMATE, ACCOUNT_OWNER_ONLY: "only the person who connected the Account can change this." },
    examples: ["curviate unibox consent acc_YOUR_ACCOUNT_ID --on"],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    accountId: { type: "positional" as const, description: "Your Account (acc_...)." },
    on: { type: "boolean" as const, description: "Turn Sync full inbox on." },
    off: { type: "boolean" as const, description: "Turn Sync full inbox off." },
  },
  run: online(runConsent),
});

export const uniboxCommand = defineCommand({
  meta: { name: "unibox", description: DESCRIPTIONS.unibox },
  subCommands: {
    list: listCmd,
    get: getCmd,
    unread: unreadCmd,
    messages: messagesCmd,
    reply: replyCmd,
    mark: markCmd,
    tag: tagCmd,
    enroll: enrollCmd,
    refresh: refreshCmd,
    accounts: accountsCmd,
    consent: consentCmd,
  },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(uniboxCommand, ["curviate", "unibox"]);
  },
});
