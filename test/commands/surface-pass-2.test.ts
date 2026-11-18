/**
 * The commands of the second SDK/CLI pass: the one request each sends (method, path, query, body),
 * the local refusals that send nothing (exit 2), and the money command's confirmation.
 */
import { describe, it, expect } from "vitest";
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
    [["signal", "watch", "set", "acc_1", "on"], { call: "PATCH /v1/signals/watch/acc_1", query: {}, body: { signal_watch: true } }],
    [["signal", "watch", "set", "acc_1", "off"], { call: "PATCH /v1/signals/watch/acc_1", query: {}, body: { signal_watch: false } }],
    [["signal", "actions", "--outcome", "skipped", "--rule-id", "sgr_1"], { call: "GET /v1/signals/actions", query: { outcome: "skipped", rule_id: "sgr_1" }, body: undefined }],
    [["signal", "rules", "enable", "sgr_1"], { call: "PATCH /v1/signals/rules/sgr_1", query: {}, body: { enabled: true } }],
    [["signal", "rules", "disable", "sgr_1"], { call: "PATCH /v1/signals/rules/sgr_1", query: {}, body: { enabled: false } }],
    [["signal", "rules", "create", "--name", "Warm", "--kind", "post_engaged.comment", "--enroll", "mot_1", "--act-on-last-7-days"], { call: "POST /v1/signals/rules", query: {}, body: { name: "Warm", kinds: ["post_engaged.comment"], outcomes: [{ type: "enroll", campaign_id: "mot_1" }], act_on_last_7_days: true } }],
    [["analytics", "attention", "--campaign", "mot_1"], { call: "GET /v1/analytics/email/attention", query: { campaign_id: "mot_1" }, body: undefined }],
    [["unibox", "conversation", "cnv_1"], { call: "GET /v1/unibox/conversations/cnv_1", query: {}, body: undefined }],
    [["unibox", "timeline", "cnv_1", "--channel", "email"], { call: "GET /v1/unibox/conversations/cnv_1/messages", query: { channel: "email" }, body: undefined }],
    [["do-not-contact", "add", "--company", "https://www.linkedin.com/company/1234567/"], { call: "POST /v1/do-not-contact", query: {}, body: { company_linkedin_url: "https://www.linkedin.com/company/1234567/" } }],
    [["campaign", "attachment", "get", "cat_1"], { call: "GET /v1/campaigns/attachments/cat_1", query: {}, body: undefined }],
    [["webhook", "create", "--source", "signal", "--events", "signal.matched", "--request-url", "https://example.com/hooks"], { call: "POST /v1/webhooks", query: {}, body: { source: "signal", events: ["signal.matched"], request_url: "https://example.com/hooks", enabled: true } }],
  ])("%j", async (args, expected) => {
    const r = await wire(args, ok);
    expect([r.status, lines(r.sent)]).toEqual([0, [expected]]);
  });

  it.each([
    [["signal", "watch", "set", "acc_1", "maybe"]],
    [["signal", "watch", "set", "acc_1"]], // no state
    [["signal", "actions", "--outcome", "done"]],
    [["signal", "rules", "update", "sgr_1", "--act-on-last-7-days"]], // create only
    [["unibox", "timeline", "cnv_1", "--channel", "sms"]],
    [["do-not-contact", "add", "--company", "https://www.linkedin.com/company/1/", "--lead", "con_1"]], // two subjects
    [["campaign", "attachment", "upload"]], // no file
  ])("%j exits 2 with no request", async (args) => {
    const r = await wire(args);
    expect([r.status, r.sent.length]).toEqual([2, 0]);
  });
});
