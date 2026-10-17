/**
 * `search` group: run* functions against a mocked SDK namespace. Flag -> request body
 * is table-driven; every refusal asserts the SDK was never called.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { Mock } from "vitest";
import { noConnectedAccounts } from "../helpers/no-connected-accounts.js";
import { exitCode } from "../helpers/exit-code.js";
import { arg0, clientOf, json, mkOut, ndjson, sdkError, text } from "../helpers/f1-unit.js";
import {
  runSearchCompanies, runSearchGroups, runSearchJobs, runSearchParameters, runSearchPeople, runSearchPosts,
  runSearchFromUrl, runSearchServiceParameters, runSearchServices, searchCommand,
} from "../../src/commands/search.js";
import { slimSearchPeople } from "../../src/lib/slim.js";

type Run = (c: never, a: never, o: never) => Promise<void>;
const kinds = { people: runSearchPeople, companies: runSearchCompanies, posts: runSearchPosts, jobs: runSearchJobs } as Record<string, Run>;
const EMPTY = { items: [], cursor: null };

function setup() {
  const search = Object.fromEntries(
    ["people", "companies", "posts", "jobs", "getParameters", "groups", "services", "getServiceParameters"].map((m) => [m, vi.fn().mockResolvedValue(EMPTY)]),
  ) as Record<string, Mock>;
  return { search, client: clientOf({ search }) };
}
/** Run one search kind with `args` on top of {account, json}; resolve the request body the SDK got. */
async function body(kind: string, args: Record<string, unknown>) {
  const { search, client } = setup();
  await kinds[kind]!(client as never, { account: "acc_1", json: true, ...args } as never, mkOut() as never);
  return arg0(search[kind]!);
}
const neverCalled = (search: Record<string, Mock>) => Object.values(search).forEach((f) => expect(f).not.toHaveBeenCalled());
afterEach(() => vi.restoreAllMocks());

