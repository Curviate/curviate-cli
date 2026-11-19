/**
 * `curviate mailbox`: your Team's own email Mailboxes. Root-scoped
 * (`curviate.mailboxes.*`): list, read, change (Sends for, daily cap,
 * signature), pause, resume, remove, find settings for an address, connect and
 * reconnect, placement tests, and Mailboxes from Curviate (`mailbox buy`, `mailbox purchase`). Each
 * command makes one API call.
 *
 * A password reaches the request body and nowhere else: `--password-stdin` only
 * (never a value flag, which `ps` and shell history would keep), read once,
 * trimmed, never echoed, never printed back, never in a preview.
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
import { resolveSecret } from "../lib/credential-resolve.js";
import { getExitCode } from "../lib/exit-codes.js";
import { confirmMoney } from "./billing.js";

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
  "display-name"?: string;
  "clear-display-name"?: boolean;
  "warm-up"?: string;
  days?: string;
  address?: string;
  connection?: string;
  "password-stdin"?: boolean;
  "imap-host"?: string;
  "imap-port"?: string;
  "imap-security"?: string;
  "smtp-host"?: string;
  "smtp-port"?: string;
  "smtp-security"?: string;
  subject?: string;
  "body-file"?: string;
  testId?: string;
  mailbox?: string | string[];
  yes?: boolean;
  count?: string;
  "expect-amount"?: string;
};
type Body = Record<string, unknown>;

/** The placement test body's own limit is the API's (10,000 characters); this only stops a wrong file early. */
const TEST_BODY_MAX_BYTES = 64 * 1024;
const PURCHASE_STATES = ["awaiting_dns", "provisioning", "active", "cancelled"];

const STATES = ["connected", "ramping", "paused", "paused_by_bounces", "paused_by_provider", "reconnect_needed"];
/** The API's cap and signature limits are its own: the CLI sends what it is given and prints the API's 400. */
const SIGNATURE_MAX_BYTES = 64 * 1024;

