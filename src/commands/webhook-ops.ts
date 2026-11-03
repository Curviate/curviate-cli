/**
 * The webhook leaves added with body templates, deliveries and rotation:
 * `lint` (offline), `variables`, `deliveries`, `redeliver`, `rotate`, `test`,
 * plus the create/update fields they share (`--template-file`,
 * `--custom-events`, `--header`). Mounted on `curviate webhook`.
 */
import { defineCommand } from "citty";
import type { Curviate } from "@curviate/sdk";
import { GLOBAL_FLAGS, READ_SINGLE_FLAGS, WRITE_SINGLE_FLAGS, readOnly } from "../lib/global-flags.js";
import { renderSuccess, writeNdjsonItem } from "../lib/output.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { streamAll, pageDelayFromFlags, readCursorFlag, readMaxPagesFlag, readablePage, rejectPaginationModifiersWithoutAll } from "../lib/paginate.js";
import { intFlag } from "../lib/int-flag.js";
import { readFileFlag } from "../lib/document.js";
import { isStdinToken } from "../lib/stdin.js";
import { fail, listFlag, outputOpts, rootClient, usage, type RootFlags } from "../lib/root-command.js";

type Flags = RootFlags & {
  id?: string;
  deliveryId?: string;
  source?: string;
  event?: string;
  failed?: boolean;
  "template-file"?: string;
  "custom-events"?: string;
  header?: string | string[];
  limit?: string;
  cursor?: string;
  all?: boolean;
  "max-pages"?: string;
  "page-delay"?: string;
};
type Row = Record<string, unknown>;

const SOURCES = ["messaging", "user", "account_status", "post", "motion"];

/** `--template-file`, `--custom-events`, `--header KEY[:VALUE]` as body fields; `--header KEY` alone keeps the stored value. */
export async function deliveryFields(f: Flags): Promise<Row> {
  const body: Row = {};
  if (f["template-file"] !== undefined) body["body_template"] = await readFileFlag("template-file", f["template-file"], { others: f });
  if (f["custom-events"] !== undefined) body["custom_event_names"] = listFlag("custom-events", f["custom-events"]);
  if (f.header !== undefined) {
    body["headers"] = ([] as string[]).concat(f.header).map((h) => {
      const i = h.indexOf(":");
      const key = (i < 0 ? h : h.slice(0, i)).trim();
      if (key === "") usage("--header takes KEY:VALUE, or KEY alone to keep its stored value.");
      return i < 0 ? { key } : { key, value: h.slice(i + 1).trim() };
    });
  }
  return body;
}

/** The create/update flags for those fields. */
export const DELIVERY_ARGS = {
  "template-file": {
    type: "string" as const,
    stdinArg: true,
    description: "The delivery body as a JSON text with {{variables}} (`curviate webhook variables --source <source>`), from a path or - for stdin. Lint it offline first: `curviate webhook lint`.",
  },
  "custom-events": { type: "string" as const, description: "With motion.custom_event subscribed: deliver only these custom event names (comma list). Omit for every custom event." },
  header: {
    type: "string" as const,
    description: "A custom header on every delivery, KEY:VALUE; repeatable, replaces the whole set. KEY alone keeps that header's stored value (values are never read back). Not covered by the signature.",
  },
};

async function runLint(f: Flags): Promise<void> {
  const source = f.source ?? "motion";
  if (!SOURCES.includes(source)) usage(`--source takes ${SOURCES.join(", ")}.`);
  if (f["template-file"] === undefined) usage("--template-file is required: a path, or - for stdin.");
  const text = await readFileFlag("template-file", f["template-file"], { others: f });
  const { validateWebhookTemplate } = await import("@curviate/sdk");
  const { errors } = validateWebhookTemplate(text, { source: source as never }) as unknown as { errors: Array<Row> };
  const file = isStdinToken(f["template-file"]) ? "-" : f["template-file"];
  for (const e of errors) process.stderr.write(`${file}:${e["line"]}:${e["col"]} error ${e["code"]}: ${e["rule"]}. ${e["hint"]} -> ${e["docs_url"]}\n`);
  const json = outputOpts(f).json;
  if (errors.length) {
    if (json) process.stdout.write(JSON.stringify({ error: { code: "WEBHOOK_TEMPLATE_INVALID", message: `The template has ${errors.length} error(s).`, errors } }) + "\n");
    process.exit(2);
  }
  if (json) process.stdout.write(JSON.stringify({ errors: [] }) + "\n");
  else process.stderr.write("The template passes the lint.\n");
}