describe("flags map to the exact request body", () => {
  it.each<[string, string, Record<string, unknown>, Record<string, unknown>]>([
    ["people", "keywords", { keywords: "ai" }, { keywords: "ai" }],
    ["people", "--filters verbatim", { filters: '{"open_to":["recruiters"],"profile_language":["en"]}' }, { open_to: ["recruiters"], profile_language: ["en"] }],
    ["people", "keywords + filters", { keywords: "ml", filters: '{"industry":["96"]}' }, { industry: ["96"], keywords: "ml" }],
    ["people", "named flags (arrays comma-split, distance numeric)", {
      industry: "96,4", location: "103644278", company: "1441", "past-company": "111", school: "222",
      "network-distance": "1,2", "connections-of": "ACoAAB", "followers-of": "ACoAAC",
    }, {
      industry: ["96", "4"], location: ["103644278"], current_company: ["1441"], past_company: ["111"], school: ["222"],
      network_distance: [1, 2], connections_of: ["ACoAAB"], followers_of: ["ACoAAC"],
    }],
    ["people", "named flag wins over --filters, other filter keys kept", { filters: '{"industry":["OLD"],"keywords":"kept"}', industry: "96" }, { industry: ["96"], keywords: "kept" }],
    ["people", "--title -> advanced_keywords.title", { title: "AI Engineer" }, { advanced_keywords: { title: "AI Engineer" } }],
    ["people", "--title merges into advanced_keywords from --filters", { filters: '{"advanced_keywords":{"company":"Acme","title":"OLD"}}', title: "AI Engineer" }, { advanced_keywords: { company: "Acme", title: "AI Engineer" } }],
    ["people", "--profile-language", { "profile-language": "en,de,fr" }, { profile_language: ["en", "de", "fr"] }],
    ["people", "--connections-of single urn is wrapped", { "connections-of": "urn:li:member:747216553" }, { connections_of: ["urn:li:member:747216553"] }],
    ["people", "--connections-of / --followers-of comma list", { "connections-of": "id1,id2", "followers-of": "id1" }, { connections_of: ["id1", "id2"], followers_of: ["id1"] }],
    ["companies", "keywords", { keywords: "acme" }, { keywords: "acme" }],
    ["companies", "named flags + --filters", { industry: "96", location: "103644278", "has-job-offers": true, filters: '{"keywords":"from-filters"}' },
      { has_job_postings: true, industry: ["96"], location: ["103644278"], keywords: "from-filters" }],
    ["companies", "--headcount one bucket", { headcount: "1001-5000" }, { headcount: [{ min: 1001, max: 5000 }] }],
    ["companies", "--headcount two buckets in order, with --has-job-offers", { headcount: "1-10,501-1000", "has-job-offers": true },
      { has_job_postings: true, headcount: [{ min: 1, max: 10 }, { min: 501, max: 1000 }] }],
    ["posts", "keywords", { keywords: "ai" }, { keywords: "ai" }],
    ["posts", "scalar flags (date-posted hyphen -> underscore)", { "sort-by": "relevance", "date-posted": "past-week", "content-type": "videos" },
      { sort_by: "relevance", date_posted: "past_week", content_type: "videos" }],
    ["posts", "--date-posted past-day", { "date-posted": "past-day" }, { date_posted: "past_day" }],
    ["posts", "--date-posted past-month", { "date-posted": "past-month" }, { date_posted: "past_month" }],
    ["posts", "--date-posted already underscored", { "date-posted": "past_week" }, { date_posted: "past_week" }],
    ["posts", "posted_by merges member + me into one object", { "posted-by-member": "id1", "posted-by-me": true }, { posted_by: { member: ["id1"], me: true } }],
    ["posts", "mentioning member + company", { "mentioning-member": "id1", "mentioning-company": "c1" }, { mentioning: { member: ["id1"], company: ["c1"] } }],
    ["posts", "author industry / company / keywords", { "author-industry": "i1", "author-company": "c1", "author-keywords": "CTO" },
      { author: { industry: ["i1"], company: ["c1"], keywords: "CTO" } }],
    ["posts", "posted_by and mentioning stay separate keys", { "posted-by-member": "id1", "mentioning-company": "c1" },
      { posted_by: { member: ["id1"] }, mentioning: { company: ["c1"] } }],
    ["jobs", "keywords", { keywords: "engineer" }, { keywords: "engineer" }],
    ["jobs", "named flags; --region wins over --location; --filters merged", {
      location: "103644278,90000084", industry: "96", seniority: "3", function: "eng", "job-type": "F", company: "1441",
      "sort-by": "DD", region: "eu", filters: '{"easy_apply":true}',
    }, { easy_apply: true, industry: ["96"], seniority: ["3"], function: ["eng"], job_type: ["F"], company: ["1441"], sort_by: "DD", region: "eu" }],
    ["jobs", "--location is the single region id, not a location array", { location: "103644278" }, { region: "103644278" }],
    ["jobs", "--region", { region: "eu" }, { region: "eu" }],
    ["jobs", "--date-posted is a number of days", { "date-posted": "14" }, { date_posted: 14 }],
    ["jobs", "--title -> role ids", { title: "30128,26089", keywords: "engineer" }, { keywords: "engineer", role: ["30128", "26089"] }],
    ["jobs", "all seven additional flags together", {
      presence: "remote", benefits: "medical_insurance", commitments: "full_time", "has-verifications": true,
      "under-10-applicants": true, "in-your-network": true, "fair-chance-employer": true,
    }, {
      presence: ["remote"], benefits: ["medical_insurance"], commitments: ["full_time"], has_verifications: true,
      under_10_applicants: true, in_your_network: true, fair_chance_employer: true,
    }],
    ["jobs", "--location-within-area is a number", { "location-within-area": "25", location: "101282230" }, { location_within_area: 25, region: "101282230" }],
  ])("%s: %s", async (kind, _label, args, expected) => {
    expect(await body(kind, args)).toEqual(expected);
  });

  it("--cursor / --limit are passed to the SDK call; --all walks the pages as NDJSON", async () => {
    expect(await body("people", { cursor: "c1", limit: "5" })).toEqual({ cursor: "c1", limit: 5 });
    const { search, client } = setup();
    search.people!.mockResolvedValueOnce({ items: [{ id: "p1" }, { id: "p2" }], cursor: "c1" }).mockResolvedValueOnce({ items: [{ id: "p3" }], cursor: null });
    const out = mkOut();
    await runSearchPeople(client as never, { account: "acc_1", all: true } as never, out);
    expect(client.account).toHaveBeenCalledWith("acc_1");
    expect(ndjson(out)).toHaveLength(3);
  });
});