// `--password-stdin=x` is refused before any command runs (dispatch.ts).
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
  if (f["display-name"] !== undefined && f["clear-display-name"]) usage("--display-name and --clear-display-name cannot be combined.");
  if (f["display-name"] !== undefined) body["display_name"] = f["display-name"];
  if (f["clear-display-name"]) body["display_name"] = null;
  if (f["warm-up"] !== undefined || f.days !== undefined) {
    const on = f["warm-up"] === "on" ? true : f["warm-up"] === "off" ? false : f["warm-up"] === undefined ? usage("--days goes with --warm-up on.") : usage("--warm-up takes on or off.");
    if (on && f.days === undefined) usage("--warm-up on needs --days: 10, 14, 21 or 28.");
    if (!on && f.days !== undefined) usage("--days goes with --warm-up on.");
    const days = f.days === undefined ? undefined : intFlag("days", f.days);
    if (days !== undefined && ![10, 14, 21, 28].includes(days)) usage("--days takes 10, 14, 21 or 28.");
    body["warm_up"] = on ? { enabled: true, days } : { enabled: false };
  }
  if (Object.keys(body).length === 0) usage("pass at least one of --sends-for, --daily-cap, --signature-file, --display-name, --clear-display-name, --warm-up.");
  if (f.preview) return preview("mailboxes.update", { id }, body);
  try {
    renderSuccess(readableObject(await c.mailboxes.update(id, body as never)), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

async function runTest(c: Curviate, f: Flags): Promise<void> {
  const id = String(f.id ?? "");
  if (f.subject === undefined || f.subject.trim() === "") usage("--subject is required: the subject exactly as your Campaign sends it.");
  if (f["body-file"] === undefined) usage("--body-file is required: a plain-text file with the body exactly as your Campaign sends it, or - for stdin.");
  const body = { subject: f.subject, body: (await readFileFlag("body-file", f["body-file"], { maxBytes: TEST_BODY_MAX_BYTES, others: f as Record<string, unknown> })).trimEnd() };
  if (f.preview) return preview("mailboxes.placementTests.run", { id }, body);
  try {
    renderSuccess(readableObject(await c.mailboxes.placementTests.run(id, body)), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

async function runTests(c: Curviate, f: Flags): Promise<void> {
  const id = String(f.id ?? "");
  try {
    if (f.testId !== undefined) return renderSuccess(readableObject(await c.mailboxes.placementTests.get(id, f.testId)), outputOpts(f), process);
    const params: Body = {};
    if (f.limit !== undefined) params["limit"] = intFlag("limit", f.limit, 1, 100);
    const cursor = readCursorFlag(f, process);
    if (cursor) params["cursor"] = cursor;
    renderSuccess(readablePage(await c.mailboxes.placementTests.list(id, params as never)), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

/** `local:Name` or `local:Name:acc_...|shared`; the last part counts as Sends for only when it is one. */
export function parseMailboxSpec(raw: string): Body {
  const at = raw.indexOf(":");
  if (at <= 0 || raw.slice(at + 1).trim() === "") usage(`--mailbox ${JSON.stringify(raw)}: write it as local:"Name", optionally :acc_... or :shared at the end.`);
  let name = raw.slice(at + 1);
  let sendsFor: Body | undefined;
  const last = name.lastIndexOf(":");
  const tail = last >= 0 ? name.slice(last + 1) : "";
  if (tail === "shared" || /^acc_\S+$/.test(tail)) {
    sendsFor = tail === "shared" ? { kind: "shared" } : { kind: "account", account_id: tail };
    name = name.slice(0, last);
  }
  return { local_part: raw.slice(0, at), display_name: name, ...(sendsFor ? { sends_for: sendsFor } : {}) };
}

/** Past the Team's cap on Mailboxes from Curviate: said plainly, never retried, nothing ordered. */
export const BUY_PAST_CAP =
  "This order would take your Team past its cap on Mailboxes from Curviate. Nothing was ordered. Only a Team Owner raises the cap, in the dashboard.";

/** The served price of an order or quote: every figure is the server's, none is made up here. */
export type ServedPrice = {
  mailboxes?: number;
  currency?: string;
  billing_period?: string;
  unit_amount?: number;
  amount?: number;
  charged?: string;
  prorated?: boolean;
  plus_tax?: boolean;
  orderable?: boolean;
  not_orderable_reason?: string | null;
  charge_waits_for?: string | null;
};

const money = (minor: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(minor / 100);

/** One plain paragraph for a quote or an order's `price`, worded from the served fields only. */
export function priceLine(p: ServedPrice): string {
  const n = p.mailboxes ?? 0;
  const cur = p.currency ?? "usd";
  const per = p.billing_period === "annual" ? "a year" : "a month";
  const head = p.charged === "never"
    ? `${n} Mailbox${n === 1 ? "" : "es"} from Curviate: nothing is charged for your Team.`
    : `${n} Mailbox${n === 1 ? "" : "es"} from Curviate: ${money(p.amount ?? 0, cur)} ${per} (${money(p.unit_amount ?? 0, cur)} each)${p.plus_tax ? ", plus tax where it applies" : ""}.`;
  const when =
    p.charged === "when_records_found" ? ` Charged the day the records are found at your domain${p.prorated ? ", for the rest of your billing year" : ""}, then each year.`
    : p.charged === "with_next_invoice" ? ` Added to your next invoice${p.prorated ? ", prorated for the rest of this month" : ""}, then each month.`
    : "";
  const waits = p.charge_waits_for === "payment" ? " The charge waits until your Team's open payment is settled."
    : p.charge_waits_for === "subscription" ? " The charge waits until your Team has a subscription." : "";
  const closed = p.orderable === false
    ? ` It cannot be ordered now: ${p.not_orderable_reason === "trial" ? "available once your Team pays (a Team on a trial, without a paid plan, or with a payment past due)" : p.not_orderable_reason === "sales_paused" ? "orders cannot be placed at the moment" : "orders are closed"}.`
    : "";
  return head + when + waits + closed;
}

async function runQuote(c: Curviate, f: Flags): Promise<void> {
  const n = /^\d+$/.test(f.count ?? "") ? Number(f.count) : NaN;
  if (!(n >= 1 && n <= 50)) usage("the count must be a whole number from 1 to 50: how many Mailboxes to price.");
  if (f.preview) return preview("mailboxes.purchases.quote", { mailboxes: n });
  try {
    const q = (await c.mailboxes.purchases.quote(n)) as unknown as ServedPrice;
    renderSuccess(readableObject(q as never), outputOpts(f), process);
    process.stderr.write(priceLine(q) + "\n");
  } catch (err) {
    await fail(err, f);
  }
}

async function runBuy(c: Curviate, f: Flags): Promise<void> {
  const domain = f.domain ?? "";
  if (domain.trim() === "") usage("--domain is required: the domain the Mailboxes send from, one your Team owns.");
  const specs = f.mailbox === undefined ? [] : ([] as string[]).concat(f.mailbox);
  if (specs.length === 0) usage('pass at least one --mailbox local:"Name", up to 50.');
  if (specs.length > 50) usage("at most 50 --mailbox in one order.");
  const body = { domain, mailboxes: specs.map(parseMailboxSpec) };
  const expect = f["expect-amount"] === undefined ? undefined : intFlag("expect-amount", f["expect-amount"], 0);
  if (f.preview) return preview("mailboxes.purchases.create", {}, body);
  const n = specs.length;
  let agreed = expect;
  try {
    if (!f.yes) {
      // A person at a terminal agrees to the server's quote, read now; the order's price is checked against it below.
      if (!process.stdin.isTTY) usage(`this orders Mailboxes that cost money: pass --yes to confirm (no terminal to ask at). Read the price first with: curviate mailbox quote ${n}`);
      const q = (await c.mailboxes.purchases.quote(n)) as unknown as ServedPrice;
      agreed ??= q.amount;
      if (!(await confirmMoney(f, `Order on ${domain}? ${priceLine(q)}`))) return;
    }
    const order = (await c.mailboxes.purchases.create(body as never)) as unknown as Record<string, unknown> & { id: string; price?: ServedPrice };
    renderSuccess(readableObject(order as never), outputOpts(f), process);
    if (agreed !== undefined && order.price?.amount !== agreed) {
      // An order whose price is not the one agreed to is never kept. Awaiting its records it is free to cancel.
      process.stderr.write(`error [PRICE_CHANGED] This order costs ${order.price ? priceLine(order.price) : "an unstated price"} That is not the ${agreed} (minor units) agreed to, so the order is being cancelled.\n`);
      try {
        await c.mailboxes.purchases.cancel(order.id);
        process.stderr.write(`Cancelled ${order.id}; nothing was charged. Read the price again with: curviate mailbox quote ${n}\n`);
      } catch (cancelErr) {
        process.stderr.write(`Cancelling ${order.id} failed: ${(cancelErr as Error).message} Do not order again; read it with: curviate mailbox purchase get ${order.id}\n`);
      }
      process.exit(11);
    }
  } catch (err) {
    const { CurviateError } = await import("@curviate/sdk");
    if (err instanceof CurviateError && err.code === "SPENDING_CAP_REACHED") {
      process.stderr.write(`error [SPENDING_CAP_REACHED] ${BUY_PAST_CAP}\n`);
      process.exit(getExitCode(err));
    }
    await fail(err, f);
  }
}

/**
 * SLD-10/11: what an order's state means for the person or agent reading it. A failed setup is reversed by Curviate
 * (the order reads `provisioning` meanwhile, then `cancelled` with reason `host_failed`, refunded in full): never a
 * retry, never a new order on our say.
 */
export function purchaseNote(order: { state?: unknown; reason?: unknown; id?: unknown; charge_unknown?: unknown }): string | null {
  if (order.charge_unknown === true) return "We are checking whether this order was charged. If it was, the charge is given back in full.";
  if (order.state === "provisioning") return `The Mailboxes are being set up. If that fails, the charge is undone in full and the order ends cancelled (host_failed). Read it again later: curviate mailbox purchase get ${String(order.id ?? "<id>")}. Do not order again meanwhile.`;
  if (order.state === "cancelled" && order.reason === "host_failed") return "Setting up these Mailboxes failed, so the charge was undone in full. Nothing to retry.";
  return null;
}

const printPurchase = (order: Record<string, unknown>, f: Flags) => {
  renderSuccess(readableObject(order as never), outputOpts(f), process);
  const note = purchaseNote(order);
  if (note) process.stderr.write(note + "\n");
};

async function runPurchaseList(c: Curviate, f: Flags): Promise<void> {
  const params: Body = {};
  if (f.state !== undefined) {
    if (!PURCHASE_STATES.includes(f.state)) usage(`--state takes one of ${PURCHASE_STATES.join(", ")}.`);
    params["state"] = f.state;
  }
  if (f.limit !== undefined) params["limit"] = intFlag("limit", f.limit, 1, 100);
  const cursor = readCursorFlag(f, process);
  if (cursor) params["cursor"] = cursor;
  try {
    renderSuccess(await c.mailboxes.purchases.list(params as never), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

async function runPurchaseCheck(c: Curviate, f: Flags): Promise<void> {
  try {
    printPurchase((await c.mailboxes.purchases.check(String(f.id ?? ""))) as Record<string, unknown>, f);
  } catch (err) {
    await fail(err, f);
  }
}

async function runPurchaseGet(c: Curviate, f: Flags): Promise<void> {
  try {
    printPurchase((await c.mailboxes.purchases.get(String(f.id ?? ""))) as Record<string, unknown>, f);
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

const CONNECTIONS = ["google_app_password", "google_sign_in", "microsoft_sign_in", "imap_smtp"];
/** The connections that take a password; the sign-in ones never do (the person signs in on the provider's page). */
const PASSWORD_CONNECTIONS = ["google_app_password", "imap_smtp"];
const SERVER_FLAGS = ["imap-host", "imap-port", "imap-security", "smtp-host", "smtp-port", "smtp-security"] as const;

/** What to tell the person; the words the MCP tools carry for a Mailbox request. */
export const MAILBOX_REQUEST_INSTRUCTION =
  "Ask your user to open this link in the browser where they're signed in to Curviate. It expires in 15 minutes. " +
  "Never ask them for their email password, in chat or anywhere else: a password never passes through you. They enter it on the link's page.";

async function runDiscover(c: Curviate, f: Flags): Promise<void> {
  const address = String(f.address ?? "");
  if (address.trim() === "") usage("the address is empty. Pass the email address to look up.");
  try {
    renderSuccess(readableObject(await c.mailboxes.discover(address)), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

/** The password, from stdin only: `--password-stdin` and nothing else, never from argv, never in an env var. Undefined when the flag is absent. */
async function readPassword(f: Flags): Promise<string | undefined> {
  if (!f["password-stdin"]) return undefined;
  // A preview renders the request without reading the terminal; the field shows masked.
  if (f.preview) return "";
  return resolveSecret({
    stdinRequested: true,
    isTTY: process.stdin.isTTY ?? false,
    required: true,
    failMessage: "--password-stdin read an empty password; nothing was sent. Leave the flag out: the command prints a Connect request link, and the person enters the password on its page.",
    out: process,
  });
}

type Request = { id?: string; kind?: string; status?: string; url?: string; expires_at?: string; mailbox_id?: string | null; admin_consent_url?: string | null; error_code?: string | null };

/** The human-mode lines: the Mailbox once connected, else the link, its expiry, the request and any administrator link. */
export const requestLines = (req: Request): string[] =>
  req.status === "completed"
    ? [`Mailbox: ${req.mailbox_id ?? ""}`, `Request: ${req.id ?? ""}`]
    : [`Link: ${req.url ?? ""}`, `Expires: ${req.expires_at ?? ""}`, `Request: ${req.id ?? ""}`, ...(req.admin_consent_url ? [`Administrator link: ${req.admin_consent_url}`] : [])];

/** One call; then the link to hand over, the Mailbox when the password was checked and stored, or the code the check ended with. */
async function sendRequest(c: Curviate, f: Flags, body: Body): Promise<void> {
  try {
    const req = (await c.connectRequests.create(body as never)) as Request;
    const opts = outputOpts(f);
    if (opts.json) renderSuccess(req, opts, process);
    if (req.error_code) {
      // A refused password answers 201 with the request still open: the exit code is the refusal's, the request id is for a retry or the person's link.
      process.stderr.write(`error [${req.error_code}] the request ${req.id ?? ""} is ${req.status ?? "open"}. Read it: curviate account connect-request get ${req.id ?? "<request_id>"}\n`);
      process.exit(getExitCode(req.error_code as never));
    }
    if (!opts.json) process.stdout.write(requestLines(req).join("\n") + "\n");
    if (req.status !== "completed") process.stderr.write(`${MAILBOX_REQUEST_INSTRUCTION}\nCheck on it: curviate account connect-request get ${req.id ?? "<request_id>"}\n`);
  } catch (err) {
    await fail(err, f);
  }
}

const withPassword = (body: Body, password: string | undefined): Body => (password === undefined ? body : { ...body, credentials: { password } });

async function runConnect(c: Curviate, f: Flags): Promise<void> {
  const address = String(f.address ?? "");
  if (address.trim() === "") usage("the address is empty. Pass the email address to connect.");
  const connection = f.connection ?? "";
  if (!CONNECTIONS.includes(connection)) usage(`--connection takes one of ${CONNECTIONS.join(", ")}.`);
  if (f["password-stdin"] && !PASSWORD_CONNECTIONS.includes(connection)) usage(`--password-stdin does not apply to ${connection}: the person signs in on the provider's page. It takes ${PASSWORD_CONNECTIONS.join(" or ")}.`);
  const mailbox: Body = { connection, address };
  if (f["display-name"] !== undefined) mailbox["display_name"] = f["display-name"];
  if (connection === "imap_smtp") {
    const missing = SERVER_FLAGS.filter((k) => f[k] === undefined || f[k]!.trim() === "");
    if (missing.length > 0) usage(`--connection imap_smtp needs ${missing.map((k) => `--${k}`).join(", ")} (the settings from \`curviate mailbox discover\`, as the person confirmed them).`);
    for (const side of ["imap", "smtp"] as const) {
      const security = f[`${side}-security`]!;
      if (security !== "tls" && security !== "starttls") usage(`--${side}-security takes tls or starttls, never cleartext.`);
      mailbox[side] = { host: f[`${side}-host`], port: intFlag(`${side}-port`, f[`${side}-port`]!, 1, 65535), security };
    }
  } else {
    const given = SERVER_FLAGS.filter((k) => f[k] !== undefined);
    if (given.length > 0) usage(`${given.map((k) => `--${k}`).join(", ")} apply to --connection imap_smtp only.`);
  }
  const body = withPassword({ mailbox }, await readPassword(f));
  if (f.preview) return preview("connectRequests.create", {}, body);
  await sendRequest(c, f, body);
}

async function runReconnect(c: Curviate, f: Flags): Promise<void> {
  const id = String(f.id ?? "");
  if (id.trim() === "") usage("the Mailbox id is empty. Pass the mbx_... id from `curviate mailbox list`.");
  const body = withPassword({ mailbox_id: id }, await readPassword(f));
  if (f.preview) return preview("connectRequests.create", {}, body);
  await sendRequest(c, f, body);
}

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
      "One Mailbox: address, state, Sends for and its suggestion, daily cap (and cap_lowered_to when a spam reading lowered it), sent today, bounces over 7 days, signature, which Accounts and Campaigns used it, warm_up (state: off, warming (day N; past its days it stays warming until ready), ready (the warm-up's bar is met; sending does not change) or waiting; day; reason: paused_by_curviate, reconnect_needed, trial, app_password, warm_up_app, allowance, address_check: the address is being confirmed, nothing to do, or address_unconfirmed: check the connection settings, Curviate tries again), reputation (0 to 100, or null: with reputation_reason warm_up_off there is no score because warm-up is off, else gathering, never 0), and landing: where its own warm-up mail lands per receiving provider over 7 days (google, microsoft, other: inbox, partly_spam, spam, or gathering while there is not enough to say; landing.reason warm_up_off: warm-up is off, nothing to read). Every role reads.",
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
      "its signature (--signature-file, plain text, up to 2,000 characters, available as {{mailbox.signature}}; nothing adds it to an email by itself) " +
      "its From name (--display-name, one line, up to 100 characters; --clear-display-name sends with the name of the Account it sends for) " +
      "and Mailbox warm-up (--warm-up on --days 10|14|21|28: short everyday emails exchanged with other Teams' Mailboxes, filed in their own folder, so the Mailbox builds a sending history, included in the plan; --warm-up off stops it; `mailbox get` shows warm_up with its state and day). Flags you leave out stay as they are. " +
      "A Mailbox linked to no Account sends nothing. Owners and Managers change any Mailbox; a Member only the ones they connected.",
    risk: "write",
    rules: {
      changes: "The Mailbox's link, daily cap, signature, From name or warm-up, from the next email on. Open threads stay on it.",
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
      "curviate mailbox update mbx_YOUR_MAILBOX_ID --warm-up on --days 14",
    ],
    requires: ["at least one of --sends-for, --daily-cap, --signature-file, --display-name, --clear-display-name, --warm-up."],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    id: ID,
    "sends-for": { type: "string", description: "An Account id (acc_..., it then sends only for that Account) or shared (any Account of your Team may send from it)." },
    "daily-cap": { type: "string", description: "Emails a day across every Campaign and Account, 1 to 50. The API refuses a higher value (exit 2, the message names 50)." },
    "signature-file": { type: "string", stdinArg: true, description: "A plain-text file with the sign-off: a path, or - to read it from stdin. Up to 2,000 characters." },
    "display-name": { type: "string", description: "The name recipients see in From, one line, up to 100 characters." },
    "clear-display-name": { type: "boolean", description: "Clear the From name: the Mailbox sends with the name of the Account it sends for." },
    "warm-up": { type: "string", description: "on (Recommended) or off: Mailbox warm-up." },
    days: { type: "string", description: "With --warm-up on: how many days warm-up runs before the Mailbox can be ready, 10, 14, 21 or 28." },
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
    description:
      "Remove a Mailbox and delete its stored credentials in one step. Changes no seat count. Connect it again to use the address afterwards. " +
      "A Mailbox from Curviate is an Owner's to remove: it is deleted with its mail, and its charge stops at the end of the billing period. " +
      "MAILBOX_STATE_CONFLICT (exit 8) \"Too many Mailbox changes are still settling with billing\" changed nothing: the person may try again later; never resend it on your own.",
    risk: "high",
    rules: {
      changes: "The Mailbox and its credentials are deleted; emails due from it are not sent. A Mailbox from Curviate is deleted with its mail; its charge ends at the period's end.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "Safe: a second call answers MAILBOX_NOT_FOUND.",
      undo: "None: connect the address again.",
      blast_radius: "One Mailbox and every Campaign that sends from it.",
    },
    errors: { ...NOT_FOUND, INSUFFICIENT_ROLE: "a Member removes only a Mailbox they connected; a Mailbox from Curviate is an Owner's.", MAILBOX_STATE_CONFLICT: "changes are still settling with billing; nothing was changed. Try again later, never in a loop." },
    seeAlso: ["curviate mailbox list", "curviate mailbox pause"],
    examples: ["curviate mailbox remove mbx_YOUR_MAILBOX_ID"],
  },
  args: { ...WRITE_SINGLE_FLAGS, id: ID },
  run: online(act("remove")),
});

const ADDRESS = { type: "positional" as const, description: "The email address." };
const PASSWORD_STDIN = {
  type: "boolean" as const,
  description: "Check and keep a password the person gave you: one line from stdin, never echoed, sent only in the request body and never printed. No flag takes the password as a value: it would show in `ps` and in shell history.",
  default: false,
};

const discoverCmd = defineCommand({
  meta: {
    name: "discover",
    description:
      "Find the IMAP and SMTP settings for an email address, to show the person and confirm before connecting. An address on Google or Microsoft answers with its connection. " +
      "confirm_required marks settings that arrived unencrypted or are a guess; a domain with nothing usable answers source none with no settings. Takes no password and the answer holds none.",
    risk: "read",
    seeAlso: ["curviate mailbox connect"],
    examples: ["curviate mailbox discover anna@acme.example"],
  },
  args: { ...readOnly(READ_SINGLE_FLAGS), address: ADDRESS },
  run: online(runDiscover),
});

const connectCmd = defineCommand({
  meta: {
    name: "connect",
    description:
      "Connect a new Mailbox: creates a Connect request and prints its link for the person, who finishes in their Curviate dashboard. " +
      "--connection google_sign_in (a Google Workspace whose administrator trusts Curviate) and microsoft_sign_in print the sign-in link and, where the provider needs one, the administrator link. " +
      "A password never passes through an agent: give the person the link. A person at their own terminal may instead connect google_app_password or imap_smtp in one call with --password-stdin (read from standard input, never echoed); Curviate checks it before answering. " +
      "imap_smtp needs the six server flags (the settings from `curviate mailbox discover`, as the person confirmed them). One API call.",
    risk: "write",
    rules: {
      changes: "Creates a Connect request. With --password-stdin on google_app_password or imap_smtp, the password is checked and, if it works, the Mailbox is connected and the password is stored sealed (never returned).",
      visible_to: "Your Team: the request is listed under Accounts for the person it is for.",
      budget_rows: [],
      retry: "Not safe: a repeated call creates a second request. Read `curviate account connect-request get <request_id>` first.",
      undo: "`curviate account connect-request cancel <request_id>` before it completes; `curviate mailbox remove <id>` after.",
    },
    errors: {
      MAILBOX_ALREADY_CONNECTED: "this address is already a Mailbox of your Team.",
      MAILBOX_APP_PASSWORD_REQUIRED: "a private Gmail address connects with an app password, not google_sign_in; or the password is Google's own, not an app password.",
      MAILBOX_CREDENTIAL_REJECTED: "the host refused the password (exit 8); the request stays open for another try.",
      MAILBOX_TLS_FAILED: "the host does not offer the encryption the settings name (exit 8).",
      MAILBOX_LIMIT_REACHED: "your Team is past its Mailbox allowance (exit 2).",
    },
    seeAlso: ["curviate mailbox discover", "curviate mailbox reconnect", "curviate account connect-request get"],
    examples: [
      "curviate mailbox connect anna@acme.example --connection google_sign_in",
      "curviate mailbox connect anna@gmail.com --connection google_app_password --password-stdin < app-password.txt",
      "curviate mailbox connect anna@acme.example --connection imap_smtp --imap-host imap.acme.example --imap-port 993 --imap-security tls --smtp-host smtp.acme.example --smtp-port 465 --smtp-security tls --password-stdin < mail-password.txt",
    ],
    requires: ["--connection: google_app_password, google_sign_in, microsoft_sign_in or imap_smtp.", "--connection imap_smtp: --imap-host, --imap-port, --imap-security, --smtp-host, --smtp-port, --smtp-security."],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    address: ADDRESS,
    connection: { type: "string", description: `How the Mailbox connects: ${CONNECTIONS.join(" | ")}.` },
    "password-stdin": PASSWORD_STDIN,
    "display-name": { type: "string", description: "The name recipients see in From (\"Name\" <address>), one line, up to 100 characters. Default: the name of the Account the Mailbox sends for, else the bare address." },
    "imap-host": { type: "string", description: "imap_smtp only: the IMAP host." },
    "imap-port": { type: "string", description: "imap_smtp only: the IMAP port (usually 993 with tls, 143 with starttls)." },
    "imap-security": { type: "string", description: "imap_smtp only: tls (TLS from the first byte) or starttls. Never cleartext." },
    "smtp-host": { type: "string", description: "imap_smtp only: the SMTP submission host." },
    "smtp-port": { type: "string", description: "imap_smtp only: the SMTP submission port (usually 465 with tls, 587 with starttls)." },
    "smtp-security": { type: "string", description: "imap_smtp only: tls or starttls. Never cleartext." },
  },
  run: online(runConnect),
});

const reconnectCmd = defineCommand({
  meta: {
    name: "reconnect",
    description:
      "Reconnect a Mailbox of your Team (state reconnect_needed, or any other): creates a Connect request and prints its link for the person. " +
      "With --password-stdin on a google_app_password or imap_smtp Mailbox, the new password is checked and replaces the old one in this one call. " +
      "On a google_sign_in Mailbox, --password-stdin adds an app password beside the sign-in, for warm-up; sending and reply checks stay on the sign-in. A microsoft_sign_in Mailbox takes no password. One API call.",
    risk: "write",
    rules: {
      changes: "Creates a Connect request. With --password-stdin, the password is checked and stored sealed in place of the old one (never returned).",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "Not safe: a repeated call creates a second request. Read `curviate account connect-request get <request_id>` first.",
      undo: "`curviate account connect-request cancel <request_id>` before it completes.",
    },
    errors: { ...NOT_FOUND, MAILBOX_CREDENTIAL_REJECTED: "the host refused the password (exit 8); the request stays open for another try.", MAILBOX_ADDRESS_MISMATCH: "the sign-in was for another address; nothing changed." },
    seeAlso: ["curviate mailbox connect", "curviate account connect-request get"],
    examples: ["curviate mailbox reconnect mbx_YOUR_MAILBOX_ID", "curviate mailbox reconnect mbx_YOUR_MAILBOX_ID --password-stdin < app-password.txt"],
  },
  args: { ...WRITE_SINGLE_FLAGS, id: ID, "password-stdin": PASSWORD_STDIN },
  run: online(runReconnect),
});

const testCmd = defineCommand({
  meta: {
    name: "test",
    description:
      "Run a placement test: your exact subject and body go from this Mailbox to 12 test inboxes, 3 at each of Google Workspace, Microsoft 365, Gmail and Outlook.com, and each copy's landing is read; results within an hour (`curviate mailbox tests <id> <test_id>`). " +
      "The 12 copies count against the Mailbox's daily cap, so it needs room for 12 today. Each test draws one from the Team's allowance: 10 per paid seat a month, pooled across the Team (a trial has none). " +
      "Owners and Managers test any Mailbox; a Member only the ones they connected. One API call, never retried.",
    risk: "write",
    rules: {
      changes: "12 emails leave the Mailbox today, under its daily cap; the Team's allowance goes down by one.",
      visible_to: "Your Team; the copies go to test inboxes only.",
      budget_rows: [],
      retry: "Not safe: a second run is a second test, 12 more emails and one more from the allowance. Read `mailbox tests` first.",
      undo: "None: the copies are sent.",
      blast_radius: "One Mailbox's daily cap and one test of the Team's month.",
    },
    errors: {
      ...NOT_FOUND,
      PLACEMENT_TEST_ALLOWANCE_EXHAUSTED: "this month's tests are used, or the Team has no paid seat yet; the message says when it resets. Nothing was sent. Waiting minutes does not help: a paid seat or the new month does.",
      PLACEMENT_TESTS_UNAVAILABLE: "placement tests cannot run right now. Nothing was sent, nothing drawn.",
      MAILBOX_STATE_CONFLICT: "the Mailbox cannot send now (paused, reconnect needed). Nothing was sent.",
      INVALID_REQUEST: "the Mailbox has no room for 12 more emails today, or the subject or body is empty, too long or malformed. Nothing was sent.",
    },
    output: ["The test: id, status (running), verdicts per provider (null while running), allowance { used, total, resets_at }."],
    seeAlso: ["curviate mailbox tests", "curviate campaign placement"],
    examples: [
      "curviate mailbox test mbx_YOUR_MAILBOX_ID --subject \"Quick question\" --body-file body.txt",

    ],
    requires: ["--subject and --body-file."],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    id: ID,
    subject: { type: "string", description: "The subject exactly as your Campaign sends it: one line, up to 998 characters." },
    "body-file": { type: "string", stdinArg: true, description: "A plain-text file with the body exactly as your Campaign sends it: a path, or - to read it from stdin. Up to 10,000 characters." },
  },
  run: online(runTest),
});

const testsCmd = defineCommand({
  meta: {
    name: "tests",
    description:
      "This Mailbox's placement tests, newest first, with the Team's allowance { used, total, resets_at }; with a test id, that one test. A test is running or complete, with a verdict per provider: inbox (all 3 copies in the inbox), partly_spam or spam (none in the inbox). Every role reads. One API call.",
    risk: "read",
    errors: NOT_FOUND,
    output: ["items[] (id, status, created_at, completed_at, verdicts), cursor, allowance; or one test."],
    seeAlso: ["curviate mailbox test"],
    examples: ["curviate mailbox tests mbx_YOUR_MAILBOX_ID", "curviate mailbox tests mbx_YOUR_MAILBOX_ID plt_YOUR_TEST_ID"],
  },
  args: {
    ...readOnly(READ_SINGLE_FLAGS),
    id: ID,
    testId: { type: "positional" as const, required: false, description: "One test (plt_...), from the list." },
    limit: { type: "string", description: "Tests per page (1 to 100)." },
    cursor: GLOBAL_FLAGS.cursor,
  },
  run: online(runTests),
});

const buyCmd = defineCommand({
  meta: {
    name: "buy",
    description:
      "Order 1 to 50 Mailboxes from Curviate on one domain your Team owns, warm-up included. The price is your Team's, read from the server: `curviate mailbox quote <count>`, which a terminal prompt also shows; --expect-amount <amount> (the quote's `amount`) cancels the order at once when its `price` differs (exit 11). The order waits in awaiting_dns until the records it lists (mx, spf, dkim, dmarc, verify, and tracking, which is optional) are found at your domain, each added exactly as shown; nothing is charged before, and an order still waiting after 14 days is cancelled. " +
      "Team Owners only. An order through an API key counts under the Team's cap on Mailboxes from Curviate (`curviate billing cap` shows mailbox_cap), which only an Owner raises, in the dashboard: from 80% of it the order carries a SPENDING_CAP_NEAR notice, past it the order is refused (exit 5) and nothing is ordered. Read orders with `curviate mailbox purchase list`.",
    risk: "high",
    rules: {
      changes: "An order in awaiting_dns; once its records are found, the Mailboxes are created and charged as its `price` says (a yearly Team pays the rest of its year that day).",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "Never retried. A second order for the same domain while one waits is refused (MAILBOX_PURCHASE_PENDING).",
      undo: "An order still waiting for its records lapses after 14 days, uncharged.",
      blast_radius: "One domain's mail: the MX record it asks for routes the domain's mail to the new Mailboxes.",
    },
    errors: {
      SPENDING_CAP_REACHED: "the order would pass the Team's cap on Mailboxes from Curviate; only an Owner raises it, in the dashboard. Nothing was ordered.",
      INSUFFICIENT_ROLE: "only a Team Owner orders.",
      MAILBOX_PURCHASE_TRIAL: "a Team without a paid plan cannot order: on a trial, after a trial that ended without a purchase, never subscribed, or with a payment past due. Buy a seat or update the payment method, then order. Nothing was charged.",
      MAILBOX_PURCHASE_PENDING: "this domain already has an order waiting for its records.",
      DOMAIN_IN_USE: "the domain already has Mailboxes from Curviate or an order; name another domain.",
      DOMAIN_IS_COMPANY_EMAIL: "the domain your company email runs on; use a separate domain.",
      INVALID_REQUEST: "among others, a subdomain (mail.acme.com): Mailboxes from Curviate go on a domain of your own, such as acme-mail.com.",
      MAILBOX_SALES_PAUSED: "orders cannot be placed at the moment.",
    },
    output: ["The order: id, domain, state (awaiting_dns), mailboxes[], records[] (mx, spf, dkim, dmarc, verify, tracking), price (as `curviate mailbox quote`), amount_monthly (the monthly equivalent), expires_at."],
    seeAlso: ["curviate mailbox purchase list", "curviate domain check"],
    examples: [
      "curviate mailbox buy --domain acme-mail.example --mailbox 'anna:Anna Weber:shared' --yes",
      "curviate mailbox buy --domain acme-mail.example --mailbox 'anna:Anna Weber:acc_YOUR_ACCOUNT_ID' --mailbox 'max:Max Weber' --yes",
    ],
    requires: ["--domain and at least one --mailbox."],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    domain: { type: "string", description: "The domain the Mailboxes send from, one your Team owns and not the one your company email runs on." },
    mailbox: { type: "string", description: 'One Mailbox, repeatable up to 50: local:Name, the part before the @ and the name recipients see; add :acc_... (the Account it sends for) or :shared at the end.' },
    yes: { type: "boolean", description: "Confirm the order without a prompt (needed when no terminal can ask)." },
    "expect-amount": { type: "string", description: "The quote's `amount` the person agreed to (minor units): an order whose `price.amount` differs is cancelled at once, exit 11." },
  },
  run: online(runBuy),
});

const quoteCmd = defineCommand({
  meta: {
    name: "quote",
    description:
      "What a number of Mailboxes from Curviate cost your Team, read now from the price the charge uses: the amount for your Team's billing period (a yearly Team pays the rest of its year the day the records are found), when it is charged, and whether your Team can order now. " +
      "Show this to the person before `curviate mailbox buy`, never a price of your own. Charges nothing. Owners only.",
    risk: "read",
    errors: { INSUFFICIENT_ROLE: "only a Team Owner reads the price of Mailboxes from Curviate." },
    output: [
      "`mailboxes`, `currency`, `billing_period` (monthly or annual), `unit_amount` and `amount` (minor units, before tax), `amount_monthly`, `charged` (with_next_invoice, when_records_found or never), `prorated`, `plus_tax`, `orderable`, `not_orderable_reason` (trial: no paid plan or a payment past due; sales_paused), `charge_waits_for` (payment, subscription). The same in one sentence on stderr.",
    ],
    seeAlso: ["curviate mailbox buy", "curviate billing cap"],
    examples: ["curviate mailbox quote 3", "curviate mailbox quote 3 --json"],
  },
  args: { ...readOnly(READ_SINGLE_FLAGS), count: { type: "positional" as const, description: "How many Mailboxes, 1 to 50." } },
  run: online(runQuote),
});

const purchaseListCmd = defineCommand({
  meta: {
    name: "list",
    description: "Your Team's orders of Mailboxes from Curviate, newest first: state (awaiting_dns, provisioning, active, cancelled), the records to add and which are found. Every role reads. One API call per page.",
    risk: "read",
    seeAlso: ["curviate mailbox purchase get"],
    examples: ["curviate mailbox purchase list", "curviate mailbox purchase list --state awaiting_dns"],
  },
  args: {
    ...readOnly(READ_SINGLE_FLAGS),
    state: { type: "string", description: `Only orders in this state: ${PURCHASE_STATES.join(" | ")}.` },
    limit: { type: "string", description: "Orders per page (1 to 100)." },
    cursor: GLOBAL_FLAGS.cursor,
  },
  run: online(runPurchaseList),
});

const purchaseGetCmd = defineCommand({
  meta: {
    name: "get",
    description: "One order of Mailboxes from Curviate: its state, the six records to add at your domain exactly as shown (mx, spf, dkim, dmarc, verify, tracking; tracking is optional; the mx row also holds a CNAME that confirms the domain is yours, verify a TXT record that confirms the order is yours) and which are found, and its Mailboxes once active. awaiting_dns waits for the records; provisioning means charged and being set up; active is done; cancelled carries its reason (requested, expired, host_failed: setting up failed and the charge was undone in full). charge_unknown is true while Curviate cannot tell whether the order's charge was made: it is being checked, and a charge that was made is given back in full; do not order again. Every role reads. One API call.",
    risk: "read",
    errors: { MAILBOX_PURCHASE_NOT_FOUND: "no order of your Team has this id (another Team's id answers the same)." },
    seeAlso: ["curviate mailbox purchase list", "curviate mailbox list"],
    examples: ["curviate mailbox purchase get mpu_YOUR_PURCHASE_ID"],
  },
  args: { ...readOnly(READ_SINGLE_FLAGS), id: { type: "positional" as const, description: "The order (mpu_...), from `curviate mailbox purchase list`." } },
  run: online(runPurchaseGet),
});

const purchaseCheckCmd = defineCommand({
  meta: {
    name: "check",
    description: "Look up an order's records now instead of waiting for Curviate's own checks (every 15 minutes for 2 hours after the order, then hourly); answers the order with each row's found. Once a minute per order: sooner is refused (exit 6) with the time to wait. Owners only. One API call.",
    risk: "read",
    errors: { MAILBOX_PURCHASE_NOT_FOUND: "no order of your Team has this id (another Team's id answers the same).", PLATFORM_RATE_LIMIT: "this order was checked less than a minute ago." },
    seeAlso: ["curviate mailbox purchase get"],
    examples: ["curviate mailbox purchase check mpu_YOUR_PURCHASE_ID"],
  },
  args: { ...readOnly(READ_SINGLE_FLAGS), id: { type: "positional" as const, description: "The order (mpu_...), from `curviate mailbox purchase list`." } },
  run: online(runPurchaseCheck),
});

async function runPurchaseCancel(c: Curviate, f: Flags): Promise<void> {
  const id = String(f.id ?? "");
  if (id.trim() === "") usage("the order id is empty. Pass the mpu_... id from `curviate mailbox purchase list`.");
  if (f.preview) return preview("mailboxes.purchases.cancel", { id });
  try {
    renderSuccess(readableObject(await c.mailboxes.purchases.cancel(id)), outputOpts(f), process);
  } catch (err) {
    const { CurviateError } = await import("@curviate/sdk");
    if (err instanceof CurviateError && err.code === "MAILBOX_PURCHASE_STATE_CONFLICT") {
      // A charge under way is neither a failure to retry nor a cancellation: the order is read again later.
      process.stderr.write(`error [MAILBOX_PURCHASE_STATE_CONFLICT] ${err.message} Nothing was changed; do not retry. Read it with: curviate mailbox purchase get ${id}\n`);
      process.exit(getExitCode(err));
    }
    await fail(err, f);
  }
}

const purchaseCancelCmd = defineCommand({
  meta: {
    name: "cancel",
    description: "Cancel an order of Mailboxes from Curviate still waiting for its records: nothing was charged, so nothing is refunded. An order being charged, being set up, active or cancelled is refused (exit 8) and stays as it is; while a charge is under way, read the order again in a few minutes. Owners only. One API call, never retried.",
    risk: "high",
    rules: {
      changes: "The order ends cancelled; its domain's records are no longer looked for. No Mailbox is created and nothing is charged.",
      visible_to: "Your Team.",
      budget_rows: [],
      retry: "Not needed: a second cancel answers MAILBOX_PURCHASE_STATE_CONFLICT (already cancelled).",
      undo: "Order again with `curviate mailbox buy`.",
      blast_radius: "One order.",
    },
    errors: {
      MAILBOX_PURCHASE_NOT_FOUND: "no order of your Team has this id (another Team's id answers the same).",
      MAILBOX_PURCHASE_STATE_CONFLICT: "the order is not waiting for its records (being charged, being set up, active or cancelled); the message names its state. Read it again later; never retry.",
    },
    seeAlso: ["curviate mailbox purchase get", "curviate mailbox purchase list"],
    examples: ["curviate mailbox purchase cancel mpu_YOUR_PURCHASE_ID"],
  },
  args: { ...WRITE_SINGLE_FLAGS, id: { type: "positional" as const, description: "The order (mpu_...), from `curviate mailbox purchase list`." } },
  run: online(runPurchaseCancel),
});

const purchaseCmd = defineCommand({
  meta: { name: "purchase", description: "Your Team's orders of Mailboxes from Curviate: list, get, check (look the records up now), cancel (an order still waiting for its records)." },
  subCommands: { list: purchaseListCmd, get: purchaseGetCmd, check: purchaseCheckCmd, cancel: purchaseCancelCmd },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(purchaseCmd, ["curviate", "mailbox", "purchase"]);
  },
});

export const mailboxCommand = defineCommand({
  meta: { name: "mailbox", description: DESCRIPTIONS["mailbox"] },
  subCommands: { list: listCmd, get: getCmd, update: updateCmd, pause: pauseCmd, resume: resumeCmd, remove: removeCmd, discover: discoverCmd, connect: connectCmd, reconnect: reconnectCmd, test: testCmd, tests: testsCmd, quote: quoteCmd, buy: buyCmd, purchase: purchaseCmd },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(mailboxCommand, ["curviate", "mailbox"]);
  },
});
