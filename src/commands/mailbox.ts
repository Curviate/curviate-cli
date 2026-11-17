/**
 * `curviate mailbox`: your Team's own email Mailboxes. Root-scoped
 * (`curviate.mailboxes.*`): list, read, change (Sends for, daily cap,
 * signature), pause, resume, remove, find settings for an address, connect and
 * reconnect. Each command makes one API call.
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
  address?: string;
  connection?: string;
  "password-stdin"?: boolean;
  "imap-host"?: string;
  "imap-port"?: string;
  "imap-security"?: string;
  "smtp-host"?: string;
  "smtp-port"?: string;
  "smtp-security"?: string;
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

const CONNECTIONS = ["google_app_password", "google_sign_in", "microsoft_sign_in", "imap_smtp"];
/** The connections that take a password; the sign-in ones never do (the person signs in on the provider's page). */
const PASSWORD_CONNECTIONS = ["google_app_password", "imap_smtp"];
const SERVER_FLAGS = ["imap-host", "imap-port", "imap-security", "smtp-host", "smtp-port", "smtp-security"] as const;

/** What to tell the person; the words the MCP tools carry for a Mailbox request. */
export const MAILBOX_REQUEST_INSTRUCTION =
  "Ask your user to open this link in the browser where they're signed in to Curviate. It expires in 15 minutes. " +
  "Never ask them for their email password in chat; to submit an app password yourself, pipe it to --password-stdin.";

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
    failMessage: "--password-stdin read an empty password. Pipe the password in (printf '%s' \"$APP_PASSWORD\" | curviate mailbox ... --password-stdin), or leave the flag out and give the person the link.",
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
      "confirm_required marks settings that arrived unencrypted. Takes no password and the answer holds none.",
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
      "google_app_password and imap_smtp can also take the password from you: pipe it to --password-stdin, Curviate checks it before answering, and the Mailbox is connected in this one call. " +
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

export const mailboxCommand = defineCommand({
  meta: { name: "mailbox", description: DESCRIPTIONS["mailbox"] },
  subCommands: { list: listCmd, get: getCmd, update: updateCmd, pause: pauseCmd, resume: resumeCmd, remove: removeCmd, discover: discoverCmd, connect: connectCmd, reconnect: reconnectCmd },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(mailboxCommand, ["curviate", "mailbox"]);
  },
});