describe("refusals happen before any SDK call (exit 2)", () => {
  it.each<[string, Record<string, unknown>]>([
    ["people", { filters: "{ not valid json " }],
    ["people", { filters: "[1,2,3]" }],
    ["people", { seniority: "3" }],
    ["people", { function: "eng" }],
    ["people", { "employment-type": "F" }],
    ["people", { "sort-by": "recent" }],
    ["jobs", { filters: "{bad" }],
    ["jobs", { "location-within-area": "abc" }],
    ["companies", { headcount: "not-a-bucket" }],
    ["companies", { headcount: "10001+" }],
    // an Object.prototype member name must not resolve to an inherited bucket
    ...["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"].map((h): [string, Record<string, unknown>] => ["companies", { headcount: h }]),
  ])("search %s %j", async (kind, args) => {
    const { search, client } = setup();
    expect(await exitCode(() => kinds[kind]!(client as never, { account: "acc_1", ...args } as never, mkOut() as never))).toBe(2);
    neverCalled(search);
  });

  it("every documented --headcount bucket is accepted", async () => {
    for (const headcount of ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000"]) {
      expect(await body("companies", { headcount })).toHaveProperty("headcount");
    }
  });

  it("groups without <query>, parameters without --keywords / with an empty --cursor / --max-pages without --all, service-parameters without --keywords", async () => {
    const { search, client } = setup();
    const o = mkOut() as never;
    const base = { type: "LOCATION", keywords: "london", account: "acc_1" };
    expect(await exitCode(() => runSearchGroups(client as never, { account: "acc_1" } as never, o))).toBe(2);
    for (const extra of [{ keywords: undefined }, { cursor: "" }, { "max-pages": "2" }]) {
      expect(await exitCode(() => runSearchParameters(client as never, { ...base, ...extra } as never, o)), JSON.stringify(extra)).toBe(2);
    }
    expect(await exitCode(() => runSearchServiceParameters(client as never, { type: "location", account: "acc_1" } as never, o))).toBe(2);
    neverCalled(search);
  });

  it("services without an account exits 2", async () => {
    const { client } = setup();
    expect(await exitCode(() => runSearchServices(noConnectedAccounts(client) as never, { keywords: "marketing", json: true } as never, mkOut() as never))).toBe(2);
  });
});

