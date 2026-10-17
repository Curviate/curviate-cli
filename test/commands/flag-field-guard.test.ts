/**
 * Flag-to-body-field guard. Flag -> body-key mapping is hand-written string
 * literals with no compile-time coupling to the SDK, so a server field rename
 * would leave a flag pointing at a field the server rejects (400). Each case
 * runs a command's real body builder with every named flag set and checks every
 * key of the body it hands the SDK against the accepted `properties` of the
 * endpoint's request schema in the vendored OpenAPI fixture
 * (test/fixtures/openapi.json, kept honest by scripts/check-fixture-pin.mjs).
 * --cursor/--limit are excluded: the SDK moves them to the query string.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSearchCompanies, runSearchJobs, runSearchPeople, runSearchPosts, runSearchServices } from "../../src/commands/search.js";
import { runSalesNavSearchCompanies, runSalesNavSearchPeople } from "../../src/commands/sales-nav.js";
import { runRecruiterSearchPeople } from "../../src/commands/recruiter.js";
import { mkClient, mkOut } from "../helpers/f4-unit.js";

type Schema = { $ref?: string; properties?: Record<string, unknown> };
type Spec = {
  paths: Record<string, Record<string, { requestBody?: { content?: { "application/json"?: { schema?: Schema } } } }>>;
  components: { schemas: Record<string, Schema> };
};
const spec = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/openapi.json"), "utf8")) as Spec;
const resolveRef = (s: Schema | undefined): Schema => (s?.$ref ? resolveRef(spec.components.schemas[s.$ref.split("/").pop() ?? ""]) : (s ?? {}));

const P = "/v1/{account_id}";
const CASES: Array<[string, unknown, string, string, string, Record<string, unknown>]> = [
  ["search people", runSearchPeople, "search", "people", `${P}/search/people`, {
    industry: "1", location: "1", company: "1", "past-company": "1", school: "1", "network-distance": "1",
    "connections-of": "1", "followers-of": "1", title: "eng", "profile-language": "en",
  }],
  ["search companies", runSearchCompanies, "search", "companies", `${P}/search/companies`, {
    industry: "1", location: "1", "has-job-offers": true, headcount: "1-10",
  }],
  ["search posts", runSearchPosts, "search", "posts", `${P}/search/posts`, {
    "sort-by": "relevance", "date-posted": "past-week", "content-type": "videos", "posted-by-member": "m1",
    "posted-by-company": "c1", "posted-by-me": true, "mentioning-member": "m1", "mentioning-company": "c1",
    "author-industry": "1", "author-company": "c1", "author-keywords": "ai",
  }],
  ["search jobs", runSearchJobs, "search", "jobs", `${P}/search/jobs`, {
    location: "1", industry: "1", seniority: "mid_senior", function: "1", "job-type": "full_time", company: "1",
    "sort-by": "recent", "date-posted": "7", title: "1", presence: "remote", benefits: "1", commitments: "1",
    "has-verifications": true, "under-10-applicants": true, "in-your-network": true, "fair-chance-employer": true,
    "location-within-area": "10",
  }],
  ["search services", runSearchServices, "search", "services", `${P}/search/services`, {
    keywords: "coaching", "service-category": "1", location: "1", connections: "1", language: "en",
  }],
  ["sales-nav search people", runSalesNavSearchPeople, "salesNavigator", "searchPeople", `${P}/sales-navigator/search/people`, {
    "first-name": "Ada", "last-name": "Lovelace", groups: "g1", "profile-language": "en",
  }],
  ["sales-nav search companies", runSalesNavSearchCompanies, "salesNavigator", "searchCompanies", `${P}/sales-navigator/search/companies`, { keywords: "tech" }],
  ["recruiter search people", runRecruiterSearchPeople, "recruiter", "searchPeople", `${P}/recruiter/search/people`, {
    "employment-type": "FULL_TIME", function: "eng", "profile-language": "en",
  }],
];

describe("every named flag maps to a body field the served schema accepts", () => {
  it.each(CASES)("%s", async (_n, fn, group, method, path, flags) => {
    const accepted = new Set(Object.keys(resolveRef(resolveRef(spec.paths[path]?.["post"]?.requestBody?.content?.["application/json"]?.schema)).properties ?? {}));
    expect(accepted.size, `no request schema for ${path}`).toBeGreaterThan(0);
    const spy = vi.fn().mockResolvedValue({ items: [], cursor: null });
    const client = mkClient({ [group]: { [method]: spy } });
    await (fn as (...a: unknown[]) => Promise<void>)(client, { account: "acc_1", json: true, ...flags }, mkOut());
    const body = spy.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(body).filter((k) => !accepted.has(k)), `flags map to fields ${path} does not accept`).toEqual([]);
  });
});
