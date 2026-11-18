/**
 * `curviate billing`: the price of seats, the spending cap, the change log and
 * the Team's invoices (Owners only). Root-scoped (`curviate.billing.*`). Seats
 * and the Tier have their own groups. One write: `price move`, which charges
 * money and asks first.
 */
import { defineCommand } from "citty";
import type { Curviate } from "@curviate/sdk";
import { DESCRIPTIONS } from "./descriptions.js";
import { GLOBAL_FLAGS, READ_SINGLE_FLAGS, WRITE_SINGLE_FLAGS, readOnly } from "../lib/global-flags.js";
import { buildPreviewOutput } from "../lib/preview.js";
import { renderSuccess, writeNdjsonItem } from "../lib/output.js";
import { streamAll, pageDelayFromFlags, readCursorFlag, readMaxPagesFlag, readablePage, rejectPaginationModifiersWithoutAll } from "../lib/paginate.js";
import { intFlag } from "../lib/int-flag.js";
import { downloadBinary } from "../lib/client.js";
import { writeAtomic } from "../lib/write-atomic.js";
import { fail, outputOpts, rootClient, usage, type RootFlags } from "../lib/root-command.js";

type Flags = RootFlags & { _?: string[]; number?: string; output?: string; limit?: string; cursor?: string; all?: boolean; "max-pages"?: string; "page-delay"?: string; seats?: string; period?: string; yes?: boolean };

const online = (fn: (c: Curviate, f: Flags) => Promise<void>) => async ({ args }: { args: unknown }) => {
  const f = args as Flags;
  await fn(await rootClient(f), f);
};