describe("search parameters / groups / services / service-parameters", () => {
  it("parameters: type + keywords; --cursor reaches the query and is absent when not given", async () => {
    const { search, client } = setup();
    const run = (extra: object) => runSearchParameters(client as never, { type: "LOCATION", keywords: "london", account: "acc_1", json: true, ...extra } as never, mkOut() as never);
    await run({});
    await run({ cursor: "cur_1", limit: "5" });
    expect(arg0(search.getParameters!, 0)).toEqual({ type: "LOCATION", keywords: "london" });
    expect(arg0(search.getParameters!, 1)).toMatchObject({ type: "LOCATION", keywords: "london", limit: 5, cursor: "cur_1" });
  });

  it("parameters --all walks until the cursor is null, each page carrying the previous cursor; --cursor starts the walk", async () => {
    const { search, client } = setup();
    const page = (id: string, cursor: string | null) => ({ object: "search_parameter_list", items: [{ id }], cursor });
    search.getParameters!.mockReset().mockResolvedValueOnce(page("1", "cur_1")).mockResolvedValueOnce(page("2", "cur_2")).mockResolvedValueOnce(page("3", null));
    const out = mkOut();
    await runSearchParameters(client as never, { type: "LOCATION", keywords: "l", account: "acc_1", all: true, "page-delay": "0" } as never, out as never);
    expect(ndjson(out)).toHaveLength(3);
    expect(text(out.stdout)).not.toContain("stream_truncated");
    expect(search.getParameters!.mock.calls.map((c) => (c[0] as Record<string, unknown>)["cursor"])).toEqual([undefined, "cur_1", "cur_2"]);

    search.getParameters!.mockReset().mockResolvedValueOnce(page("5", "cur_9")).mockResolvedValueOnce(page("6", null));
    await runSearchParameters(client as never, { type: "LOCATION", keywords: "l", cursor: "cur_start", account: "acc_1", all: true, "page-delay": "0" } as never, mkOut() as never);
    expect(search.getParameters!.mock.calls.map((c) => (c[0] as Record<string, unknown>)["cursor"])).toEqual(["cur_start", "cur_9"]);
  });

  it("parameters: an API 400 on a garbage cursor exits 2 (the cursor still reaches the API); a 2xx that is not a page exits 7", async () => {
    const { search, client } = setup();
    const run = (extra: object) => exitCode(() => runSearchParameters(client as never, { type: "LOCATION", keywords: "l", account: "acc_1", json: true, ...extra } as never, mkOut() as never));
    search.getParameters!.mockReset().mockRejectedValue(sdkError("INVALID_REQUEST", 400));
    expect(await run({ cursor: "not-a-cursor" })).toBe(2);
    expect(arg0(search.getParameters!)).toMatchObject({ cursor: "not-a-cursor" });
    search.getParameters!.mockReset().mockResolvedValue({ object: "search_parameter_list", cursor: null });
    expect(await run({})).toBe(7);
  });

  it("groups: <query> becomes keywords, limit/cursor pass through, full response is printed, --all streams", async () => {
    const { search, client } = setup();
    const item = { object: "group", id: "9123014", name: "GTM Engineering", member_count: 4000 };
    search.groups!.mockResolvedValue({ items: [item], cursor: null });
    const out = mkOut();
    await runSearchGroups(client as never, { query: "gtm", account: "acc_1", limit: "5", cursor: "cur_1", json: true } as never, out as never);
    expect(arg0(search.groups!)).toMatchObject({ keywords: "gtm", limit: 5, cursor: "cur_1" });
    expect(json(out)["items"][0]).toEqual(item);
    search.groups!.mockReset().mockResolvedValueOnce({ items: [{ id: "1" }], cursor: "c" }).mockResolvedValueOnce({ items: [{ id: "2" }], cursor: null });
    const all = mkOut();
    await runSearchGroups(client as never, { query: "gtm", account: "acc_1", all: true } as never, all as never);
    expect(ndjson(all)).toHaveLength(2);
  });

  it("services: flags map to the body, response printed, --all streams", async () => {
    const { search, client } = setup();
    const item = { object: "service_provider", id: "ACoAA1", name: "Jane Doe" };
    search.services!.mockResolvedValue({ items: [item], cursor: null });
    const out = mkOut();
    await runSearchServices(client as never, {
      keywords: "marketing", "service-category": "cat_1,cat_2", location: "loc_1", connections: "1,2", language: "en,de", account: "acc_1", json: true,
    } as never, out as never);
    expect(arg0(search.services!)).toMatchObject({ keywords: "marketing", service_category: ["cat_1", "cat_2"], location: ["loc_1"], connections: [1, 2], language: ["en", "de"] });
    expect(json(out)["items"][0]).toEqual(item);
    search.services!.mockReset().mockResolvedValueOnce({ items: [{ id: "1" }], cursor: "c" }).mockResolvedValueOnce({ items: [{ id: "2" }], cursor: null });
    const all = mkOut();
    await runSearchServices(client as never, { keywords: "m", account: "acc_1", all: true } as never, all as never);
    expect(ndjson(all)).toHaveLength(2);
  });

  it("service-parameters: --type optional, --cursor reaches the request, --all walks to a null cursor", async () => {
    const { search, client } = setup();
    const run = (extra: object) => runSearchServiceParameters(client as never, { keywords: "marke", account: "acc_1", json: true, ...extra } as never, mkOut() as never);
    await run({});
    await run({ type: "service_category", cursor: "cur_9" });
    expect(arg0(search.getServiceParameters!, 0)).toEqual({ keywords: "marke" });
    expect(arg0(search.getServiceParameters!, 1)).toMatchObject({ type: "service_category", cursor: "cur_9" });
    search.getServiceParameters!.mockReset().mockResolvedValueOnce({ items: [{ id: "1" }], cursor: "cur_1" }).mockResolvedValueOnce({ items: [{ id: "2" }], cursor: null });
    await run({ all: true, "page-delay": "0" });
    expect(search.getServiceParameters!.mock.calls).toHaveLength(2);
    expect(arg0(search.getServiceParameters!, 1)["cursor"]).toBe("cur_1");
  });
});

