/**
 * `curviate webhook` — webhook registration and event verification (root-scoped).
 *
 * Subcommands:
 *   webhook create <body…>             — register a webhook (write)
 *   webhook list                       — list webhooks
 *   webhook events                     — list the canonical event catalogue
 *   webhook get <id>                   — get a single webhook (read)
 *   webhook update <id> <body…>        — update a webhook (write; --source is usage error)
 *   webhook delete <id>                — delete a webhook (write)
 *   webhook verify                     — offline HMAC verification (no network)
 *
 * Root-scoped: methods live on `curviate.webhooks.*`.
 * `webhook verify` is NOT an SDK API method — it calls the SDK's `constructEvent`
 * offline; no Curviate client is constructed.
 */

import { defineCommand } from "citty";
import { GLOBAL_FLAGS } from "../lib/global-flags.js";
import { resolveEffectiveConfig } from "../lib/resolve.js";
import { createClient } from "../lib/client.js";
import { renderSuccess, renderError, renderUnexpectedError } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { streamAll, pageDelayFromFlags } from "../lib/paginate.js";
import { defaultReadStdin, isStdinToken } from "../lib/stdin.js";
import { readFileSync } from "node:fs";
import type { Curviate, CurviateError, paths } from "@curviate/sdk";

/**
 * `POST /v1/webhooks` body — a `source`-discriminated union (messaging | user
 * | account_status), each with its own `events`/`data` enum arrays. `source`,
 * `events`, and `data` are free-form CLI flags (comma-split strings), so
 * proving the literal-union match statically isn't practical here — a single
 * narrow cast at this body-argument call site stands in; the server
 * validates the enum values on any mismatch.
 */