async function runVariables(c: Curviate, f: Flags): Promise<void> {
  if (!f.source || !SOURCES.includes(f.source)) usage(`--source is required: one of ${SOURCES.join(", ")}.`);
  try {
    renderSuccess(await c.webhooks.variables({ source: f.source } as never), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

async function runDeliveries(c: Curviate, f: Flags): Promise<void> {
  const id = String(f.id ?? "");
  try {
    if (f.deliveryId !== undefined) return renderSuccess(await c.webhooks.deliveries.get(id, f.deliveryId), outputOpts(f), process);
    rejectPaginationModifiersWithoutAll(f, process);
    const q: Row = {};
    if (f.failed) q["failed"] = true;
    if (f.limit !== undefined) q["limit"] = intFlag("limit", f.limit, 1, 100);
    const cursor = readCursorFlag(f, process);
    if (cursor) q["cursor"] = cursor;
    if (f.all) {
      const page = (p: Row) => c.webhooks.deliveries.list(id, p as never) as unknown as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(page, q, { maxPages: readMaxPagesFlag(f, process), out: process, pageDelayMs: pageDelayFromFlags(f) })) writeNdjsonItem(process, item, f.fields);
      return;
    }
    renderSuccess(readablePage(await c.webhooks.deliveries.list(id, q as never)), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

/** redeliver, rotate, test: one write on one webhook. */
const write = (method: string, call: (c: Curviate, f: Flags) => Promise<unknown>, args: (f: Flags) => Row, body: (f: Flags) => Row = () => ({})) =>
  async (c: Curviate, f: Flags): Promise<void> => {
    if (f.preview) return void process.stdout.write(JSON.stringify(buildPreviewOutput({ method, args: args(f), body: body(f) })) + "\n");
    try {
      renderSuccess(await call(c, f), outputOpts(f), process);
    } catch (err) {
      await fail(err, f);
    }
  };

const online = (fn: (c: Curviate, f: Flags) => Promise<void>) => async ({ args }: { args: unknown }) => {
  const f = args as Flags;
  await fn(await rootClient(f), f);
};

const ID = { type: "positional" as const, description: "Webhook id (wh_...)." };
const CREATOR = { INSUFFICIENT_ROLE: "only the webhook's creator can do this." };

export const webhookLintCommand = defineCommand({
  meta: {
    name: "lint",
    description: "Check a webhook body template offline, every finding at once, as `curviate webhook create` would answer it. Offline: no API call.",
    risk: "read",
    rules: { notes: ["Offline: no API call."] },
    output: ["Findings on stderr, one per line: <file>:<line>:<col> error <code>: <rule>. <hint> -> <docs_url>. With --json (or piped) stdout carries the WEBHOOK_TEMPLATE_INVALID shape, or {\"errors\": []}. Exit 2 on any finding."],
    examples: ["curviate webhook lint --template-file body.json --source motion"],
  },
  args: {
    json: GLOBAL_FLAGS.json,
    "template-file": { ...DELIVERY_ARGS["template-file"], description: "The template, from a path or - for stdin." },
    source: { type: "string" as const, description: `The webhook's source, which decides the variables: ${SOURCES.join(", ")} (default motion).` },
  },
  run: async ({ args }) => runLint(args as Flags),
});

export const webhookVariablesCommand = defineCommand({
  meta: {
    name: "variables",
    description: "The {{variables}} a body template may use for a source, with their types and an example.",
    risk: "read",
    examples: ["curviate webhook variables --source motion"],
  },
  args: { ...readOnly(READ_SINGLE_FLAGS), source: { type: "string" as const, description: `${SOURCES.join(", ")}.` } },
  run: online(runVariables),
});

export const webhookDeliveriesCommand = defineCommand({
  meta: {
    name: "deliveries",
    description: "A webhook's deliveries, newest first: status, attempts, the response code and the next retry. With a delivery id: that one delivery.",
    risk: "read",
    examples: ["curviate webhook deliveries wh_YOUR_WEBHOOK_ID --failed", "curviate webhook deliveries wh_YOUR_WEBHOOK_ID YOUR_DELIVERY_ID"],
  },
  args: {
    ...readOnly(GLOBAL_FLAGS),
    id: ID,
    deliveryId: { type: "positional" as const, required: false, description: "One delivery's id, to read it alone." },
    failed: { type: "boolean" as const, description: "Only deliveries that failed." },
  },
  run: online(runDeliveries),
});

export const webhookRedeliverCommand = defineCommand({
  meta: {
    name: "redeliver",
    description: "Send one past delivery again, with the body it was rendered with and a fresh signature.",
    risk: "write",
    rules: {
      changes: "Posts the delivery to the webhook's URL again.",
      visible_to: "Your endpoint.",
      budget_rows: [],
      retry: "Each call posts again: your endpoint may record it twice.",
      undo: "Cannot be undone.",
    },
    errors: { DELIVERY_IN_FLIGHT: "the delivery is being sent right now; read it again shortly.", REDELIVERY_EXPIRED: "the delivery is too old to send again." },
    examples: ["curviate webhook redeliver wh_YOUR_WEBHOOK_ID YOUR_DELIVERY_ID"],
  },
  args: { ...WRITE_SINGLE_FLAGS, id: ID, deliveryId: { type: "positional" as const, description: "The delivery id, from `curviate webhook deliveries`." } },
  run: online(write("webhooks.redeliver", (c, f) => c.webhooks.redeliver(String(f.id ?? ""), String(f.deliveryId ?? "")), (f) => ({ id: f.id, delivery_id: f.deliveryId }))),
});

export const webhookRotateCommand = defineCommand({
  meta: {
    name: "rotate",
    description:
      "Issue a new signing secret, printed once. For a grace period every delivery carries both signatures (`v1=<new>,v1=<old>`), so a receiver on either secret keeps verifying; switch yours to the new one inside that period.",
    risk: "high",
    rules: {
      changes: "A new signing secret; the old one stops signing when the grace period ends (at once on a second rotation inside it).",
      visible_to: "Your endpoint, which must verify with the new secret before the grace period ends.",
      budget_rows: [],
      retry: "A second rotation drops the oldest secret at once.",
      undo: "Cannot be undone: rotate again for another new secret.",
      blast_radius: "One webhook's deliveries.",
    },
    errors: CREATOR,
    seeAlso: ["curviate webhook verify"],
    examples: ["curviate webhook rotate wh_YOUR_WEBHOOK_ID"],
  },
  args: { ...WRITE_SINGLE_FLAGS, id: ID },
  run: online(write("webhooks.rotateSecret", (c, f) => c.webhooks.rotateSecret(String(f.id ?? "")), (f) => ({ id: f.id }))),
});

export const webhookTestCommand = defineCommand({
  meta: {
    name: "test",
    description: "Send a sample delivery of one event to the webhook's URL now, rendered through its template and signed like a real one (`data.test_event: true`).",
    risk: "write",
    rules: {
      changes: "Posts one sample delivery to the webhook's URL.",
      visible_to: "Your endpoint.",
      budget_rows: [],
      retry: "Each call sends another sample.",
      undo: "Cannot be undone.",
    },
    errors: { RESOURCE_NOT_FOUND: "no webhook with this id." },
    examples: ["curviate webhook test wh_YOUR_WEBHOOK_ID", "curviate webhook test wh_YOUR_WEBHOOK_ID --event enrollment.finished"],
  },
  args: { ...WRITE_SINGLE_FLAGS, id: ID, event: { type: "string" as const, description: "The event to sample (default: the first one subscribed)." } },
  run: online(write("webhooks.test", (c, f) => c.webhooks.test(String(f.id ?? ""), f.event === undefined ? {} : { event: f.event } as never), (f) => ({ id: f.id }), (f) => (f.event === undefined ? {} : { event: f.event }))),
});
