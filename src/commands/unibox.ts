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
  conversationId?: string;
  channel?: string;
  accountId?: string;
  chatId?: string;
  text?: string;
  accounts?: string | string[];
  campaign?: string | string[];
  person?: string;
  tag?: string | string[];
  unread?: boolean;
  read?: boolean;
  "last-from"?: string;
  "reply-label"?: string | string[];
  messageId?: string;
  set?: string;
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

/** Who a chat is with: its counterpart, or a group's title, else its other members. */
function chatWith(i: Row): unknown {
  const g = i["group"] as Row | null | undefined;
  if (!g) return (i["counterpart"] as Row | null)?.["name"];
  if (g["title"]) return g["title"];
  const members = (g["members"] as Row[] | undefined) ?? [];
  return g["members_known"] && members.length ? members.map((m) => m["name"] ?? "Name pending").join(", ") : "Group chat";
}

async function runList(c: Curviate, f: UniboxFlags): Promise<void> {
  const q: Row = {};
  if (f.accounts !== undefined) q["account_ids"] = listFlag("accounts", f.accounts);
  if (f.campaign !== undefined) q["campaign_ids"] = listFlag("campaign", f.campaign);
  if (f.tag !== undefined) q["tags"] = listFlag("tag", f.tag);
  if (f.person !== undefined) q["person"] = f.person;
  if (f.unread !== undefined) q["unread"] = f.unread;
  if (f["last-from"] !== undefined) q["last_message_from"] = f["last-from"];
  if (f.type !== undefined) q["type"] = f.type;
  if (f.query !== undefined) q["q"] = f.query;
  if (f["reply-label"] !== undefined) q["reply_label"] = listFlag("reply-label", f["reply-label"]);
  if (f.total) q["include_total"] = true;
  if (f.limit !== undefined) q["limit"] = intFlag("limit", f.limit, 1, 100);
  try {
    await paged(f, q, (p) => c.unibox.list(p as never) as unknown as Promise<unknown>, (page) => {
      const unread = (i: Row) => (i["unread"] ? (i["marked_unread"] ? "marked" : "yes") : "");
      const campaign = (i: Row) => (i["campaign_context"] as Row | null)?.["campaign_name"];
      const label = (i: Row) => (i["reply_label"] as Row | null | undefined)?.["label"];
      print(table(["ACCOUNT", "CHAT", "WITH", "UNREAD", "LAST", "FROM", "LABEL", "CAMPAIGN", "TAGS"],
        page.items.map((i) => [i["account_id"], i["chat_id"], chatWith(i), unread(i), i["last_activity_at"], i["last_message_from"], label(i), campaign(i), (i["tags"] as string[] | undefined)?.join(", ")])));
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

const conversationId = (f: UniboxFlags, cmd: string): string => {
  const id = String(f.conversationId ?? "");
  return id.trim() !== "" ? id : usage(`the conversation id is missing: \`curviate unibox ${cmd} <conversation_id>\` (each chat of \`unibox list\` carries conversation_id).`);
};

/** `conversation <id>`: one person on one account across LinkedIn and email. */
async function runConversation(c: Curviate, f: UniboxFlags): Promise<void> {
  const id = conversationId(f, "conversation");
  try {
    renderSuccess(await c.unibox.getConversation(id), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

/** `timeline <id>`: the conversation's LinkedIn messages, emails and Campaign events, newest first. */
async function runTimeline(c: Curviate, f: UniboxFlags): Promise<void> {
  const id = conversationId(f, "timeline");
  try {
    const q: Row = {};
    if (f.channel !== undefined) {
      if (!["linkedin", "email"].includes(f.channel)) usage("--channel takes linkedin or email.");
      q["channel"] = f.channel;
    }
    if (f.limit !== undefined) q["limit"] = intFlag("limit", f.limit, 1, 100);
    await paged(f, q, (p) => c.unibox.listConversationMessages(id, p as never) as Promise<unknown>, (page) =>
      print(table(["AT", "CHANNEL", "FROM", "TEXT"], page.items.map((m) => [
        m["timestamp"],
        m["channel"] ?? "event",
        m["channel"] === null ? m["kind"] : m["is_sender"] ? "me" : ((m["sender"] as Row | null)?.["display_name"] ?? m["from"] ?? m["sender_id"]),
        m["channel"] === null ? (m["campaign_name"] ?? "") : m["channel"] === "email" ? (m["subject"] ?? m["text"]) : m["text"],
      ]))));
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
  if (f.preview) return preview("unibox.tagLead", { account_id: accountId, chat_id: chatId }, body);
  try {
    renderSuccess(await c.unibox.tagLead(accountId, chatId, body), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

async function runEnroll(c: Curviate, f: UniboxFlags): Promise<void> {
  const { accountId, chatId } = ids(f);
  const campaign = typeof f.campaign === "string" && f.campaign.trim() !== "" ? f.campaign : usage("--campaign is required: the Campaign to enroll the person in (mot_...).");
  const body = { campaign_id: campaign };
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

const REPLY_LABELS = ["interested", "not_now", "not_interested", "opt_out", "out_of_office", "referral", "other"] as const;

async function runLabel(c: Curviate, f: UniboxFlags): Promise<void> {
  const messageId = String(f.messageId ?? "");
  if (messageId.trim() === "") usage("the message id is required: `curviate unibox label <message_id>`, as `curviate unibox messages` prints it.");
  if (f.set !== undefined) {
    if (!(REPLY_LABELS as readonly string[]).includes(f.set)) usage(`--set takes one of ${REPLY_LABELS.join(", ")}.`);
    const body = { reply_label: f.set as (typeof REPLY_LABELS)[number] };
    if (f.preview) return preview("unibox.updateMessage", { message_id: messageId }, body);
    try {
      renderSuccess(await c.unibox.updateMessage(messageId, body), outputOpts(f), process);
    } catch (err) {
      await fail(err, f);
    }
    return;
  }
  try {
    const res = (await c.unibox.getReplyLabel(messageId)) as unknown as { current: Row | null; history?: Row[] };
    if (outputOpts(f).json) return renderSuccess(res, outputOpts(f), process);
    const cur = res.current;
    print(cur ? `${String(cur["label"])} (${String(cur["source"])}${cur["confidence"] == null ? "" : `, confidence ${String(cur["confidence"])}`})` : "no label");
    const history = res.history ?? [];
    if (history.length > 1) print(table(["AT", "LABEL", "SOURCE", "CONFIDENCE", "SET BY"], history.map((h) => [h["set_at"], h["label"], h["source"], h["confidence"], (h["set_by"] as Row | null)?.["name"]])));
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
      "An Account without full-inbox sync shows only its Campaign chats; a disconnected Account's chats are listed read-only.",
    risk: "read",
    output: ["A table of Account, chat, person, unread (`marked` when made unread without a newer message), last activity, Reply label, Campaign and tags; with --total the count of matching chats. --json (or piped) prints the API page."],
    examples: ["curviate unibox list --unread", "curviate unibox list --reply-label interested,unsure", "curviate unibox list --person con_YOUR_LEAD_ID --campaign none --total"],
  },
  args: {
    ...readOnly(GLOBAL_FLAGS),
    limit: { ...GLOBAL_FLAGS.limit, description: "Chats per page (1 to 100)." },
    accounts: ACCOUNTS,
    campaign: { type: "string" as const, description: "Only chats linked to these Campaigns (mot_...), repeatable or a comma list; `none` for chats no Campaign links." },
    person: { type: "string" as const, description: "Only chats with this person: a Lead id (con_...) or a LinkedIn id (ACo...)." },
    tag: { type: "string" as const, description: "Only chats whose Lead has this tag; repeatable or a comma list." },
    unread: { type: "boolean" as const, description: "--unread for unread chats only, --no-unread for read ones; omit for both." },
    "last-from": { type: "string" as const, description: "Who wrote the last message: me or them." },
    "reply-label": { type: "string" as const, description: "Only chats whose latest Reply label is one of these, repeatable or a comma list: interested, not_now, not_interested, opt_out, out_of_office, referral, other, unsure; `none` adds chats with no label." },
    type: { type: "string" as const, description: "classic, inmail, sales_navigator or recruiter." },
    query: { type: "string" as const, description: "Person name or message text contains this (3 characters or more)." },
    total: { type: "boolean" as const, description: "Also count every chat that matches the filters (`total`)." },
  },
  run: online(runList),
});

const getCmd = defineCommand({
  meta: {
    name: "get",
    description: "One chat as the Unibox lists it, with `marked_unread` ({origin, at}, or null) and its Campaign context.",
    risk: "read",
    examples: ["curviate unibox get acc_YOUR_ACCOUNT_ID YOUR_CHAT_ID"],
  },
  args: { ...readOnly(WRITE_SINGLE_FLAGS), accountId: ACCOUNT, chatId: CHAT },
  run: online(runGet),
});

const conversationCmd = defineCommand({
  meta: {
    name: "conversation",
    description:
      "One conversation: one person on one account across LinkedIn and email (each chat of `unibox list` carries its conversation_id), with its channels and email state. " +
      "From what Curviate has stored: no LinkedIn call, no mailbox read. Its messages: `curviate unibox timeline`.",
    risk: "read",
    seeAlso: ["curviate unibox timeline", "curviate unibox list"],
    examples: ["curviate unibox conversation cnv_YOUR_CONVERSATION_ID"],
  },
  args: { ...readOnly(WRITE_SINGLE_FLAGS), conversationId: { type: "positional" as const, description: "Conversation id (cnv_...)." } },
  run: online(runConversation),
});

const timelineCmd = defineCommand({
  meta: {
    name: "timeline",
    description:
      "A conversation's timeline, newest first: its LinkedIn messages, its emails, and Campaign events (a bounce, an unsubscribe, the end of an Enrollment) in one list. " +
      "A page holds --limit LinkedIn messages and every email and event since the oldest of them; --channel email serves every email at once. From what Curviate has stored: no LinkedIn call, no mailbox read.",
    risk: "read",
    seeAlso: ["curviate unibox conversation", "curviate unibox messages"],
    examples: ["curviate unibox timeline cnv_YOUR_CONVERSATION_ID", "curviate unibox timeline cnv_YOUR_CONVERSATION_ID --channel email --json"],
  },
  args: {
    ...readOnly(GLOBAL_FLAGS),
    limit: { ...GLOBAL_FLAGS.limit, description: "LinkedIn messages per page (1 to 100); every email and event since the oldest of them comes with them." },
    conversationId: { type: "positional" as const, description: "Conversation id (cnv_...)." },
    channel: { type: "string" as const, description: "Only linkedin or email." },
  },
  run: online(runTimeline),
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
    description: "Read one chat's messages, newest first. Each message carries `origin` when known: campaign, unibox, api or linkedin.",
    risk: "read",
    seeAlso: ["curviate core inbox messages"],
    examples: ["curviate unibox messages acc_YOUR_ACCOUNT_ID YOUR_CHAT_ID", "curviate unibox messages acc_YOUR_ACCOUNT_ID YOUR_CHAT_ID --all"],
  },
  args: { ...readOnly(GLOBAL_FLAGS), limit: { ...GLOBAL_FLAGS.limit, description: "Messages per page (1 to 25; more than 25 is refused with exit 2). --all pages on." }, accountId: ACCOUNT, chatId: CHAT },
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
    description: "Save the other person of a one-to-one chat as a Lead (or find the one you hold) and add tags, never removing any. Needs Automate.",
    risk: "write",
    rules: {
      changes: "Creates or finds the Lead and adds the tags.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "Safe to repeat: the same Lead, tags already there stay.",
      undo: "Remove the tags or the Lead with `curviate lead`.",
    },
    errors: { ...AUTOMATE, ...ONE_TO_ONE },
    examples: ["curviate unibox tag acc_YOUR_ACCOUNT_ID YOUR_CHAT_ID --tag warm"],
  },
  args: { ...WRITE_SINGLE_FLAGS, accountId: ACCOUNT, chatId: CHAT, tag: { type: "string" as const, description: "A tag to add; repeatable or a comma list. Omit to only save the Lead." } },
  run: online(runTag),
});

const enrollCmd = defineCommand({
  meta: {
    name: "enroll",
    description:
      "Save the other person of a one-to-one chat as a Lead and enroll them in a Campaign through this chat's Account (one of its sending Accounts). " +
      "A direct add: the rule that skips people you already chat with does not apply; every other rule does. Needs Automate.",
    risk: "high",
    rules: {
      changes: "Creates the Enrollment; the Campaign's Steps run for this person from this Account.",
      visible_to: "The person, once a Step reaches LinkedIn.",
      budget_rows: [],
      retry: "A second call answers that the person is already enrolled.",
      undo: "`curviate enrollment stop <enrollment_id>`; what was sent stays sent.",
      blast_radius: "One person, from one Account.",
    },
    errors: { ...AUTOMATE, ...ONE_TO_ONE, ALREADY_ENROLLED_ON_ACCOUNT: "the person is already in this Campaign on this Account." },
    seeAlso: ["curviate enrollment get"],
    examples: ["curviate unibox enroll acc_YOUR_ACCOUNT_ID YOUR_CHAT_ID --campaign mot_YOUR_CAMPAIGN_ID"],
  },
  args: { ...WRITE_SINGLE_FLAGS, accountId: ACCOUNT, chatId: CHAT, campaign: { type: "string" as const, required: true, description: "The Campaign (mot_...)." } },
  run: online(runEnroll),
});

const refreshCmd = defineCommand({
  meta: {
    name: "refresh",
    description:
      "Queue a re-read of the newest chats of each Account the inbox poll covers, or of --accounts; it runs within minutes. " +
      "Once per Account in a short cooldown: a repeat answers cooldown with next_allowed_at. " +
      "An Account without Sync full inbox is re-read for its Campaign conversations only; one with neither answers not_synced. " +
      "The poll keeps the Account's active hours: on a Team whose active days are Monday to Friday nothing is polled at the weekend, and a refresh then answers paused until the next active day. Needs Automate.",
    risk: "write",
    rules: {
      changes: "Queues one read of each Account's newest chats.",
      visible_to: "Nobody: reads only.",
      budget_rows: ["inbox_sync"],
      retry: "A repeat inside the cooldown answers cooldown; nothing new is queued.",
      undo: "Nothing to undo: a refresh only reads.",
    },
    errors: AUTOMATE,
    examples: ["curviate unibox refresh", "curviate unibox refresh --accounts acc_YOUR_ACCOUNT_ID"],
  },
  args: { ...WRITE_SINGLE_FLAGS, accounts: ACCOUNTS },
  run: online(runRefresh),
});

const labelCmd = defineCommand({
  meta: {
    name: "label",
    description:
      "Read a reply's Reply label and its history (who set it, Curviate's confidence as a whole percent, or a rule), or with --set correct it. " +
      "A correction acts as when Curviate sets the label: opt_out puts the person on your Do-not-contact list (not_interested too when your Team turned that on), out_of_office makes the Lead wait 7 days, and your Team's Tag for the label is added. " +
      "No LinkedIn call. --set needs Automate.",
    risk: "write",
    rules: {
      changes: "With --set: the message's Reply label, stored as a correction; the earlier label stays in the history.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "Safe to repeat: the same label again.",
      undo: "Set the label back with --set; a Do-not-contact entry it added stays: `curviate do-not-contact remove`.",
    },
    errors: { ...AUTOMATE, REPLY_NOT_LABELLABLE: "this message takes no Reply label: a direct conversation (no Campaign), your own message, or a warm-up message." },
    seeAlso: ["curviate unibox messages", "curviate team reply-labels"],
    examples: ["curviate unibox label YOUR_MESSAGE_ID", "curviate unibox label YOUR_MESSAGE_ID --set not_now"],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    messageId: { type: "positional" as const, description: "The message id, as `curviate unibox messages` prints it." },
    set: { type: "string" as const, description: "Set or correct the label: interested, not_now, not_interested, opt_out, out_of_office, referral or other." },
  },
  run: online(runLabel),
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
      "off hides the Account's non-Campaign chats at once and deletes them shortly after.",
    risk: "high",
    rules: {
      changes: "Copies the Account's whole inbox into the Unibox (on), or removes the non-Campaign chats from it (off).",
      visible_to: "Your Team: every teammate who may operate the Account reads its whole inbox while on.",
      budget_rows: ["inbox_sync"],
      retry: "Safe to repeat: the same setting again.",
      undo: "Run it with the other flag; chats removed by off are listed again by a new sync.",
      blast_radius: "One Account's whole inbox.",
    },
    errors: { ...AUTOMATE, ACCOUNT_OWNER_ONLY: "only the person who connected the Account can change this." },
    seeAlso: ["curviate unibox refresh", "curviate unibox list"],
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
    conversation: conversationCmd,
    timeline: timelineCmd,
    reply: replyCmd,
    mark: markCmd,
    tag: tagCmd,
    enroll: enrollCmd,
    label: labelCmd,
    refresh: refreshCmd,
    accounts: accountsCmd,
    consent: consentCmd,
  },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(uniboxCommand, ["curviate", "unibox"]);
  },
});