type WebhookCreateBody = paths["/v1/webhooks"]["post"]["requestBody"]["content"]["application/json"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WebhookFlags = {
  id?: string;
  "account-id"?: string;
  "account-ids"?: string;
  "request-url"?: string;
  source?: string;
  name?: string;
  format?: string;
  enabled?: boolean;
  events?: string;
  data?: string;
  cursor?: string;
  limit?: string;
  all?: boolean;
  "max-pages"?: string;
  "page-delay"?: string;
  json?: boolean;
  fields?: string;
  preview?: boolean;
  // webhook verify flags
  secret?: string;
  header?: string;
  body?: string;
  "max-age-secs"?: string;
  "api-key"?: string;
  "base-url"?: string;
  timeout?: string;
  profile?: string;
};

type OutputStreams = {
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function rejectPreviewOnRead(preview: boolean | undefined, out: OutputStreams): void {
  if (preview) {
    out.stderr.write("error: --preview is only valid on write commands (mutations). Reads just run.\n");
    process.exit(2);
  }
}

function rejectAllOnNonPaginated(all: boolean | undefined, out: OutputStreams): void {
  if (all) {
    out.stderr.write("error: --all is not supported on non-paginated commands.\n");
    process.exit(2);
  }
}

function buildOutputStreams(): OutputStreams {
  return {
    stdout: { write: (s: string) => process.stdout.write(s) },
    stderr: { write: (s: string) => process.stderr.write(s) },
  };
}

function resolveOutputOpts(flags: WebhookFlags) {
  return {
    json: (flags.json ?? false) || !process.stdout.isTTY,
    isTTY: process.stdout.isTTY ?? false,
    fields: flags.fields,
  };
}

async function handleError(err: unknown, outOpts: ReturnType<typeof resolveOutputOpts>, out: OutputStreams): Promise<never> {
  const { CurviateError } = await import("@curviate/sdk");
  if (err instanceof CurviateError) {
    const { getExitCode } = await import("../lib/exit-codes.js");
    renderError(err as CurviateError, outOpts, out);
    process.exit(getExitCode(err.code));
  }
  renderUnexpectedError(err, out);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Exported run functions
// ---------------------------------------------------------------------------

/**
 * Run `webhook create <body…>`.
 * Required: --source, --request-url, --account-ids.
 * --account-ids is comma-separated and maps to account_ids[].
 */
export async function runWebhookCreate(
  client: Curviate,
  flags: WebhookFlags,
  out: OutputStreams,
): Promise<void> {
  if (!flags.source) {
    out.stderr.write("error: --source is required (messaging | user | account_status).\n");
    process.exit(2);
  }
  if (!flags["request-url"]) {
    out.stderr.write("error: --request-url is required (HTTPS URL for webhook deliveries).\n");
    process.exit(2);
  }
  if (!flags["account-ids"]) {
    out.stderr.write("error: --account-ids is required (comma-separated list of acc_… ids).\n");
    process.exit(2);
  }

  const accountIds = flags["account-ids"].split(",").map((s) => s.trim()).filter(Boolean);
  const body: Record<string, unknown> = {
    source: flags.source,
    request_url: flags["request-url"],
    account_ids: accountIds,
  };

  if (flags.name) body["name"] = flags.name;
  if (flags.format) body["format"] = flags.format;
  if (flags.enabled !== undefined) body["enabled"] = flags.enabled;
  if (flags.events) {
    body["events"] = flags.events.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (flags.data) {
    body["data"] = flags.data.split(",").map((s) => s.trim()).filter(Boolean);
  }

  const outOpts = resolveOutputOpts(flags);

  if (flags.preview) {
    const preview = buildPreviewOutput({ method: "webhooks.create", args: {}, body });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  try {
    // Narrow cast — see the WebhookCreateBody comment above.
    const result = await client.webhooks.create(body as WebhookCreateBody);
    renderSuccess(result, outOpts, out);
  } catch (err) {
    await handleError(err, outOpts, out);
  }
}

/**
 * Run `webhook list [--all] [--limit] [--cursor]`.
 */
export async function runWebhookList(
  client: Curviate,
  flags: WebhookFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const outOpts = resolveOutputOpts(flags);
  const all = flags.all ?? false;
  const maxPages = flags["max-pages"] ? parseInt(flags["max-pages"], 10) : 100;
  const limit = flags.limit ? parseInt(flags.limit, 10) : undefined;
  const cursor = flags.cursor;

  const params: Record<string, unknown> = {};
  if (limit !== undefined) params["limit"] = limit;
  if (cursor) params["cursor"] = cursor;

  try {
    if (all) {
      const fn = (p: Record<string, unknown>) =>
        client.webhooks.list(p) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(fn, params, {
        maxPages,
        out,
        pageDelayMs: pageDelayFromFlags(flags),
      })) {
        out.stdout.write(JSON.stringify(item) + "\n");
      }
    } else {
      const result = await client.webhooks.list(params);
      renderSuccess(result, outOpts, out);
    }
  } catch (err) {
    await handleError(err, outOpts, out);
  }
}

/**
 * Run `webhook events`. Non-paginated read.
 */
export async function runWebhookEvents(
  client: Curviate,
  flags: WebhookFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);
  rejectAllOnNonPaginated(flags.all, out);

  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await client.webhooks.listEvents();
    renderSuccess(result, outOpts, out);
  } catch (err) {
    await handleError(err, outOpts, out);
  }
}

/**
 * Run `webhook get <id>`. Read command; no --preview (nothing to mutate).
 */
export async function runWebhookGet(
  client: Curviate,
  flags: WebhookFlags,
  out: OutputStreams,
): Promise<void> {
  rejectPreviewOnRead(flags.preview, out);

  const id = flags.id ?? "";
  const outOpts = resolveOutputOpts(flags);

  try {
    const result = await client.webhooks.get(id);
    renderSuccess(result, outOpts, out);
  } catch (err) {
    await handleError(err, outOpts, out);
  }
}

/**
 * Run `webhook update <id> <body…>`.
 * --source is immutable — reject with exit 2 if provided.
 */
export async function runWebhookUpdate(
  client: Curviate,
  flags: WebhookFlags,
  out: OutputStreams,
): Promise<void> {
  if (flags.source !== undefined) {
    out.stderr.write("error: --source cannot be changed after creation (source is immutable).\n");
    process.exit(2);
  }

  const id = flags.id ?? "";
  const body: Record<string, unknown> = {};

  if (flags.name !== undefined) body["name"] = flags.name;
  if (flags["request-url"]) body["request_url"] = flags["request-url"];
  if (flags.enabled !== undefined) body["enabled"] = flags.enabled;
  if (flags.format) body["format"] = flags.format;
  if (flags.events) {
    body["events"] = flags.events.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (flags.data) {
    body["data"] = flags.data.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (flags["account-ids"]) {
    body["account_ids"] = flags["account-ids"].split(",").map((s) => s.trim()).filter(Boolean);
  }

  const outOpts = resolveOutputOpts(flags);

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "webhooks.update",
      args: { id },
      body,
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  try {
    const result = await client.webhooks.update(id, body);
    renderSuccess(result, outOpts, out);
  } catch (err) {
    await handleError(err, outOpts, out);
  }
}

/**
 * Run `webhook delete <id>`.
 */
export async function runWebhookDelete(
  client: Curviate,
  flags: WebhookFlags,
  out: OutputStreams,
): Promise<void> {
  const id = flags.id ?? "";
  const outOpts = resolveOutputOpts(flags);

  if (flags.preview) {
    const preview = buildPreviewOutput({
      method: "webhooks.delete",
      args: { id },
      body: {},
    });
    out.stdout.write(JSON.stringify(preview) + "\n");
    return;
  }

  try {
    const result = await client.webhooks.delete(id);
    renderSuccess(result, outOpts, out);
  } catch (err) {
    await handleError(err, outOpts, out);
  }
}

// ---------------------------------------------------------------------------
// Exported pure function for webhook verify (offline, no client)
// ---------------------------------------------------------------------------

export interface WebhookVerifyInput {
  secret: string;
  signatureHeader: string;
  rawBody: string;
  replayWindowSecs?: number;
}

/**
 * Strip newlines from the END of a captured body only. Internal newlines are
 * part of the signed bytes and are preserved.
 *
 * Every practical way of capturing a delivery appends one: a shell redirect,
 * `curl -o`, an editor save, a pipe. The bytes the platform signs come straight
 * out of `JSON.stringify`, which never ends in a newline, so a trailing newline
 * is always an artefact of the capture and never part of the body. Stripping it
 * cannot weaken the verdict either: if the HMAC matches after the strip, then
 * the stripped bytes are exactly what was signed.
 */
function stripTrailingNewlines(s: string): string {
  return s.replace(/(?:\r?\n)+$/, "");
}

/**
 * Resolve `--body` into the exact bytes to verify. Three forms are accepted:
 *
 *   - inline JSON: the raw body pasted straight onto the command line. A caller
 *     debugging a live delivery already holds the body as a string in the
 *     handler; making them write a temp file first is a pointless round trip on
 *     the one path this command exists for.
 *   - a file path: the raw body saved from the incoming request.
 *   - `-`: the raw body piped on stdin.
 *
 * Inline JSON and a path cannot be confused: a delivery body is always a JSON
 * object, so it starts with `{`, and no path names a file that starts with `{`.
 *
 * `-` arrives here as STDIN_SENTINEL, not as a dash. The dispatcher substitutes
 * the sentinel for a bare dash before citty parses argv (mri swallows a lone
 * dash), so both spellings must be recognised; treating the sentinel as a
 * filename is what made `--body -` fail.
 *
 * Anything unusable exits 2 (a usage error the caller can fix), never 1, and
 * never as a signature verdict: reporting bad input as a verification failure is
 * what sends someone off rotating a secret that was never wrong.
 */
export async function resolveWebhookBody(
  raw: string | undefined,
  out: OutputStreams,
  readStdin: () => Promise<string> = defaultReadStdin,
): Promise<string> {
  if (raw === undefined || raw === "") {
    out.stderr.write(
      "error: --body is required: pass the raw webhook body as inline JSON, as a path to a file containing it, or as - to read it from stdin.\n",
    );
    process.exit(2);
  }

  if (isStdinToken(raw)) {
    const piped = stripTrailingNewlines(await readStdin());
    if (!piped) {
      out.stderr.write("error: --body -: stdin: empty input\n");
      process.exit(2);
    }
    return piped;
  }

  if (raw.trimStart().startsWith("{")) return raw;

  try {
    return stripTrailingNewlines(readFileSync(raw, "utf8"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    out.stderr.write(
      `error: --body: could not read ${raw}: ${reason}\n` +
        "  --body accepts inline JSON, a path to a file containing the raw body, or - to read it from stdin.\n",
    );
    process.exit(2);
  }
}

/**
 * Run `webhook verify` — offline HMAC verification.
 *
 * Calls the SDK's `constructEvent` directly (no Curviate client constructed).
 * On success: prints parsed event JSON to stdout, returns (exit 0 semantics).
 * On WebhookSignatureError: prints structured error envelope to stdout, writes
 * summary to stderr, and calls process.exit(2).
 *
 * The secret is NEVER echoed or logged.
 */
export async function runWebhookVerify(
  input: WebhookVerifyInput,
  out: OutputStreams,
): Promise<void> {
  const { constructEvent, WebhookSignatureError } = await import("@curviate/sdk");

  try {
    const event = await constructEvent(
      input.rawBody,
      input.signatureHeader,
      input.secret,
      ...(input.replayWindowSecs !== undefined ? [{ replayWindowSecs: input.replayWindowSecs }] : []),
    );
    out.stdout.write(JSON.stringify(event) + "\n");
    // exit 0 — just return
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      const envelope = {
        error: {
          name: "WebhookSignatureError",
          reason: err.reason,
          message: err.message,
        },
      };
      out.stdout.write(JSON.stringify(envelope) + "\n");
      out.stderr.write(`error: webhook verification failed, ${err.reason}: ${err.message}\n`);
      process.exit(2);
    }
    // Unexpected error
    out.stderr.write(`error: unexpected error during webhook verification: ${String(err)}\n`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Citty command definitions
// ---------------------------------------------------------------------------

const webhookCreateCommand = defineCommand({
  meta: { name: "create", description: "Register a new webhook endpoint." },
  args: {
    ...GLOBAL_FLAGS,
    source: { type: "string", description: "Event source: messaging | user | account_status.", required: true },
    "request-url": { type: "string", description: "HTTPS URL to receive webhook deliveries.", required: true },
    "account-ids": { type: "string", description: "Comma-separated account ids to target (required).", required: true },
    name: { type: "string", description: "Human-readable name (1–100 chars)." },
    format: { type: "string", description: "Delivery encoding: json | form (default: json)." },
    enabled: { type: "boolean", description: "Create as enabled (default: true).", default: true },
    events: { type: "string", description: "Comma-separated event names to subscribe to." },
    data: { type: "string", description: "Comma-separated field-remapping keys." },
  },
  async run({ args }) {
    const flags = args as WebhookFlags;
    const cfg = await resolveEffectiveConfig({
      apiKey: flags["api-key"],
      baseUrl: flags["base-url"],
      timeout: flags.timeout,
      profile: flags.profile,
    });
    if (!cfg.apiKey) {
      process.stderr.write("error: no API key, run `curviate login` or pass --api-key.\n");
      process.exit(3);
    }
    const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeout: cfg.timeout });
    const out = buildOutputStreams();
    await runWebhookCreate(client, flags, out);
  },
});

const webhookListCommand = defineCommand({
  meta: { name: "list", description: "List registered webhooks." },
  args: { ...GLOBAL_FLAGS },
  async run({ args }) {
    const flags = args as WebhookFlags;
    const cfg = await resolveEffectiveConfig({
      apiKey: flags["api-key"],
      baseUrl: flags["base-url"],
      timeout: flags.timeout,
      profile: flags.profile,
    });
    if (!cfg.apiKey) {
      process.stderr.write("error: no API key, run `curviate login` or pass --api-key.\n");
      process.exit(3);
    }
    const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeout: cfg.timeout });
    const out = buildOutputStreams();
    await runWebhookList(client, flags, out);
  },
});

const webhookEventsCommand = defineCommand({
  meta: { name: "events", description: "List the canonical webhook event catalogue." },
  args: { ...GLOBAL_FLAGS },
  async run({ args }) {
    const flags = args as WebhookFlags;
    const cfg = await resolveEffectiveConfig({
      apiKey: flags["api-key"],
      baseUrl: flags["base-url"],
      timeout: flags.timeout,
      profile: flags.profile,
    });
    if (!cfg.apiKey) {
      process.stderr.write("error: no API key, run `curviate login` or pass --api-key.\n");
      process.exit(3);
    }
    const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeout: cfg.timeout });
    const out = buildOutputStreams();
    await runWebhookEvents(client, flags, out);
  },
});

const webhookGetCommand = defineCommand({
  meta: { name: "get", description: "Get a single webhook owned by the calling tenant." },
  args: {
    ...GLOBAL_FLAGS,
    id: { type: "positional", description: "Webhook id (wh_…)." },
  },
  async run({ args }) {
    const flags = args as WebhookFlags;
    const cfg = await resolveEffectiveConfig({
      apiKey: flags["api-key"],
      baseUrl: flags["base-url"],
      timeout: flags.timeout,
      profile: flags.profile,
    });
    if (!cfg.apiKey) {
      process.stderr.write("error: no API key, run `curviate login` or pass --api-key.\n");
      process.exit(3);
    }
    const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeout: cfg.timeout });
    const out = buildOutputStreams();
    await runWebhookGet(client, flags, out);
  },
});

