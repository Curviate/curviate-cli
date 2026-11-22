/**
 * The commands of the second SDK/CLI pass: the one request each sends (method, path, query, body),
 * the local refusals that send nothing (exit 2), and the money command's confirmation.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lines, wire } from "../helpers/wire.js";

const ok = () => ({ body: { object: "x", id: "imp_1", items: [], cursor: null } });

describe("pass 2: the request each command sends", () => {
  it.each([
    [["team", "reply-labels"], { call: "GET /v1/teams/current/reply-labels", query: {}, body: undefined }],
    [["team", "reply-labels", "--on", "--not-interested-dnc", "--tag", "interested=tag_1", "--tag", "other="], { call: "PATCH /v1/teams/current/reply-labels", query: {}, body: { enabled: true, not_interested_adds_to_do_not_contact: true, tags: { interested: "tag_1", other: null } } }],
    [["lead", "import", "--source-url", "https://www.linkedin.com/sales/search/people?query=x", "--account", "acc_a", "--max", "50", "--list-name", "SN"], { call: "POST /v1/leads/imports", query: {}, body: { source: { kind: "sales_nav_search", account_id: "acc_a", url: "https://www.linkedin.com/sales/search/people?query=x", max: 50 }, list_name: "SN" } }],
    [["lead", "import", "--source", "company_people", "--filter", "keywords=fintech", "--titles", "CTO,VP", "--account", "acc_a", "--continue", "imp_0"], { call: "POST /v1/leads/imports", query: {}, body: { source: { kind: "company_people", account_id: "acc_a", filters: { keywords: "fintech" }, titles: ["CTO", "VP"] }, continue_from: "imp_0" } }],
    [["lead", "imports", "pause", "imp_1"], { call: "POST /v1/leads/imports/imp_1/pause", query: {}, body: undefined }],
    [["lead", "imports", "resume", "imp_1"], { call: "POST /v1/leads/imports/imp_1/resume", query: {}, body: undefined }],
    [["lead", "imports", "stop", "imp_1"], { call: "POST /v1/leads/imports/imp_1/stop", query: {}, body: undefined }],
    [["analytics", "email", "--range", "30d", "--campaigns", "mot_1,mot_2", "--include", "weeks"], { call: "GET /v1/analytics/email", query: { range: "30d", campaign_id: "mot_1,mot_2", include: "weeks" }, body: undefined }],
    [["notification", "list", "--channel", "email"], { call: "GET /v1/notifications", query: { filter: "all", channel: "email" }, body: undefined }],
    [["company", "get", "1234567"], { call: "GET /v1/companies/1234567", query: {}, body: undefined }],
    [["company", "fields", "1234567", "--set", "tier=A", "--set", "seats=40", "--unset", "owner"], { call: "PATCH /v1/companies/1234567", query: {}, body: { extra: { tier: "A", seats: 40, owner: null } } }],
    [["core", "company", "acme", "--account", "acc_a", "--mode", "cache_only"], { call: "GET /v1/acc_a/companies/acme", query: { mode: "cache_only" }, body: undefined }],
    [["mailbox", "update", "mbx_1", "--display-name", "Ana from Acme"], { call: "PATCH /v1/mailboxes/mbx_1", query: {}, body: { display_name: "Ana from Acme" } }],
    [["mailbox", "update", "mbx_1", "--clear-display-name"], { call: "PATCH /v1/mailboxes/mbx_1", query: {}, body: { display_name: null } }],
    [["signal", "list", "--kind", "profile_viewed", "--match", "lead", "--no-listed"], { call: "GET /v1/signals", query: { kind: "profile_viewed", match: "lead", listed: "false" }, body: undefined }],
    [["signal", "get", "sig_1"], { call: "GET /v1/signals/sig_1", query: {}, body: undefined }],
    [["signal", "kinds"], { call: "GET /v1/signals/kinds", query: {}, body: undefined }],
    [["signal", "watch"], { call: "GET /v1/signals/watch", query: {}, body: undefined }],
    [["signal", "settings", "--profile-viewed", "off"], { call: "PATCH /v1/signals/settings", query: {}, body: { follow_up: { profile_viewed: false } } }],
    [["signal", "rules", "list", "--enabled"], { call: "GET /v1/signals/rules", query: { enabled: "true" }, body: undefined }],
    [["signal", "rules", "create", "--name", "Viewers", "--kind", "profile_viewed", "--add-to-list", "cl_1", "--send-event"], { call: "POST /v1/signals/rules", query: {}, body: { name: "Viewers", kinds: ["profile_viewed"], outcomes: [{ type: "add_to_list", list_id: "cl_1" }, { type: "send_event" }] } }],
    [["signal", "rules", "get", "sgr_1"], { call: "GET /v1/signals/rules/sgr_1", query: {}, body: undefined }],
    [["signal", "rules", "update", "sgr_1", "--off", "--all-accounts"], { call: "PATCH /v1/signals/rules/sgr_1", query: {}, body: { enabled: false, account_ids: null } }],
    [["signal", "rules", "delete", "sgr_1"], { call: "DELETE /v1/signals/rules/sgr_1", query: {}, body: undefined }],
    [["billing", "price", "move", "--yes"], { call: "POST /v1/billing/subscription/move-to-current-price", query: {}, body: undefined }],
  ])("%j", async (args, expected) => {
    const r = await wire(args, ok);
    expect([r.status, lines(r.sent)]).toEqual([0, [expected]]);
  });

  it.each([
    [["billing", "price", "move"]], // money, no terminal, no --yes: nothing sent
    [["lead", "import", "--source-url", "https://example.com/x", "--account", "acc_a"]], // no kind the URL names
    [["lead", "import", "--source", "people_search", "--source-url", "https://www.linkedin.com/search/results/people/?k=1"]], // no --account
    [["lead", "import", "--source", "post_engagers", "--post-id", "1", "--account", "acc_a", "--continue", "imp_0", "--restart"]],
    [["team", "reply-labels", "--tag", "unsure=tag_1"]],
    [["company", "get", "acme"]], // the id is numeric
    [["company", "fields", "1234567", "--set", "tier="]],
    [["signal", "rules", "create", "--name", "x", "--kind", "profile_viewed"]], // no outcome
    [["signal", "settings", "--post-engaged", "maybe"]],
    [["notification", "list", "--channel", "sms"]],
  ])("%j exits 2 with no request", async (args) => {
    const r = await wire(args);
    expect([r.status, r.sent.length]).toEqual([2, 0]);
  });
});

describe("pass 3: the request each command sends", () => {
  it.each([
    [["billing", "seats", "add", "2", "--yes"], { call: "POST /v1/billing/seats/add", query: {}, body: { qty: 2 } }],
    [["billing", "seats", "remove", "seat_1", "--yes"], { call: "POST /v1/billing/seats/seat_1/cancel", query: {}, body: undefined }],
    [["billing", "period", "set", "annual", "--yes"], { call: "POST /v1/billing/subscription/switch-period", query: {}, body: { to: "annual" } }],
    [["signal", "watch", "list"], { call: "GET /v1/signals/watch", query: {}, body: undefined }],
    [["signal", "watch", "set", "acc_1", "on"], { call: "PATCH /v1/signals/watch/acc_1", query: {}, body: { signal_watch: true } }],
    [["signal", "watch", "set", "acc_1", "off"], { call: "PATCH /v1/signals/watch/acc_1", query: {}, body: { signal_watch: false } }],
    [["signal", "actions", "--outcome", "skipped", "--rule-id", "sgr_1"], { call: "GET /v1/signals/actions", query: { outcome: "skipped", rule_id: "sgr_1" }, body: undefined }],
    [["signal", "rules", "enable", "sgr_1"], { call: "PATCH /v1/signals/rules/sgr_1", query: {}, body: { enabled: true } }],
    [["signal", "rules", "disable", "sgr_1"], { call: "PATCH /v1/signals/rules/sgr_1", query: {}, body: { enabled: false } }],
    [["signal", "rules", "create", "--name", "Warm", "--kind", "post_engaged.comment", "--enroll", "mot_1", "--act-on-last-7-days"], { call: "POST /v1/signals/rules", query: {}, body: { name: "Warm", kinds: ["post_engaged.comment"], outcomes: [{ type: "enroll", campaign_id: "mot_1" }], act_on_last_7_days: true } }],
    [["analytics", "attention", "--campaign", "mot_1"], { call: "GET /v1/analytics/email/attention", query: { campaign_id: "mot_1" }, body: undefined }],
    [["unibox", "conversation", "get", "cnv_1"], { call: "GET /v1/unibox/conversations/cnv_1", query: {}, body: undefined }],
    [["unibox", "conversation", "timeline", "cnv_1", "--channel", "email"], { call: "GET /v1/unibox/conversations/cnv_1/messages", query: { channel: "email" }, body: undefined }],
    [["unibox", "conversation", "mark", "cnv_1", "--unread"], { call: "PATCH /v1/unibox/conversations/cnv_1", query: {}, body: { read: false } }],
    [["unibox", "email", "send", "cnv_1", "Thanks", "--thread", "thr_1"], { call: "POST /v1/unibox/conversations/cnv_1/emails", query: {}, body: { text: "Thanks", thread_id: "thr_1" } }],
    [["unibox", "email", "send", "cnv_1", "Hello", "--subject", "Next steps", "--mailbox", "mbx_1"], { call: "POST /v1/unibox/conversations/cnv_1/emails", query: {}, body: { text: "Hello", subject: "Next steps", mailbox_id: "mbx_1" } }],
    [["unibox", "referral", "search", "msg_1", "--name", "Jane Doe"], { call: "POST /v1/unibox/messages/msg_1/referral/search", query: {}, body: { name: "Jane Doe" } }],
    [["unibox", "referral", "confirm", "msg_1", "--provider-id", "ACo1"], { call: "POST /v1/unibox/messages/msg_1/referral/confirm", query: {}, body: { provider_id: "ACo1" } }],
    [["mailbox", "update", "mbx_1", "--warm-up", "on", "--days", "14"], { call: "PATCH /v1/mailboxes/mbx_1", query: {}, body: { warm_up: { enabled: true, days: 14 } } }],
    [["campaign", "update", "mot_1", "--one-lead-per-company"], { call: "PATCH /v1/campaigns/mot_1", query: {}, body: { settings: { one_lead_per_company: true } } }],
    [["campaign", "update", "mot_1", "--no-one-lead-per-company"], { call: "PATCH /v1/campaigns/mot_1", query: {}, body: { settings: { one_lead_per_company: false } } }],
    [["mailbox", "update", "mbx_1", "--warm-up", "off"], { call: "PATCH /v1/mailboxes/mbx_1", query: {}, body: { warm_up: { enabled: false } } }],
    [["analytics", "email", "--include", "mailboxes,domains", "--forecast"], { call: "GET /v1/analytics/email", query: { include: "mailboxes,domains,forecast" }, body: undefined }],
    [["do-not-contact", "add", "--company", "https://www.linkedin.com/company/1234567/"], { call: "POST /v1/do-not-contact", query: {}, body: { company_linkedin_url: "https://www.linkedin.com/company/1234567/" } }],
    [["campaign", "attachment", "get", "cat_1"], { call: "GET /v1/campaigns/attachments/cat_1", query: {}, body: undefined }],
    [["webhook", "create", "--source", "signal", "--events", "signal.matched", "--request-url", "https://example.com/hooks"], { call: "POST /v1/webhooks", query: {}, body: { source: "signal", events: ["signal.matched"], request_url: "https://example.com/hooks", enabled: true } }],
  ])("%j", async (args, expected) => {
    const r = await wire(args, ok);
    expect([r.status, lines(r.sent)]).toEqual([0, [expected]]);
  });

  it.each([
    [["billing", "seats", "add", "2"]], // money, no terminal, no --yes: nothing sent
    [["billing", "seats", "add", "51", "--yes"]],
    [["billing", "seats", "remove", "seat_1"]],
    [["billing", "period", "set", "monthly", "--yes"]],
    [["signal", "watch", "set", "acc_1", "maybe"]],
    [["signal", "watch", "set", "acc_1"]], // no state
    [["signal", "actions", "--outcome", "done"]],
    [["signal", "rules", "update", "sgr_1", "--act-on-last-7-days"]], // create only
    [["unibox", "conversation", "timeline", "cnv_1", "--channel", "sms"]],
    [["unibox", "email", "send", "cnv_1", "Hi"]], // neither --thread nor --subject
    [["unibox", "email", "send", "cnv_1", "Hi", "--thread", "thr_1", "--mailbox", "mbx_1"]],
    [["unibox", "conversation", "mark", "cnv_1"]],
    [["unibox", "referral", "confirm", "msg_1"]],
    [["mailbox", "update", "mbx_1", "--warm-up", "on"]], // no --days
    [["mailbox", "update", "mbx_1", "--warm-up", "on", "--days", "12"]],
    [["analytics", "email", "--include", "seeds"]],
    [["do-not-contact", "add", "--company", "https://www.linkedin.com/company/1/", "--lead", "con_1"]], // two subjects
    [["campaign", "attachment", "upload"]], // no file
  ])("%j exits 2 with no request", async (args) => {
    const r = await wire(args);
    expect([r.status, r.sent.length]).toEqual([2, 0]);
  });
});

describe("pass 5: company fields from a file", () => {
  it("a 3-row CSV makes 3 sequential PATCH requests, one per company, an empty cell leaving its key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cfp13-"));
    const file = join(dir, "companies.csv");
    writeFileSync(file, 'company_id,tier,owner\n111,A,"Lopez, Ana"\n222,B,\n333,,Kim\n');
    const r = await wire(["company", "fields", "--file", file], ok);
    expect([r.status, lines(r.sent)]).toEqual([0, [
      { call: "PATCH /v1/companies/111", query: {}, body: { extra: { tier: "A", owner: "Lopez, Ana" } } },
      { call: "PATCH /v1/companies/222", query: {}, body: { extra: { tier: "B" } } },
      { call: "PATCH /v1/companies/333", query: {}, body: { extra: { owner: "Kim" } } },
    ]]);
  });

  it.each([
    ["company_id,tier\n111,A\n111,B\n"], // a company twice
    ["id,tier\n111,A\n"], // no company_id column
    ["company_id,bad key\n111,A\n"],
    ["company_id,tier\nacme,A\n"],
  ])("a malformed file exits 2 with no request: %j", async (csv) => {
    const dir = mkdtempSync(join(tmpdir(), "cfp13-"));
    const file = join(dir, "c.csv");
    writeFileSync(file, csv);
    const r = await wire(["company", "fields", "--file", file]);
    expect([r.status, r.sent.length]).toEqual([2, 0]);
  });
});

describe("pass 5: an email from a conversation with Cc, Bcc and files", () => {
  const emailArgs = ["unibox", "email", "send", "cnv_1", "Hi", "--thread", "thr_1"];

  it("--cc, --bcc and --attach ride in the one request; a recipients_refused warning is printed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eml5-"));
    const file = join(dir, "pricing.pdf");
    writeFileSync(file, "%PDF-1.7");
    const r = await wire([...emailArgs, "--cc", "a@x.test,b@x.test", "--bcc", "c@x.test", "--attach", file], () => ({ status: 201, body: { id: "m_1", warnings: [{ code: "recipients_refused", addresses: ["b@x.test"], message: "x" }] } }));
    expect(r.status).toBe(0);
    expect(lines(r.sent)).toEqual([{ call: "POST /v1/unibox/conversations/cnv_1/emails", query: {}, body: {
      text: "Hi", thread_id: "thr_1", cc: ["a@x.test", "b@x.test"], bcc: ["c@x.test"],
      attachments: [{ filename: "pricing.pdf", content_type: "application/pdf", content: Buffer.from("%PDF-1.7").toString("base64") }],
    } }]);
    expect(r.stderr).toContain("warning: recipients_refused: b@x.test got nothing");
  });

  it.each([
    ["an unknown outcome: exit 1, never 7, and the one request only", { reason: "outcome_unknown" }, 1, "Do not send it again"],
    ["a provider refusal with no unknown outcome: exit 7 (control)", {}, 7, ""],
  ])("%s", async (_n, extra, exit, says) => {
    const r = await wire(emailArgs, () => ({ status: 502, body: { code: "PLATFORM_ERROR", message: "provider", user_fixable: false, retry_likely_to_succeed: false, ...extra } }));
    expect([r.status, r.sent.length]).toEqual([exit, 1]);
    if (says) expect(r.stderr).toContain(says);
    else expect(r.stderr).not.toContain("Do not send it again");
  });

  it("files over 20 MiB in all are refused before any request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eml5-"));
    const big = join(dir, "big.bin");
    writeFileSync(big, Buffer.alloc(20 * 1024 * 1024 + 1));
    const r = await wire([...emailArgs, "--attach", big]);
    expect([r.status, r.sent.length]).toEqual([2, 0]);
  });
});

describe("pass 6: placement tests, placement checks, Mailboxes from Curviate, the Sales Navigator kinds", () => {
  it.each([
    [["mailbox", "test", "mbx_1", "--subject", "Quick question", "--body-file", "-"], { call: "POST /v1/mailboxes/mbx_1/placement-tests", query: {}, body: { subject: "Quick question", body: "Hi Anna" } }],
    [["mailbox", "tests", "mbx_1", "--limit", "5"], { call: "GET /v1/mailboxes/mbx_1/placement-tests", query: { limit: "5" }, body: undefined }],
    [["mailbox", "tests", "mbx_1", "plt_1"], { call: "GET /v1/mailboxes/mbx_1/placement-tests/plt_1", query: {}, body: undefined }],
    [["analytics", "export", "--table", "email", "--range", "30d", "-o", join(tmpdir(), "p7-email.csv")], { call: "GET /v1/analytics/export", query: { range: "30d", format: "csv", entity: "email_daily" }, body: undefined }],
    [["analytics", "export", "--table", "email", "--job", "--range", "30d"], { call: "POST /v1/exports", query: {}, body: { entity: "email_daily", format: "csv", filters: { range: "30d" } } }],
    [["account", "safety", "events", "acc_1", "--budget-row", "profile_views", "--limit", "5"], { call: "GET /v1/acc_1/safety-events", query: { budget_row: "profile_views", limit: "5" }, body: undefined }],
    [["campaign", "placement", "mot_1"], { call: "GET /v1/campaigns/mot_1/placement-checks", query: {}, body: undefined }],
    [["mailbox", "buy", "--domain", "acme-mail.example", "--mailbox", "anna:Anna Weber:shared", "--mailbox", "max:Max: the second:acc_1", "--mailbox", "eva:Eva", "--yes"], { call: "POST /v1/mailboxes/purchases", query: {}, body: { domain: "acme-mail.example", mailboxes: [
      { local_part: "anna", display_name: "Anna Weber", sends_for: { kind: "shared" } },
      { local_part: "max", display_name: "Max: the second", sends_for: { kind: "account", account_id: "acc_1" } },
      { local_part: "eva", display_name: "Eva" },
    ] } }],
    [["mailbox", "purchase", "list", "--state", "awaiting_dns"], { call: "GET /v1/mailboxes/purchases", query: { state: "awaiting_dns" }, body: undefined }],
    [["mailbox", "purchase", "get", "mpu_1"], { call: "GET /v1/mailboxes/purchases/mpu_1", query: {}, body: undefined }],
    [["mailbox", "purchase", "check", "mpu_1"], { call: "POST /v1/mailboxes/purchases/mpu_1/check", query: {}, body: undefined }],
    [["lead", "import", "--source-url", "https://www.linkedin.com/sales/search/company?query=x", "--titles", "CTO", "--account", "acc_a"], { call: "POST /v1/leads/imports", query: {}, body: { source: { kind: "sales_nav_company_people", account_id: "acc_a", url: "https://www.linkedin.com/sales/search/company?query=x", titles: ["CTO"] } } }],
    [["lead", "import", "--source", "sales_nav_account_list", "--list-id", "123", "--account", "acc_a"], { call: "POST /v1/leads/imports", query: {}, body: { source: { kind: "sales_nav_account_list", account_id: "acc_a", list_id: "123" } } }],
  ])("%j", async (args, expected) => {
    const r = await wire(args, ok, { stdin: "Hi Anna\n" });
    expect([r.status, lines(r.sent)]).toEqual([0, [expected]]);
  });

  it.each([
    [["mailbox", "buy", "--domain", "acme-mail.example", "--mailbox", "anna:Anna"]], // money, no terminal, no --yes
    [["mailbox", "buy", "--domain", "acme-mail.example", "--mailbox", "anna", "--yes"]], // no name
    [["mailbox", "buy", "--domain", "acme-mail.example", "--yes"]], // no Mailbox
    [["mailbox", "test", "mbx_1", "--body-file", "-"]], // no subject
    [["mailbox", "purchase", "list", "--state", "paid"]],
    [["analytics", "export", "--table", "email,daily", "--job"]],
    [["analytics", "export", "--table", "email", "--origin", "api", "--job"]],
  ])("%j exits 2 with no request", async (args) => {
    const r = await wire(args, ok, { stdin: "x" });
    expect([r.status, r.sent.length]).toEqual([2, 0]);
  });

  it.each([
    ["past the Team's cap on Mailboxes from Curviate: the plain line, exit 5, one request", ["mailbox", "buy", "--domain", "acme-mail.example", "--mailbox", "anna:Anna", "--yes"], 403, "SPENDING_CAP_REACHED", 5, "past its cap on Mailboxes from Curviate"],
    ["orders paused: exit 1, one request", ["mailbox", "buy", "--domain", "acme-mail.example", "--mailbox", "anna:Anna", "--yes"], 409, "MAILBOX_SALES_PAUSED", 1, "cannot be ordered at the moment"],
    ["no room for this many: exit 1, one request, never retried", ["mailbox", "buy", "--domain", "acme-mail.example", "--mailbox", "anna:Anna", "--yes"], 409, "MAILBOX_NO_ROOM", 1, "Order fewer, or order again later."],
    ["the monthly allowance is used: exit 5, one request, never retried", ["mailbox", "test", "mbx_1", "--subject", "s", "--body-file", "-"], 429, "PLACEMENT_TEST_ALLOWANCE_EXHAUSTED", 5, "placement tests"],
    ["tests cannot run now: exit 1, one request", ["mailbox", "test", "mbx_1", "--subject", "s", "--body-file", "-"], 503, "PLACEMENT_TESTS_UNAVAILABLE", 1, "cannot run"],
  ])("%s", async (_n, args, status, code, exit, says) => {
    const message = code === "MAILBOX_NO_ROOM" ? "Curviate has no room for this many new Mailboxes at the moment and is adding more. Nothing was ordered or charged. Order fewer, or order again later." : code === "MAILBOX_SALES_PAUSED" ? "Mailboxes from Curviate cannot be ordered at the moment." : code === "PLACEMENT_TESTS_UNAVAILABLE" ? "Placement tests cannot run right now." : code === "SPENDING_CAP_REACHED" ? "Past the cap." : "This Team has used its 10 placement tests for this month.";
    const r = await wire(args, () => ({ status, body: { code, message, user_fixable: true, retry_likely_to_succeed: false } }), { stdin: "b" });
    expect([r.status, r.sent.length]).toEqual([exit, 1]);
    expect(r.stderr).toContain(says);
  });
});

describe("pass 8: Mailbox orders cancel, the same_company skip in human mode", () => {
  it("mailbox purchase cancel sends one DELETE; a charge under way is exit 8 with the read-again line, never retried", async () => {
    const ok = await wire(["mailbox", "purchase", "cancel", "mpu_1"], () => ({ body: { id: "mpu_1", state: "cancelled" } }));
    expect([ok.status, lines(ok.sent)]).toEqual([0, [{ call: "DELETE /v1/mailboxes/purchases/mpu_1", query: {}, body: undefined }]]);
    const charging = await wire(["mailbox", "purchase", "cancel", "mpu_1"], () => ({ status: 409, body: { code: "MAILBOX_PURCHASE_STATE_CONFLICT", message: "This order is being charged; it can no longer be cancelled. Read it again in a few minutes.", user_fixable: true, retry_likely_to_succeed: false } }));
    expect([charging.status, charging.sent.length]).toEqual([8, 1]);
    expect(charging.stderr).toContain("curviate mailbox purchase get mpu_1");
    const empty = await wire(["mailbox", "purchase", "cancel", " "]);
    expect([empty.status, empty.sent.length]).toEqual([2, 0]);
  });

  it("enrollment rows in human mode read same_company with the Lead kept", async () => {
    const { humanReasons } = await import("../../src/commands/enrollment.js");
    expect(humanReasons({ items: [{ skip_reason: "same_company", skip_message: "Another Lead at this company is in the Campaign.", skip_detail: "con_kept" }] })).toEqual({
      items: [{ skip_reason: "same_company: Another Lead at this company is in the Campaign. (con_kept)" }],
    });
  });
});

describe("pass 9: a Campaign file is streamed from disk in one request; an oversized one never leaves", () => {
  it("upload sends the file as a file-backed Blob (not a buffer), one request; over 20 MiB is exit 2 with no request", async () => {
    const { truncateSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "eml38-"));
    const pdf = join(dir, "pricing.pdf");
    writeFileSync(pdf, "%PDF-1.7 kit");
    const r = await wire(["campaign", "attachment", "upload", pdf], () => ({ status: 201, body: { id: "cat_1", filename: "pricing.pdf" } }));
    expect([r.status, r.sent.length, r.sent[0]?.method, r.sent[0]?.path, r.sent[0]?.blob, r.sent[0]?.bytes]).toEqual([0, 1, "POST", "/v1/campaigns/attachments", 12, undefined]);
    expect(r.stdout).toContain("cat_1");
    const big = join(dir, "big.bin");
    writeFileSync(big, "");
    truncateSync(big, 20 * 1024 * 1024 + 1); // sparse: nothing is written to disk
    const over = await wire(["campaign", "attachment", "upload", big]);
    expect([over.status, over.sent.length]).toEqual([2, 0]);
  });
});

describe("pass 9: an order being set up or reversed reads as such, never as a cue to retry", () => {
  it.each([
    [{ id: "mpu_1", state: "provisioning", reason: null }, "being set up", "Do not order again"],
    [{ id: "mpu_1", state: "cancelled", reason: "host_failed" }, "the charge was undone in full", "Nothing to retry"],
    [{ id: "mpu_1", state: "cancelled", reason: "subscription_ended", charge_unknown: true }, "We are checking whether this order was charged.", "If it was, the charge is given back in full."],
    [{ id: "mpu_1", state: "cancelled", reason: "currency", charge_unknown: false }, "billed in another currency than Mailboxes from Curviate (US dollars)", "Nothing was charged. Contact support"],
    // Sold 13: what the order waits for, and the three new ends, in the dashboard's words
    [{ id: "mpu_1", state: "awaiting_dns", waiting_for: "records", expires_at: "2026-12-03T12:00:00.000Z" }, "Add each record where your domain's DNS is managed.", "not all found by December 3, the order ends with nothing charged"],
    [{ id: "mpu_1", state: "awaiting_dns", waiting_for: "payment", expires_at: "2026-12-03T12:00:00.000Z" }, "update the payment method in Billing (app.curviate.com/settings/billing) and the order continues by itself", "still outstanding on December 3"],
    [{ id: "mpu_1", state: "awaiting_dns", waiting_for: "curviate", expires_at: "2026-12-03T12:00:00.000Z" }, "waits on Curviate's side and continues by itself; there is nothing to do on yours", "by December 3"],
    [{ id: "mpu_1", state: "awaiting_dns", waiting_for: "charge" }, "the order is being charged", "this can take a few minutes"],
    [{ id: "mpu_1", state: "cancelled", reason: "payment_outstanding" }, "payment stayed outstanding for 14 days", "Update the payment method in Billing"],
    [{ id: "mpu_1", state: "cancelled", reason: "held_by_curviate" }, "Curviate could not create the Mailboxes within 14 days", "You can order again."],
    [{ id: "mpu_1", state: "cancelled", reason: "domain_taken" }, "for this domain was confirmed first", "Name another domain."],
  ])("%j", async (order, a, b) => {
    const r = await wire(["mailbox", "purchase", "get", "mpu_1"], () => ({ body: order }));
    expect([r.status, r.sent.length]).toEqual([0, 1]);
    expect(r.stderr).toContain(a);
    expect(r.stderr).toContain(b);
  });
  it("an order waiting for its records carries no such note", async () => {
    const r = await wire(["mailbox", "purchase", "get", "mpu_1"], () => ({ body: { id: "mpu_1", state: "awaiting_dns", reason: null, charge_unknown: false } }));
    expect(r.stderr).not.toContain("charge");
  });
});

describe("pass 18: the previous mail provider line and each row's advice, as served", () => {
  const PREV = "Some senders can keep delivering to your previous mail provider until about ";
  const PREV_END = ". Nothing is lost on our side; check your old mailbox until then.";
  const NS = "Your domain's name servers did not answer Curviate's last check. It checks again at the next one.";
  const base = { id: "mpu_1", state: "awaiting_dns", waiting_for: "curviate", expires_at: "2026-12-03T12:00:00.000Z" };
  it.each([
    ["ahead: the last line", { ...base, previous_provider_until: "2099-01-01T12:00:00.000Z" }, true],
    ["ahead, active", { ...base, state: "active", waiting_for: null, previous_provider_until: "2099-01-01T12:00:00.000Z" }, true],
    ["passed", { ...base, previous_provider_until: "2020-01-01T12:00:00.000Z" }, false],
    ["null", { ...base, previous_provider_until: null }, false],
    ["ahead but cancelled", { ...base, state: "cancelled", reason: "requested", waiting_for: null, previous_provider_until: "2099-01-01T12:00:00.000Z" }, false],
  ])("%s", async (_n, order, shown) => {
    const r = await wire(["mailbox", "purchase", "get", "mpu_1"], () => ({ body: order }));
    expect([r.status, r.sent.length]).toEqual([0, 1]);
    const last = r.stderr.trimEnd().split("\n").at(-1) ?? "";
    expect([last.startsWith(PREV) && last.endsWith(PREV_END), r.stderr.includes(PREV)]).toEqual([shown, shown]);
  });
  it("the boundary is now, injected: until == now is not ahead", async () => {
    const { purchaseNote } = await import("../../src/commands/mailbox.js");
    const t = Date.parse("2026-11-21T10:00:00.000Z");
    const o = { state: "active", previous_provider_until: "2026-11-21T10:00:00.000Z" };
    expect([purchaseNote(o, t), purchaseNote(o, t - 1)?.startsWith(PREV)]).toEqual([null, true]);
  });
  it("a row's advice is printed as served, before the order's note; --json passes every field through", async () => {
    const order = { ...base, waiting_for: "records", previous_provider_until: null, records: [{ check: "mx", required: true, found: false, entries: [], advice: NS }, { check: "spf", required: true, found: true, entries: [] }] };
    const r = await wire(["mailbox", "purchase", "check", "mpu_1"], () => ({ body: order }));
    expect(r.stderr.split("\n").slice(0, 2)).toEqual([`mx: ${NS}`, expect.stringContaining("Add each record where your domain's DNS is managed.")]);
    const j = await wire(["mailbox", "purchase", "get", "mpu_1", "--json"], () => ({ body: { ...order, previous_provider_until: "2099-01-01T12:00:00.000Z" } }));
    expect(JSON.parse(j.stdout)).toMatchObject({ previous_provider_until: "2099-01-01T12:00:00.000Z", records: [{ advice: NS }, { found: true }] });
  });
});

describe("pass 10: settling is answered once; a connect names its seat", () => {
  it("mailbox remove on a 409 still settling exits 8 after one request", async () => {
    const r = await wire(["mailbox", "remove", "mbx_1"], () => ({ status: 409, body: { code: "MAILBOX_STATE_CONFLICT", message: "Too many Mailbox changes are still settling with billing. Nothing was changed; try again later.", user_fixable: true, retry_likely_to_succeed: false } }));
    expect([r.status, r.sent.length]).toEqual([8, 1]);
  });
});

describe("pass 11: the price of Mailboxes from Curviate is the server's, for this Team, when it is shown", () => {
  const yearly = { object: "mailbox_quote", mailboxes: 2, currency: "usd", billing_period: "annual", unit_amount: 6000, amount: 12000, amount_monthly: 1000, charged: "when_records_found", prorated: true, plus_tax: true, orderable: true, not_orderable_reason: null, charge_waits_for: null }; // served always null since Sold 13, never printed
  const buy = ["mailbox", "buy", "--domain", "acme-mail.example", "--mailbox", "anna:Anna:shared", "--mailbox", "ben:Ben:shared", "--yes"];
  const order = (amount: number) => ({ status: 201, body: { id: "mpu_1", state: "awaiting_dns", price: { ...yearly, amount } } });

  it("quote: one read, the served yearly price worded from its own fields", async () => {
    const r = await wire(["mailbox", "quote", "2"], () => ({ body: yearly }));
    expect([r.status, lines(r.sent)]).toEqual([0, [{ call: "GET /v1/mailboxes/purchases/quote", query: { mailboxes: "2" }, body: undefined }]]);
    expect(r.stderr).toContain("$120.00 a year ($60.00 each), plus tax where it applies. Charged the day the records are found at your domain");
  });

  it.each([
    ["payment", "Your Team has a payment outstanding. Update the payment method in Billing (app.curviate.com/settings/billing), then order."],
    ["capacity", "Curviate has no room for this many new Mailboxes at the moment and is adding more. Order fewer, or order again later."],
    ["trial", "It cannot be ordered now: available once your Team pays"],
  ])("quote not orderable for %s says what the person can do", async (why, says) => {
    const r = await wire(["mailbox", "quote", "2"], () => ({ body: { ...yearly, orderable: false, not_orderable_reason: why } }));
    expect(r.stderr).toContain(says);
  });

  it.each([["0"], ["51"], ["two"], ["2.5"]])("quote %s exits 2 with no request", async (n) => {
    const r = await wire(["mailbox", "quote", n]);
    expect([r.status, r.sent.length]).toEqual([2, 0]);
  });

  it.each([
    ["the order's price is the agreed one: kept, one request", 12000, 0, ["POST /v1/mailboxes/purchases"]],
    ["a different price: cancelled at once, exit 11", 6000, 11, ["POST /v1/mailboxes/purchases", "DELETE /v1/mailboxes/purchases/mpu_1"]],
  ])("%s", async (_n, served, exit, calls) => {
    const r = await wire([...buy, "--expect-amount", "12000"], (req) => (req.method === "POST" ? order(served) : { body: { id: "mpu_1", state: "cancelled" } }));
    expect([r.status, r.sent.map((s) => `${s.method} ${s.path}`)]).toEqual([exit, calls]);
    if (exit) expect(r.stderr).toContain("Cancelled mpu_1; nothing was charged");
  });

  it("buy with no terminal and no --yes sends nothing and names the quote", async () => {
    const r = await wire(buy.filter((a) => a !== "--yes"));
    expect([r.status, r.sent.length]).toEqual([2, 0]);
    expect(r.stderr).toContain("curviate mailbox quote 2");
  });

  it("help states no price; billing cap documents mailbox_cap", async () => {
    const h = await wire(["mailbox", "buy", "--help"]);
    expect(h.stdout + h.stderr).not.toMatch(/\$\d|\d+ (a|per) month/);
    const cap = await wire(["billing", "cap", "--help"]);
    expect(cap.stdout + cap.stderr).toMatch(/mailbox_cap[\s\S]*room/);
  });
});

describe("pass 11: files over the JSON route's inline reach go up first and are sent by id", () => {
  it("two 4 MiB files: two streamed uploads, then one email naming both ids and no inline bytes", async () => {
    const { truncateSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "rlu35-"));
    const [a, b] = [join(dir, "a.pdf"), join(dir, "b.pdf")];
    for (const p of [a, b]) { writeFileSync(p, "%PDF-1.7"); truncateSync(p, 4 * 1024 * 1024); }
    let n = 0;
    const r = await wire(["unibox", "email", "send", "cnv_1", "Hi", "--thread", "thr_1", "--attach", a, "--attach", b], (req) =>
      req.path === "/v1/campaigns/attachments" ? { status: 201, body: { id: `cat_${++n}` } } : { status: 201, body: { id: "m_1" } });
    expect(r.status).toBe(0);
    expect(r.sent.map((s) => [s.method, s.path, s.blob ?? null])).toEqual([
      ["POST", "/v1/campaigns/attachments", 4 * 1024 * 1024],
      ["POST", "/v1/campaigns/attachments", 4 * 1024 * 1024],
      ["POST", "/v1/unibox/conversations/cnv_1/emails", null],
    ]);
    expect(r.sent[2]!.body).toEqual({ text: "Hi", thread_id: "thr_1", attachment_ids: ["cat_1", "cat_2"] });
  });
});

describe("pass 11: `lead import --filter` help names exactly the keys the served document types per kind", () => {
  it("people_search, company_people and recruiter_search match the served oneOf", async () => {
    const { readFileSync } = await import("node:fs");
    const doc = JSON.parse(readFileSync(join(__dirname, "../fixtures/openapi.json"), "utf8"));
    const find = (o: unknown): { oneOf: Array<{ title: string; properties: Record<string, unknown> }> } | undefined => {
      if (!o || typeof o !== "object") return undefined;
      const p = (o as { properties?: { filters?: unknown } }).properties?.filters;
      if (p) return p as never;
      for (const v of Object.values(o)) { const r = find(v); if (r) return r; }
      return undefined;
    };
    const served = Object.fromEntries(find(doc.paths["/v1/leads/imports"].post.requestBody)!.oneOf.map((s) => [s.title, Object.keys(s.properties)]));
    const h = await wire(["lead", "import", "--help"]);
    const help = (h.stdout + h.stderr).replace(/\s+/g, " ");
    for (const kind of ["people_search", "company_people", "recruiter_search"]) {
      const listed = help.match(new RegExp(`${kind}(?: \\([^)]*\\))?: ([^;.]*)`))![1]!.replace(/\([^)]*\)/g, "").split(",").map((k) => k.trim().split(" ")[0]);
      expect([kind, listed]).toEqual([kind, served[kind]]);
    }
  });
});

describe("pass 19: email only", () => {
  it.each([
    [["lead", "create", "--email", "ana@acme.example", "--first-name", "Ana", "--list-name", "Q4 email"], { call: "POST /v1/leads", query: {}, body: { email: "ana@acme.example", first_name: "Ana", list_name: "Q4 email" } }],
    [["lead", "create", "--linkedin-url", "https://www.linkedin.com/in/ana/", "--email", "ana@acme.example"], { call: "POST /v1/leads", query: {}, body: { linkedin_url: "https://www.linkedin.com/in/ana/", email: "ana@acme.example" } }],
    [["lead", "update", "con_1", "--allow-fill", "job-title,company"], { call: "PATCH /v1/leads/con_1", query: {}, body: { sources: { job_title: null, company: null } } }],
    [["lead", "update", "con_1", "--linkedin-url", "https://www.linkedin.com/in/ana/"], { call: "PATCH /v1/leads/con_1", query: {}, body: { linkedin_url: "https://www.linkedin.com/in/ana/" } }],
    [["do-not-contact", "add", "--email", "bo@acme.example", "--scope", "email_only"], { call: "POST /v1/do-not-contact", query: {}, body: { email: "bo@acme.example", scope: "email_only" } }],
    [["campaign", "update", "mot_1", "--timezone", "Europe/Berlin"], { call: "PATCH /v1/campaigns/mot_1", query: {}, body: { schedule: { timezone: "Europe/Berlin" } } }],
    [["unibox", "conversation", "mark", "cnv_team_1", "--read"], { call: "PATCH /v1/unibox/conversations/cnv_team_1", query: {}, body: { read: true } }],
  ])("%j", async (args, expected) => {
    const r = await wire(args, ok);
    expect([r.status, lines(r.sent)]).toEqual([0, [expected]]);
  });

  it.each([
    [["lead", "create", "--first-name", "Ana"]], // neither --linkedin-url nor --email
    [["lead", "create", "--linkedin-url", " ", "--email", "ana@acme.example"]],
    [["lead", "update", "con_1", "--clear", "job-title", "--allow-fill", "job-title"]],
    [["lead", "update", "con_1", "--allow-fill", "nope"]],
    [["do-not-contact", "add", "--email", "bo@acme.example", "--lead", "con_1"]], // exactly one
    [["campaign", "update", "mot_1", "--timezone", ""]],
  ])("%j exits 2 with no request", async (args) => {
    const r = await wire(args);
    expect([r.status, r.sent.length]).toEqual([2, 0]);
  });

  it("do-not-contact import sums updated beside created, unchanged and skipped", async () => {
    const p = join(mkdtempSync(join(tmpdir(), "dnc-")), "d.json");
    writeFileSync(p, JSON.stringify([{ linkedin_url: "https://www.linkedin.com/in/ana/" }, { linkedin_url: "https://www.linkedin.com/in/bo/" }]));
    const r = await wire(["do-not-contact", "import", "--file", p, "--json"], () => ({ body: { object: "do_not_contact_import", counts: { created: 0, updated: 1, unchanged: 1, skipped: 0 }, report: [] } }));
    expect([r.status, JSON.parse(r.stdout).counts]).toEqual([0, { created: 0, updated: 1, unchanged: 1, skipped: 0 }]);
  });

  it("domain check names the signing record until it passes; a pass or no record says nothing", async () => {
    const rec = { name: "kq3mx7pa2vb._domainkey.acme.example", type: "TXT", value: "v=DKIM1; k=rsa; p=x" };
    const run = (checks: object, signing_record: object | null) => wire(["domain", "check", "acme.example"], () => ({ body: { object: "domain", name: "acme.example", checks, signing_record } }));
    const missing = await run({ mx: "pass", signing: "fail" }, rec);
    expect([missing.status, missing.stderr]).toEqual([0, expect.stringContaining(`signing: add the TXT record signing_record at ${rec.name}`)]);
    expect((await run({ mx: "pass", signing: "pass" }, rec)).stderr).not.toContain("signing:");
    expect((await run({ mx: "pass", signing: "unknown" }, null)).stderr).not.toContain("signing:");
  });

  it("analytics email prints one-click live of mailboxes in the compact view", async () => {
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      const body = (live: number) => ({ sent: 3, tracking: "set_up", opt_outs: { one_click: { live, mailboxes: 2 } } });
      const part = await wire(["analytics", "email"], () => ({ body: body(1) }));
      expect(part.stdout).toContain("one-click unsubscribe: live on 1 of 2 Mailboxes (the others send the unsubscribe link only");
      expect((await wire(["analytics", "email"], () => ({ body: body(2) }))).stdout).toContain("one-click unsubscribe: live on 2 of 2 Mailboxes\n");
    } finally {
      if (tty) Object.defineProperty(process.stdout, "isTTY", tty); else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });
});