describe("--all truncation: JSON sentinel on stdout AND prose note on stderr (all-truncation-sentinel does not drive search)", () => {
  it.each(["people", "companies", "posts", "jobs"])("search %s stopped by --max-pages", async (kind) => {
    const { search, client } = setup();
    search[kind]!.mockResolvedValueOnce({ items: [{ id: "a" }], cursor: "c1" }).mockResolvedValueOnce({ items: [{ id: "b" }], cursor: null });
    const out = mkOut();
    await kinds[kind]!(client as never, { account: "acc_1", all: true, "max-pages": "1" } as never, out as never);
    const last = text(out.stdout).trim().split("\n").pop()!;
    expect(JSON.parse(last)).toEqual({ object: "stream_truncated", pages_fetched: 1, has_more: true });
    expect(text(out.stderr)).toMatch(/truncat/i);
  });

  it("natural exhaustion writes neither", async () => {
    const { search, client } = setup();
    search.people!.mockResolvedValueOnce({ items: [{ id: "p1" }], cursor: "c1" }).mockResolvedValueOnce({ items: [{ id: "p2" }], cursor: null });
    const out = mkOut();
    await runSearchPeople(client as never, { account: "acc_1", all: true } as never, out as never);
    expect(ndjson(out)).toHaveLength(2);
    expect(text(out.stdout)).not.toContain("stream_truncated");
    expect(text(out.stderr)).not.toMatch(/truncat/i);
  });
});

