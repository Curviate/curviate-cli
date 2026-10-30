/**
 * `curviate billing`: the Team's invoices (Owners only). Root-scoped
 * (`curviate.billing.invoices.*`). Seats and the Tier have their own groups.
 */
import { defineCommand } from "citty";
import type { Curviate } from "@curviate/sdk";
import { DESCRIPTIONS } from "./descriptions.js";
import { GLOBAL_FLAGS, readOnly } from "../lib/global-flags.js";
import { renderSuccess, writeNdjsonItem } from "../lib/output.js";
import { streamAll, pageDelayFromFlags, readCursorFlag, readMaxPagesFlag, readablePage, rejectPaginationModifiersWithoutAll } from "../lib/paginate.js";
import { intFlag } from "../lib/int-flag.js";
import { downloadBinary } from "../lib/client.js";
import { writeAtomic } from "../lib/write-atomic.js";
import { fail, outputOpts, rootClient, usage, type RootFlags } from "../lib/root-command.js";

type Flags = RootFlags & { _?: string[]; number?: string; output?: string; limit?: string; cursor?: string; all?: boolean; "max-pages"?: string; "page-delay"?: string };

const online = (fn: (c: Curviate, f: Flags) => Promise<void>) => async ({ args }: { args: unknown }) => {
  const f = args as Flags;
  await fn(await rootClient(f), f);
};

async function runList(c: Curviate, f: Flags): Promise<void> {
  rejectPaginationModifiersWithoutAll(f, process);
  const params: Record<string, unknown> = {};
  if (f.limit !== undefined) params["limit"] = intFlag("limit", f.limit, 1, 100);
  const cursor = readCursorFlag(f, process);
  if (cursor) params["cursor"] = cursor;
  try {
    if (f.all) {
      const page = (p: Record<string, unknown>) => c.billing.invoices.list(p as never) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(page, params, { maxPages: readMaxPagesFlag(f, process), out: process, pageDelayMs: pageDelayFromFlags(f) })) writeNdjsonItem(process, item, f.fields);
    } else {
      renderSuccess(readablePage(await c.billing.invoices.list(params as never)), outputOpts(f), process);
    }
  } catch (err) {
    await fail(err, f);
  }
}

async function runPdf(c: Curviate, f: Flags): Promise<void> {
  const number = String(f.number ?? "");
  if (number.trim() === "") usage("the invoice number is empty. Take it from `curviate billing invoices`.");
  if (f.output === undefined || f.output.trim() === "") usage("-o <file> is required: the PDF is written there, or to stdout with -o - when stdout is not a terminal.");
  if (f.output === "-" && process.stdout.isTTY) usage("-o - would write a PDF to the terminal. Pass a file name.");
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await downloadBinary(() => c.billing.invoices.pdf(number)));
  } catch (err) {
    return fail(err, f);
  }
  if (f.output === "-") process.stdout.write(bytes);
  else {
    try {
      writeAtomic(f.output, bytes);
    } catch (err) {
      usage(`-o: cannot write ${f.output}: ${(err as NodeJS.ErrnoException).code ?? "write error"}.`);
    }
  }
  process.stderr.write(`Invoice ${number}: ${bytes.length} bytes${f.output === "-" ? "" : ` written to ${f.output}`}.\n`);
}

const pdfCmd = defineCommand({
  meta: {
    name: "pdf",
    description: "Download one invoice as a PDF, by its number from `curviate billing invoices`. Owners only. The file is written whole or not at all.",
    risk: "read",
    output: ["The PDF bytes, to -o <file> (replaced whole on success) or, with -o -, to stdout; a byte count on stderr."],
    examples: ["curviate billing invoices pdf INV-0001 -o invoice.pdf"],
  },
  args: {
    "api-key": GLOBAL_FLAGS["api-key"],
    profile: GLOBAL_FLAGS.profile,
    team: GLOBAL_FLAGS.team,
    "base-url": GLOBAL_FLAGS["base-url"],
    timeout: GLOBAL_FLAGS.timeout,
    number: { type: "positional", description: "The invoice number, from the invoice list." },
    output: { type: "string", alias: "o", required: true, description: "Write the PDF to this path, or - for stdout." },
  },
  run: online(runPdf),
});

const invoicesCmd = defineCommand({
  meta: {
    name: "invoices",
    description: "List your Team's issued invoices, newest first: number, amount (in the currency's smallest unit), status and service period. No links: download a PDF by its number. Owners only.",
    risk: "read",
    output: ["`items` (number, created_at, period_start, period_end, total, currency, status) and a `cursor`; with --all, one invoice per line."],
    examples: ["curviate billing invoices", "curviate billing invoices --json --limit 12"],
  },
  args: { ...readOnly(GLOBAL_FLAGS) },
  subCommands: { pdf: pdfCmd },
  run: online(runList),
});

export const billingCommand = defineCommand({
  meta: { name: "billing", description: DESCRIPTIONS.billing },
  subCommands: { invoices: invoicesCmd },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(billingCommand, ["curviate", "billing"]);
  },
});

