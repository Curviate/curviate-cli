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

describe("an import from a LinkedIn source says why it waits and when it resumes", () => {
  it.each([
    [{ kind: "budget", until: "2026-11-21T09:00:00.000Z" }, "Search limit reached for this Account. Resumes 2026-11-21T09:00:00.000Z."],
    [{ kind: "search_limited", until: "2026-12-01T12:00:00.000Z" }, "LinkedIn shows this Account only a few search results for now. Resumes when that lifts, at the latest 2026-12-01T12:00:00.000Z."],
    [{ kind: "pushback", until: null }, "Paused: LinkedIn slowed this search down. Resumes on its own."],
    [{ kind: "active_hours", until: "2026-11-21T07:00:00.000Z" }, "Waiting for the Account's Active hours. Resumes 2026-11-21T07:00:00.000Z."],
  ])("%j", async (waiting, note) => {
    const r = await wire(["lead", "imports", "get", "imp_1"], () => ({ body: { object: "lead_import", id: "imp_1", status: "running", waiting } }));
    expect([r.status, r.sent.length]).toEqual([0, 1]);
    expect(r.stderr).toContain(note);
  });
});

describe("Mailboxes from Curviate: a subscription in another currency", () => {
  it("quote says why it cannot be ordered and what to do", async () => {
    const r = await wire(["mailbox", "quote", "2"], () => ({ body: { object: "mailbox_quote", mailboxes: 2, currency: "usd", billing_period: "monthly", unit_amount: 600, amount: 1200, amount_monthly: 1200, charged: "with_next_invoice", prorated: false, plus_tax: true, orderable: false, not_orderable_reason: "currency", charge_waits_for: null } }));
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("It cannot be ordered now: your subscription is billed in another currency than Mailboxes from Curviate (US dollars). Contact support to move it to the current price, then order.");
  });
});