describe("slim output (default) vs --verbose", () => {
  async function items(kind: string, response: object, args: object = {}) {
    const { search, client } = setup();
    search[kind]!.mockResolvedValue(response);
    const out = mkOut();
    await kinds[kind]!(client as never, { keywords: "ai", account: "acc_1", json: true, ...args } as never, out as never);
    return json(out)["items"] as Array<Record<string, unknown>>;
  }

  it("people: slim keeps the identification fields (incl. visibility, hidden stays hidden), drops the rest; --verbose restores", async () => {
    const person = {
      id: "abc123", full_name: "Alice Smith", public_identifier: "alice-smith", headline: "AI Engineer", location: "Berlin, Germany",
      network_distance: "DISTANCE_2", visibility: "full", avatar_url: "https://example.com/pic.jpg", linkedin_urn: "urn:li:member:123", is_premium: false,
    };
    const res = { object: "people_search_result", items: [person], paging: { total_count: 1 }, cursor: null };
    const [slim] = await items("people", res);
    expect(slim).toEqual({
      id: "abc123", full_name: "Alice Smith", public_identifier: "alice-smith", headline: "AI Engineer", location: "Berlin, Germany",
      network_distance: "DISTANCE_2", visibility: "full",
    });
    const [hidden] = await items("people", { ...res, items: [{ ...person, visibility: "hidden" }] });
    expect(hidden!["visibility"]).toBe("hidden");
    const [verbose] = await items("people", res, { verbose: true });
    expect(verbose).toMatchObject({ avatar_url: "https://example.com/pic.jpg", linkedin_urn: "urn:li:member:123", is_premium: false });
  });

  it("companies: slim keeps id/name/industry/location/followers_count; industry key is ABSENT when the server sent none; --verbose restores", async () => {
    const co = { id: "c1", name: "Acme AI", industry: ["technology"], location: "SF", followers_count: 5000, summary: "AI", headcount: "51-200", profile_url: "https://linkedin.com/company/acme" };
    const [slim] = await items("companies", { items: [co], cursor: null });
    expect(slim).toEqual({ id: "c1", name: "Acme AI", industry: ["technology"], location: "SF", followers_count: 5000 });
    const [noIndustry] = await items("companies", { items: [{ id: "c2", name: "BetaCo", location: null, followers_count: null }], cursor: null });
    expect(Object.keys(noIndustry!)).not.toContain("industry");
    const [verbose] = await items("companies", { items: [co], cursor: null }, { verbose: true });
    expect(verbose).toMatchObject({ summary: "AI", headcount: "51-200", profile_url: "https://linkedin.com/company/acme" });
  });

  it("jobs: company_name comes from the nested company.name (null for a company-less listing); --verbose keeps the raw company object", async () => {
    const job = {
      job_urn: "urn:li:job:1", title: "AI Engineer", location: "Berlin", posted_at: "2026-01-01T00:00:00Z", easy_apply: true,
      company: { id: "c1", name: "Acme AI" }, reference_id: "ref", url: "https://linkedin.com/jobs/view/1", benefits: [],
    };
    const [slim] = await items("jobs", { items: [job], cursor: null });
    expect(slim).toEqual({ job_urn: "urn:li:job:1", title: "AI Engineer", location: "Berlin", posted_at: "2026-01-01T00:00:00Z", easy_apply: true, company_name: "Acme AI" });
    const [none] = await items("jobs", { items: [{ ...job, company: null }], cursor: null });
    expect(none!["company_name"]).toBeNull();
    const [verbose] = await items("jobs", { items: [job], cursor: null }, { verbose: true });
    expect(verbose!["company"]).toEqual(job.company);
    expect(verbose).not.toHaveProperty("company_name");
  });
});

describe("search people renders notices[] from the response", () => {
  const originalIsTTY = process.stdout.isTTY;
  afterEach(() => {
    process.stdout.isTTY = originalIsTTY;
  });
  const filterNotice = { code: "FILTER_VALUE_UNCHECKED", message: "The value was treated as an id and was not looked up.", field: "industry", value: "42" };
  const pageNotice = { code: "ALL_RESULTS_HIDDEN", message: "Every result on this page is hidden from the connected account." };
  const person = { id: "p_1", public_identifier: "alice", full_name: "Alice", headline: null, location: null, network_distance: "FIRST_DEGREE" };

  async function run(response: object, args: object = {}) {
    const { search, client } = setup();
    search.people!.mockResolvedValue(response);
    const out = mkOut();
    await runSearchPeople(client as never, { account: "acc_1", keywords: "ai", ...args } as never, out as never);
    return out;
  }

  it("--json: notices[] reaches stdout intact, in both shapes (field+value, page-scoped)", async () => {
    expect(json(await run({ items: [], cursor: null, notices: [filterNotice] }, { json: true, industry: "42" }))["notices"]).toEqual([filterNotice]);
    expect(json(await run({ items: [{ ...person, visibility: "hidden" }], cursor: null, notices: [pageNotice] }, { json: true }))["notices"]).toEqual([pageNotice]);
  });

  it("human mode: a notice renders as text; a partly-hidden page marks the row AND surfaces the notice", async () => {
    process.stdout.isTTY = true;
    const filter = text((await run({ items: [], cursor: null, notices: [filterNotice] }, { industry: "42" })).stdout);
    for (const s of ["FILTER_VALUE_UNCHECKED", filterNotice.message, "field: industry", "value: 42"]) expect(filter).toContain(s);
    const partly = text((await run({ items: [{ ...person, visibility: "hidden" }], cursor: null, notices: [{ code: "SOME_RESULTS_HIDDEN", message: "Some results are hidden." }] })).stdout);
    expect(partly).toContain("SOME_RESULTS_HIDDEN");
    expect(partly).toContain("visibility: hidden");
  });

  it("a response with no notices renders byte-identically (json and human)", async () => {
    const res = { items: [{ ...person, visibility: "full" }], cursor: null };
    const j = text((await run(res, { json: true })).stdout);
    expect(j).toBe(JSON.stringify(slimSearchPeople(res)) + "\n");
    expect(j).not.toContain("notice");
    process.stdout.isTTY = true;
    expect(text((await run(res)).stdout)).toBe("id: p_1\npublic_identifier: alice\nfull_name: Alice\nheadline: null\nlocation: null\nnetwork_distance: FIRST_DEGREE\nvisibility: full\n");
  });

  it("--all: notices go to stderr, stdout stays pure NDJSON", async () => {
    const out = await run({ items: [], cursor: null, notices: [pageNotice] }, { all: true });
    expect(text(out.stderr)).toContain("ALL_RESULTS_HIDDEN");
    expect(text(out.stdout)).not.toContain("ALL_RESULTS_HIDDEN");
  });
});