async function runQuote(c: Curviate, f: Flags): Promise<void> {
  const seats = intFlag("seats", f.seats ?? usage("--seats is required: how many seats to price, 1 or more."), 1);
  const period = f.period ?? "monthly";
  if (period !== "monthly" && period !== "annual") usage("--period takes monthly or annual.");
  try {
    renderSuccess(await c.billing.quote({ seats: String(seats), period } as never), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

async function runCap(c: Curviate, f: Flags): Promise<void> {
  try {
    renderSuccess(await c.billing.spendingCap(), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

async function runChanges(c: Curviate, f: Flags): Promise<void> {
  rejectPaginationModifiersWithoutAll(f, process);
  const params: Record<string, unknown> = {};
  if (f.limit !== undefined) params["limit"] = intFlag("limit", f.limit, 1, 100);
  const cursor = readCursorFlag(f, process);
  if (cursor) params["cursor"] = cursor;
  try {
    if (f.all) {
      const page = (p: Record<string, unknown>) => c.billing.changes(p as never) as Promise<{ items?: unknown[]; cursor?: string | null }>;
      for await (const item of streamAll(page, params, { maxPages: readMaxPagesFlag(f, process), out: process, pageDelayMs: pageDelayFromFlags(f) })) writeNdjsonItem(process, item, f.fields);
    } else {
      renderSuccess(readablePage(await c.billing.changes(params as never)), outputOpts(f), process);
    }
  } catch (err) {
    await fail(err, f);
  }
}

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

/** Money: a person says yes at a terminal; anything else must pass --yes, or nothing is sent. */
async function confirmMoney(f: Flags, question: string): Promise<boolean> {
  if (f.yes) return true;
  if (!process.stdin.isTTY) usage("this charges money: pass --yes to confirm (no terminal to ask at). Read the price first with `curviate billing quote`.");
  process.stderr.write(`${question} [y/N] `);
  const answer = await new Promise<string>((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (chunk: string) => resolve(chunk.trim().toLowerCase()));
  });
  process.stdin.pause();
  if (answer === "y" || answer === "yes") return true;
  process.stderr.write("Aborted: nothing was charged.\n");
  return false;
}

async function runMove(f: Flags): Promise<void> {
  if (f.preview) return void process.stdout.write(JSON.stringify(buildPreviewOutput({ method: "billing.moveToCurrentPrice", args: {}, body: {} })) + "\n");
  const c = await rootClient(f);
  if (!(await confirmMoney(f, "Move your subscription to the current price now? The unused time is credited and the current price charged for the rest of the period (yearly: today)."))) return;
  try {
    renderSuccess(await c.billing.moveToCurrentPrice(), outputOpts(f), process);
  } catch (err) {
    await fail(err, f);
  }
}

const moveCmd = defineCommand({
  meta: {
    name: "move",
    description:
      "Move a subscription on a previous price (Build, Automate or Seat) to the current price now, same seats and billing period. This charges money: the unused time on the previous price is credited " +
      "and the current price charged for the rest of the period, monthly on the next invoice, yearly today. Asks first at a terminal; elsewhere pass --yes. A Team already on the current price is refused and nothing is charged. Owners only.",
    risk: "high",
    rules: {
      changes: "The subscription's price; a yearly move charges the difference today.",
      visible_to: "Your Team's Owners, on the invoice.",
      budget_rows: [],
      retry: "A second call is refused (already on the current price); nothing is charged twice.",
      undo: "None: there is no move back to a previous price.",
      blast_radius: "The Team's whole subscription.",
    },
    errors: { INVALID_REQUEST: "already on the current price, no subscription, or a previous price that cannot be moved in place; nothing was charged.", INSUFFICIENT_ROLE: "only an Owner moves the price." },
    output: ["`moved`, `period`, `seats` and `charged_today` (cents, tax included; 0 for a monthly move)."],
    seeAlso: ["curviate billing quote", "curviate tier"],
    examples: ["curviate billing price move", "curviate billing price move --yes --json"],
  },
  args: { ...WRITE_SINGLE_FLAGS, yes: { type: "boolean", description: "Confirm the charge without a prompt (needed when no terminal can ask)." } },
  run: async ({ args }) => runMove(args as Flags),
});

const priceCmd = defineCommand({
  meta: { name: "price", description: "Your subscription's price: move one on a previous price to the current price." },
  subCommands: { move: moveCmd },
});

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

const quoteCmd = defineCommand({
  meta: {
    name: "quote",
    description:
      "Price a number of seats for one period, step by step: each seat costs the price of the step it falls in, so adding a seat never changes what the earlier ones cost. " +
      "Amounts in cents. Computed from the price list; charges nothing. Owners only.",
    risk: "read",
    output: ["`total` and `steps[]` (from, up_to, unit_amount, seats, amount), in cents, with `currency` and `period`."],
    examples: ["curviate billing quote --seats 25", "curviate billing quote --seats 25 --period annual"],
  },
  args: {
    ...readOnly(READ_SINGLE_FLAGS),
    seats: { type: "string", required: true, description: "How many seats to price, 1 or more." },
    period: { type: "string", description: "monthly (default) or annual." },
  },
  run: online(runQuote),
});

const capCmd = defineCommand({
  meta: {
    name: "cap",
    description:
      "The spending cap: the most seats an agent may bring your Team to (100 until an Owner sets one), the seats now, the room left and what the cap's seats cost a month. " +
      "Read only: an Owner changes it in the dashboard. Adding a seat past it is refused with SPENDING_CAP_REACHED. Owners only.",
    risk: "read",
    output: ["`cap_seats`, `is_default`, `seats`, `room_seats`, `monthly_amount` (cents), `currency`."],
    examples: ["curviate billing cap"],
  },
  args: { ...readOnly(READ_SINGLE_FLAGS) },
  run: online(runCap),
});

const changesCmd = defineCommand({
  meta: {
    name: "changes",
    description:
      "Every seat added or removed and every spending cap change on your Team, newest first: who made it (a person or an API key), the way it came in, the seat counts before and after and what it adds to the monthly price. Owners only.",
    risk: "read",
    output: ["`items` and a `cursor`; with --all, one change per line."],
    examples: ["curviate billing changes", "curviate billing changes --all"],
  },
  args: { ...readOnly(GLOBAL_FLAGS) },
  run: online(runChanges),
});

export const billingCommand = defineCommand({
  meta: { name: "billing", description: DESCRIPTIONS.billing },
  subCommands: { quote: quoteCmd, cap: capCmd, changes: changesCmd, invoices: invoicesCmd, price: priceCmd },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(billingCommand, ["curviate", "billing"]);
  },
});

