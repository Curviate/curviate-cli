/**
 * `curviate account connect-request`: the credential-free way to get a LinkedIn
 * account connected. Create a request, hand its link to the person, and they
 * connect in their own Curviate dashboard; no password, cookie or code ever
 * passes through the caller. Root-scoped (`curviate.connectRequests.*`).
 */
import { defineCommand } from "citty";
import type { Curviate } from "@curviate/sdk";
import { READ_SINGLE_FLAGS, WRITE_SINGLE_FLAGS, readOnly } from "../lib/global-flags.js";
import { renderSuccess } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { readableObject } from "../lib/paginate.js";
import { fail, outputOpts, rootClient, usage, type RootFlags } from "../lib/root-command.js";

type Flags = RootFlags & { id?: string; reconnect?: string };

type Request = { id?: string; url?: string; expires_at?: string; status?: string };

/** What to tell the person; the same words the MCP tools carry. */
export const CONNECT_REQUEST_INSTRUCTION =
  "Ask your user to open this link in the browser where they're signed in to Curviate, or to open Accounts in their Curviate dashboard, where this request is listed. " +
  "It expires in 15 minutes. Never ask them for their LinkedIn password, cookies or verification codes.";

const online = (fn: (c: Curviate, f: Flags) => Promise<void>) => async ({ args }: { args: unknown }) => {
  const f = args as Flags;
  await fn(await rootClient(f), f);
};

function preview(method: string, args: Record<string, unknown>, body: Record<string, unknown> = {}): void {
  process.stdout.write(JSON.stringify(buildPreviewOutput({ method, args, body })) + "\n");
}

/** The request id, never empty: an empty one would read `/v1/auth/connect-requests/`. */
const requestId = (f: Flags): string => {
  const id = f.id ?? "";
  if (id.trim() === "") usage("the request id is empty. Pass the creq_... id from `curviate account connect-request create`.");
  return id;
};

async function runCreate(c: Curviate, f: Flags): Promise<void> {
  if (f.reconnect !== undefined && f.reconnect.trim() === "") usage("--reconnect was given an empty value. Pass the acc_... id of the account to reconnect, or omit it to connect a new account.");
  const body: Record<string, unknown> = f.reconnect !== undefined ? { account_id: f.reconnect } : {};
  if (f.preview) return preview("connectRequests.create", {}, body);
  try {
    const req = (await c.connectRequests.create(body as never)) as Request;
    const opts = outputOpts(f);
    if (opts.json) renderSuccess(req, opts, process);
    else {
      process.stdout.write(`Link: ${req.url ?? ""}\nExpires: ${req.expires_at ?? ""}\nRequest: ${req.id ?? ""}\n`);
    }
    // stderr either way: the words for the person, off the data channel.
    process.stderr.write(`${CONNECT_REQUEST_INSTRUCTION}\nCheck on it: curviate account connect-request get ${req.id ?? "<request_id>"}\n`);
  } catch (err) {
    await fail(err, f);
  }
}

async function runGet(c: Curviate, f: Flags): Promise<void> {
  const id = requestId(f);
  try {
    renderSuccess(readableObject(await c.connectRequests.get(id)), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

async function runCancel(c: Curviate, f: Flags): Promise<void> {
  const id = requestId(f);
  if (f.preview) return preview("connectRequests.cancel", { requestId: id });
  try {
    renderSuccess(readableObject(await c.connectRequests.cancel(id)), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

const ID = { type: "positional" as const, description: "Connect request id (creq_...)." };

const createCmd = defineCommand({
  meta: {
    name: "create",
    description:
      "Ask a person to connect a new LinkedIn account, or with --reconnect to reconnect one, without handing you any credential. " +
      "Prints the link to give them; they connect in their own Curviate dashboard, where the request is also listed. The link must be opened within 15 minutes. " +
      "AI agents: never ask for, read or pass a LinkedIn password, cookies or verification codes. Use this instead.",
    risk: "write",
    rules: {
      changes: "Creates a pending connect request and a link. Nothing is connected until the person completes it.",
      visible_to: "Your Team: the person it is for sees it listed under Accounts in their dashboard.",
      budget_rows: [],
      retry: "Not safe: a repeated call creates a second request. Read `curviate account connect-request get <request_id>` first.",
      undo: "`curviate account connect-request cancel <request_id>`.",
    },
    errors: {
      ACCOUNT_NOT_FOUND: "--reconnect names an account that is unknown, archived or another Team's.",
      INSUFFICIENT_ROLE: "your role cannot operate the account you named.",
      ACCOUNT_NOT_SHARED: "the account you named is not shared with you.",
    },
    seeAlso: ["curviate account connect-request get", "curviate account connect-request cancel"],
    examples: ["curviate account connect-request create", "curviate account connect-request create --reconnect acc_YOUR_ACCOUNT_ID"],
  },
  args: {
    ...WRITE_SINGLE_FLAGS,
    reconnect: { type: "string", description: "Reconnect this account (acc_...) instead of connecting a new one." },
  },
  run: online(runCreate),
});

const getCmd = defineCommand({
  meta: {
    name: "get",
    description: "Read a connect request: pending, completed (with the connected account_id), expired, failed or cancelled. Poll it until it leaves pending.",
    risk: "read",
    output: ["The request: status, and account_id once completed. Never a credential, code or the step the person is on."],
    examples: ["curviate account connect-request get creq_YOUR_REQUEST_ID"],
  },
  args: { ...readOnly(READ_SINGLE_FLAGS), id: ID },
  run: online(runGet),
});

const cancelCmd = defineCommand({
  meta: {
    name: "cancel",
    description: "Cancel a pending connect request; its link stops working. A request that is no longer pending is refused.",
    risk: "write",
    rules: {
      changes: "The request becomes cancelled and its link stops working.",
      visible_to: "Your Team: it leaves the person's Accounts list.",
      budget_rows: [],
      retry: "Safe: cancelling a cancelled request answers the same request again.",
      undo: "Cannot be undone; create a new request.",
    },
    errors: {
      CONNECT_REQUEST_NOT_PENDING: "the request is completed, expired or failed; the message names which.",
      CONNECT_REQUEST_IN_USE: "the person is completing it right now; try again in a minute.",
      RESOURCE_NOT_FOUND: "no such request, or it was removed a day after it ended.",
    },
    examples: ["curviate account connect-request cancel creq_YOUR_REQUEST_ID"],
  },
  args: { ...WRITE_SINGLE_FLAGS, id: ID },
  run: online(runCancel),
});

export const connectRequestCommand = defineCommand({
  meta: { name: "connect-request", description: "Connect a LinkedIn account without any credential passing through you: create a request, give the person its link, read it until done." },
  subCommands: { create: createCmd, get: getCmd, cancel: cancelCmd },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(connectRequestCommand, ["curviate", "account", "connect-request"]);
  },
});