const webhookUpdateCommand = defineCommand({
  meta: { name: "update", description: "Update a webhook in place (source is immutable)." },
  args: {
    ...GLOBAL_FLAGS,
    id: { type: "positional", description: "Webhook id (wh_…)." },
    "request-url": { type: "string", description: "Replace the delivery URL." },
    name: { type: "string", description: "Replace the name (or clear with empty string)." },
    enabled: { type: "boolean", description: "Enable or disable the webhook." },
    format: { type: "string", description: "Replace the delivery encoding: json | form." },
    events: { type: "string", description: "Replace subscribed events (comma-separated)." },
    data: { type: "string", description: "Replace field-remapping keys (comma-separated)." },
    "account-ids": { type: "string", description: "Replace targeted accounts (comma-separated)." },
  },
  async run({ args }) {
    const flags = args as WebhookFlags;
    const cfg = await resolveEffectiveConfig({
      apiKey: flags["api-key"],
      baseUrl: flags["base-url"],
      timeout: flags.timeout,
      profile: flags.profile,
    });
    if (!cfg.apiKey) {
      process.stderr.write("error: no API key, run `curviate login` or pass --api-key.\n");
      process.exit(3);
    }
    const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeout: cfg.timeout });
    const out = buildOutputStreams();
    await runWebhookUpdate(client, flags, out);
  },
});

