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
