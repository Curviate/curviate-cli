/**
 * Search pacing as the user meets it: an agent refused inside the random pause, an `--all` walk that waits it out or
 * stops with the cursor to resume, an owner raising a search budget, an owner asking above the maximum. Each row: the
 * requests sent, the exit, and what stderr says.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CurviateError } from "@curviate/sdk";
import { renderError } from "../../src/lib/output.js";
import { lines, wire, type Answer } from "../helpers/wire.js";
import { importStatusLine, whenText } from "../../src/commands/contact-import.js";

const refusal = (budget: string, retry_after: number, parameter: string) => ({
  status: 429,
  body: { code: "BUDGET_EXHAUSTED", message: `refused: ${budget}`, user_fixable: true, retry_likely_to_succeed: false, row: "search", budget, retry_after, reset_at: "2026-11-20T10:00:40.000Z", reason: "ceiling", blocked: true, hint: { parameter, message: "server sentence" } },
});
const person = (n: number) => ({ id: `p${n}`, full_name: `P ${n}` });
const page = (items: unknown[], cursor: string | null): Answer => ({ body: { object: "people_search_result", items, cursor } });
const budget = (used: number, value: number, def: number, max: number, source = "default", saved: number | null = null) => ({ value, effective: value, default: def, maximum: max, used, source, saved });
const policy = (hour: ReturnType<typeof budget>) => ({
  object: "safety_policy", account_id: "acc_a",
  search_pacing: {
    plan: "classic_business", pages_per_day: budget(12, 20, 20, 100), pages_per_hour: hour, pages_per_month: budget(140, 400, 400, 1000),
    lines_per_day: { effective: 200, used: 120 }, min_gap_seconds: 10, max_gap_seconds: 45, month_resets_at: "2026-12-01T08:00:00.000Z", next_page_at: null, stopped: null, why: "w",
  },
});

describe("an agent searching", () => {
  it.each([
    ["gap", 40, "none", "Search budget: the random pause between two search pages of this Account (not a setting)", "Retry in 40 s (2026-11-20T10:00:40.000Z)"],
    ["hour", 1800, "search_pacing.pages_per_hour", "Search budget: search pages in the last hour", "--search-pages-per-hour N"],
    ["month", 86400, "search_pacing.pages_per_month", "Search budget: search pages this LinkedIn month", "--search-pages-per-month N"],
    ["warm_up", 86400, "none", "Search budget: warm-up holds this Account's search at 0 pages for now", "Retry in 86400 s"],
  ])("a %s refusal, read by a person at a terminal, says the wait in words", (b, s, parameter, a, c) => {
    const body = refusal(b, s, parameter).body;
    const err = new CurviateError({ code: "BUDGET_EXHAUSTED", message: body.message, httpStatus: 429, userFixable: true, retryLikelyToSucceed: false, budgetRow: "search", searchBudget: b, retryAfterSeconds: s, resetAt: body.reset_at, safetyReason: "ceiling", safetyHint: body.hint, blocked: true });
    let err2 = "";
    renderError(err, { json: false, isTTY: true }, { stdout: { write: () => {} }, stderr: { write: (x: string) => void (err2 += x) } } as never);
    expect(err2).toContain(a);
    expect(err2).toContain(c);
    expect(err2.includes("Change: none")).toBe(false);
  });

  it("a refusal exits 13 after one request; the envelope keeps the budget and the seconds", async () => {
    const r = await wire(["core", "search", "people", "--keywords", "cfo", "--account", "acc_a", "--json"], () => refusal("gap", 40, "none"));
    expect([r.status, r.sent.length]).toEqual([13, 1]);
    expect(JSON.parse(r.stdout).error).toMatchObject({ code: "BUDGET_EXHAUSTED", budgetRow: "search", searchBudget: "gap", retryAfterSeconds: 40 });
  });

  it("a row halted by LinkedIn server errors exits 7, not as a rate limit", async () => {
    const r = await wire(["core", "search", "people", "--keywords", "cfo", "--account", "acc_a", "--json"], () => ({ status: 502, body: { code: "PLATFORM_ERROR", message: "paused", user_fixable: false, retry_likely_to_succeed: true, row: "search", retry_after: 60 } }));
    expect([r.status, r.sent.length]).toEqual([7, 1]);
    expect(JSON.parse(r.stdout).error).toMatchObject({ code: "PLATFORM_ERROR", budgetRow: "search", retryAfterSeconds: 60 });
    let err2 = "";
    renderError(new CurviateError({ code: "PLATFORM_ERROR", message: "paused", httpStatus: 502, userFixable: false, retryLikelyToSucceed: true, budgetRow: "search", retryAfterSeconds: 60 }), { json: false, isTTY: true }, { stdout: { write: () => {} }, stderr: { write: (x: string) => void (err2 += x) } } as never);
    expect(err2).toContain("Paused budget row: search for 60s, after LinkedIn server errors");
  });

  it("--all waits out a gap refusal and asks for the same page again", async () => {
    const r = await wire(["core", "search", "people", "--keywords", "cfo", "--account", "acc_a", "--all", "--page-delay", "0"], (req, n) =>
      n === 0 ? page([person(1)], "c1") : n === 1 ? refusal("gap", 1, "none") : page([person(2)], null));
    expect([r.status, r.sent.map((s) => s.query["cursor"] ?? null)]).toEqual([0, [null, "c1", "c1"]]);
    expect(r.stdout.trim().split("\n").map((l) => JSON.parse(l).id)).toEqual(["p1", "p2"]);
    expect(r.stderr).toContain("Search pause: the next page in 1 s.");
  });

  it("--all stops on an hour refusal with the cursor to resume", async () => {
    const r = await wire(["core", "search", "people", "--keywords", "cfo", "--account", "acc_a", "--all", "--page-delay", "0"], (req, n) =>
      n === 0 ? page([person(1)], "c1") : refusal("hour", 1800, "search_pacing.pages_per_hour"));
    expect([r.status, r.sent.length]).toEqual([13, 2]);
    expect(r.stderr).toContain("Stopped after 1 page(s). Resume later with --cursor c1");
  });

  it("--limit help says one LinkedIn page a call", async () => {
    const r = await wire(["core", "search", "people", "--help"]);
    expect(r.stdout).toContain("at most one LinkedIn page");
    expect(r.stdout).toContain("Search is paced per Account");
  });
});

describe("an owner setting the search budgets", () => {
  const dir = mkdtempSync(join(tmpdir(), "sp-"));
  const doc = join(dir, "p.json");
  writeFileSync(doc, JSON.stringify({ search_pacing: { pages_per_day: 30 }, activity_level: "normal" }));
  it.each([
    [["--search-pages-per-hour", "12"], { search_pacing: { pages_per_hour: 12 } }],
    [["--search-pages-per-day", "default"], { search_pacing: { pages_per_day: null } }],
    [["--file", doc, "--search-pages-per-hour", "12"], { search_pacing: { pages_per_day: 30, pages_per_hour: 12 }, activity_level: "normal" }],
  ])("%j sends one PATCH", async (flags, body) => {
    const r = await wire(["account", "safety", "update", "acc_a", ...flags], () => ({ body: policy(budget(3, 12, 8, 100, "account")) }));
    expect([r.status, lines(r.sent)]).toEqual([0, [{ call: "PATCH /v1/acc_a/safety-policy", query: {}, body }]]);
    expect(r.stderr).toContain("Search pages (Premium Business search):");
    expect(r.stderr).toContain("Last hour: 3 of 12 (default 8, at most 100, set to 12; --search-pages-per-hour)");
  });

  it("get prints the use against each limit and the month's turn", async () => {
    const r = await wire(["account", "safety", "get", "acc_a"], () => ({ body: policy(budget(3, 100, 8, 100, "maximum", 150)) }));
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("Last 24 hours: 12 of 20 (default 20, at most 100; --search-pages-per-day)");
    expect(r.stderr).toContain("This LinkedIn month: 140 of 400 (default 400, at most 1000; --search-pages-per-month)");
    expect(r.stderr).toContain("Saved as 150, above what this Account allows now, so 100 applies.");
    expect(r.stderr).toContain("LinkedIn's month starts again 2026-12-01T08:00:00.000Z.");
  });

  it("above the maximum: the API's 400 exits 2 and names the maximum", async () => {
    const msg = "Search pages an hour can be at most 100 on this Account (search_pacing.pages_per_hour). Send 100 or less.";
    const r = await wire(["account", "safety", "update", "acc_a", "--search-pages-per-hour", "101"], () => ({ status: 400, body: { code: "INVALID_REQUEST", message: msg, user_fixable: true, retry_likely_to_succeed: false } }));
    expect([r.status, r.sent.length]).toEqual([2, 1]);
    expect(r.stderr).toContain(msg);
  });

  it.each([
    [["acc_a", "--search-pages-per-hour", "0"]],
    [["acc_a", "--search-pages-per-day", "ten"]],
    [["--team", "--search-pages-per-day", "10"]],
  ])("%j exits 2 with no request", async (args) => {
    const r = await wire(["account", "safety", "update", ...args]);
    expect([r.status, r.sent.length]).toEqual([2, 0]);
  });
});

describe("an import from a LinkedIn source says its wait, the next page and how long is left, in the dashboard's words", () => {
  const NOW = Date.parse("2026-11-20T10:00:00.000Z");
  const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
  const src = (o: Record<string, unknown>) => ({ object: "lead_import", id: "imp_1", format: "source", status: "running", waiting: null, next_page_at: null, estimate: null, counts: { found: 40 }, ...o });
  const est = (a: number, b: number) => ({ seconds_min: a, seconds_max: b, working_days_min: 1, working_days_max: 1 });
  it.each([
    [{ next_page_at: at(2), estimate: est(480, 640) }, "Next page in 2 minutes. About 8 to 11 minutes left"],
    [{ next_page_at: at(0.5), estimate: est(30, 50) }, "Next page in under a minute. Less than a minute left"],
    [{ waiting: { kind: "budget", budget: "hour", until: at(40) }, next_page_at: at(40), estimate: est(7200, 7200) }, "Hourly search limit reached. Next page in 40 minutes. About 2 hours left"],
    [{ waiting: { kind: "budget", budget: "day", until: at(60) }, next_page_at: at(60) }, "Daily search limit reached. Next page in 60 minutes"],
    [{ waiting: { kind: "budget", budget: "lines" }, next_page_at: at(30) }, "Daily search limit reached. Next page in 30 minutes"],
    [{ waiting: { kind: "budget", budget: "month" }, estimate: est(5 * 86_400, 12 * 86_400) }, "Monthly search limit reached. About 5 to 12 days left"],
    [{ waiting: { kind: "budget", budget: "warm_up" }, next_page_at: at(60) }, "Warm-up holds this Account's search at 0 pages for now. Next page in 60 minutes"],
    [{ waiting: { kind: "active_hours" }, next_page_at: at(20), estimate: est(3600 * 20, 3600 * 30) }, "Outside the Account's Active hours. Next page in 20 minutes. About 20 to 30 hours left"],
    [{ waiting: { kind: "pushback" }, next_page_at: at(10) }, "Paused: LinkedIn slowed this search down. Next page in 10 minutes"],
    [{ waiting: { kind: "search_limited", until: at(5) } }, "LinkedIn shows this Account only a few search results for now. Resumes when that lifts, at the latest in 5 minutes"],
    [{ waiting: { kind: "halt", until: at(15) } }, "Held by a safety pause. Resumes in 15 minutes"],
    [{ waiting: { kind: "account_unavailable", until: null } }, "Resumes once the Account is reconnected"],
    [{ status: "queued", waiting: { kind: "import_ahead", import_id: "imp_0", until: at(3) }, next_page_at: at(3), estimate: est(600, 900) }, "Starts after the import ahead of it (imp_0). First page in 3 minutes. About 10 to 15 minutes left"],
    [{ status: "paused" }, "Paused. Nothing is read until you resume it"],
    [{ status: "stopped" }, "Stopped. The 40 found stay in the list"],
    [{ status: "completed", finish_reason: "max_reached", started_at: at(-12), finished_at: at(0) }, "Done in 12 minutes: reached its maximum"],
    [{ status: "completed", finish_reason: "no_new_leads", started_at: at(-60 * 30), finished_at: at(0) }, "Done in 30 hours: three pages in a row brought nobody new"],
    [{ status: "completed", finish_reason: "source_exhausted" }, "Done: read every result"],
    [{ format: "csv", status: "completed" }, null],
  ])("%j", (o, line) => {
    expect(importStatusLine(src(o), NOW)).toBe(line);
  });

  it("a time later today, tomorrow or later is a clock time", () => {
    expect(whenText(at(120), NOW)).toMatch(/^(at|tomorrow at) \d\d:\d\d$/);
    expect(whenText(at(60 * 24 * 4), NOW)).toMatch(/^on \w{3} \d{1,2} \w{3} at \d\d:\d\d$/);
  });

  it("get and list print the line and the estimate in seconds only; --json passes the API's fields through unchanged", async () => {
    const imp = src({ waiting: { kind: "budget", budget: "day" }, estimate: est(90_000, 180_000) });
    const was = process.stdout.isTTY;
    process.stdout.isTTY = true; // a person at a terminal; piped output is JSON
    const get = await wire(["lead", "imports", "get", "imp_1"], () => ({ body: imp }));
    expect([get.status, get.stdout.includes("progress: Daily search limit reached. About 25 hours to 2 days left"), get.stdout.includes("working_days")]).toEqual([0, true, false]);
    const list = await wire(["lead", "imports", "list"], () => ({ body: { object: "list", items: [imp, { ...imp, id: "imp_2", status: "paused" }], cursor: null } }));
    expect([list.status, list.stdout.match(/^progress: .*$/gm), list.stdout.includes("working_days")]).toEqual([0, ["progress: Daily search limit reached. About 25 hours to 2 days left", "progress: Paused. Nothing is read until you resume it"], false]);
    process.stdout.isTTY = was;
    const json = await wire(["lead", "imports", "get", "imp_1", "--json"], () => ({ body: imp }));
    expect([json.status, JSON.parse(json.stdout), json.stderr.includes("Daily search limit reached")]).toEqual([0, imp, true]);
  });
});

describe("Mailboxes from Curviate: a subscription in another currency", () => {
  it("quote says why it cannot be ordered and what to do", async () => {
    const r = await wire(["mailbox", "quote", "2"], () => ({ body: { object: "mailbox_quote", mailboxes: 2, currency: "usd", billing_period: "monthly", unit_amount: 600, amount: 1200, amount_monthly: 1200, charged: "with_next_invoice", prorated: false, plus_tax: true, orderable: false, not_orderable_reason: "currency", charge_waits_for: null } }));
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("It cannot be ordered now: your subscription is billed in another currency than Mailboxes from Curviate (US dollars). Contact support to move it to the current price, then order.");
  });
});