const webhookDeleteCommand = defineCommand({
  meta: { name: "delete", description: "Permanently remove a webhook subscription." },
  args: {
    ...GLOBAL_FLAGS,
    id: { type: "positional", description: "Webhook id (wh_…)." },
  },
  async run({ args }) {
    const flags = args as WebhookFlags;
    const cfg = await resolveEffectiveConfig({
      apiKey: flags["api-key"],
      baseUrl: flags["base-url"],
      timeout: flags.timeout,
      profile: flags.profile,
    });
    if (!cfg.apiKey) {
      process.stderr.write("error: no API key, run `curviate login` or pass --api-key.\n");
      process.exit(3);
    }
    const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeout: cfg.timeout });
    const out = buildOutputStreams();
    await runWebhookDelete(client, flags, out);
  },
});

const webhookVerifyCommand = defineCommand({
  meta: { name: "verify", description: "Verify a webhook signature offline (no network call)." },
  args: {
    ...GLOBAL_FLAGS,
    secret: {
      type: "string",
      description: "The webhook signing secret from your webhook registration.",
      required: true,
    },
    header: {
      type: "string",
      description: "The full Curviate-Signature header value from the delivery (t=…,v1=…).",
      required: true,
    },
    body: {
      type: "string",
      description: "The raw webhook body: inline JSON, a path to a file containing it, or - to read it from stdin.",
      required: true,
    },
    "max-age-secs": {
      type: "string",
      description: "Maximum event age in seconds before rejecting as replay (default: 300).",
    },
  },
  async run({ args }) {
    const flags = args as WebhookFlags;
    const out = buildOutputStreams();

    const rawBody = await resolveWebhookBody(flags.body, out);

    const signatureHeader = flags.header ?? "";
    const secret = flags.secret ?? "";
    const replayWindowSecs = flags["max-age-secs"] ? parseInt(flags["max-age-secs"], 10) : undefined;

    await runWebhookVerify({ secret, signatureHeader, rawBody, replayWindowSecs }, out);
  },
});

export const webhookCommand = defineCommand({
  meta: { name: "webhook", description: "Webhook management and signature verification." },
  subCommands: {
    create: webhookCreateCommand,
    list: webhookListCommand,
    events: webhookEventsCommand,
    get: webhookGetCommand,
    update: webhookUpdateCommand,
    delete: webhookDeleteCommand,
    verify: webhookVerifyCommand,
  },
  async run() {
    process.stderr.write(
      "Usage: curviate webhook <subcommand>\n" +
      "  create | list | events | get | update | delete | verify\n",
    );
  },
});