describe("help text an agent depends on", () => {
  type Sub = { meta?: { description?: string }; args?: Record<string, { description?: string }> };
  const subs = (searchCommand as unknown as { subCommands: Record<string, Sub> }).subCommands;
  const desc = (sub: string, flag: string) => subs[sub]?.args?.[flag]?.description ?? "";

  it("search parameters --type lists the served values (RELATION, never the pre-v2 CONNECTIONS); --connections-of points at it", () => {
    const d = desc("parameters", "type");
    for (const t of ["LOCATION", "PEOPLE", "RELATION", "COMPANY", "SCHOOL", "INDUSTRY", "JOB_FUNCTION", "JOB_TITLE", "EMPLOYMENT_TYPE", "SKILL"]) expect(d).toContain(t);
    expect(d).not.toContain("CONNECTIONS");
    expect(desc("people", "connections-of")).toContain("--type RELATION");
  });

  it("--filters help says the body is strict (unknown fields are rejected), never that they are stripped; posts help names the repeated-fragment caveat", () => {
    const f = desc("people", "filters").toLowerCase();
    expect(f).toContain("unknown");
    expect(f).toMatch(/reject|400|strict/);
    expect(f).not.toContain("strips");
    const d = subs["posts"]?.meta?.description ?? "";
    expect(d).toMatch(/repeat fragments/);
    expect(d).toMatch(/post get/);
  });
});

describe("search <url> -> search.fromUrl", () => {
  const URL = "https://www.linkedin.com/search/results/people/?keywords=founder";
  const mk = () => {
    const fromUrl = vi.fn().mockResolvedValue({ object: "search_result_list", items: [], cursor: null });
    return { fromUrl, client: clientOf({ search: { fromUrl } }) };
  };

  it("sends the url (plus --limit / --cursor) in the body; the group keeps a bare url positional and its subcommands", async () => {
    const { fromUrl, client } = mk();
    await runSearchFromUrl(client as never, { url: URL, account: "acc_1", json: true } as never, mkOut() as never);
    await runSearchFromUrl(client as never, { url: URL, limit: "20", cursor: "c1", account: "acc_1", json: true } as never, mkOut() as never);
    expect(fromUrl.mock.calls.map((c) => c[0])).toEqual([{ url: URL }, { url: URL, limit: 20, cursor: "c1" }]);
    const cmd = searchCommand as unknown as { args?: Record<string, { type?: string }>; subCommands?: Record<string, unknown> };
    expect(cmd.args?.["url"]?.type).toBe("positional");
    for (const name of ["people", "companies", "posts", "jobs", "parameters"]) expect(cmd.subCommands).toHaveProperty(name);
  });

  it("without an account exits 2 before any SDK call", async () => {
    const { fromUrl, client } = mk();
    expect(await exitCode(() => runSearchFromUrl(noConnectedAccounts(client) as never, { url: URL } as never, mkOut() as never))).toBe(2);
    expect(fromUrl).not.toHaveBeenCalled();
  });
});
