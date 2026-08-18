/**
 * Flag-to-body-field guard.
 *
 * The CLI's *method* surface (`ns.search.people(...)`) is compile-coupled to
 * the SDK client, so a renamed/removed SDK method reds `tsc`. Flag-to-body
 * mapping inside a `NAMED_FLAG_MAPPERS`-style function is hand-written string
 * literals (`body["current_company"] = ...`) with no such coupling: a server
 * field rename propagates through codegen into the SDK's generated types and
 * stops there — nothing reds, and the flag keeps pointing at a field the
 * server no longer accepts (400 INVALID_REQUEST).
 *
 * This test closes that gap by asserting against the served artifact, never
 * a hand-maintained field list: it runs each command's real named-flag body
 * builder with every named flag set, captures the actual body sent to the
 * (mocked) SDK method, and checks every key against the accepted
 * `properties` of the corresponding endpoint's request body schema in the
 * committed `@curviate/sdk` OpenAPI fixture — the practical offline stand-in
 * for the runtime `/.well-known/openapi.json`.
 *
 * `packages/cli` and `packages/sdk` are sibling git submodules of the same
 * parent repo (see `.gitmodules`) and are always checked out together in
 * this org's dev/QA flow (CLAUDE.md: "Gates are local+Railway, not
 * Actions" — there is no CI clone of `packages/cli` in isolation). The
 * fixture is read via a relative path across that sibling boundary; if it's
 * ever unavailable the suite skips loudly rather than passing silently.
 *
 * Pagination (`--cursor`/`--limit`) is deliberately excluded from every
 * invocation below: the SDK's own resource methods split those out of the
 * body into query params on the wire (confirmed in
 * packages/sdk/src/resources/search.ts), so they never appear in the
 * OpenAPI request-body schema even though the CLI merges them into the same
 * object it hands to the SDK method. That is correct, already-verified
 * behavior, not something this guard should flag.
 */

import { describe, it, expect, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const OPENAPI_FIXTURE = resolve(process.cwd(), "../sdk/fixtures/openapi.json");
const hasFixture = existsSync(OPENAPI_FIXTURE);

type JsonSchema = { $ref?: string; properties?: Record<string, unknown>; [k: string]: unknown };
type OpenApiDoc = {
  paths: Record<string, Record<string, { requestBody?: { content?: { "application/json"?: { schema?: JsonSchema } } } }>>;
  components: { schemas: Record<string, JsonSchema> };
};

function loadSpec(): OpenApiDoc {
  return JSON.parse(readFileSync(OPENAPI_FIXTURE, "utf8")) as OpenApiDoc;
}

/** Resolve a single `$ref` hop against `components.schemas` (flat refs only, sufficient for these bodies). */
function resolveSchema(schema: JsonSchema | undefined, schemas: Record<string, JsonSchema>): JsonSchema {
  if (!schema) return {};
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop() ?? "";
    return resolveSchema(schemas[name], schemas);
  }
  return schema;
}

/** The accepted top-level body field names for `POST <path>`, straight from the served OpenAPI fixture. */
function acceptedFields(spec: OpenApiDoc, path: string, method = "post"): Set<string> {
  const op = spec.paths[path]?.[method];
  const schema = resolveSchema(op?.requestBody?.content?.["application/json"]?.schema, spec.components.schemas);
  return new Set(Object.keys(schema.properties ?? {}));
}

/** Assert every key the CLI actually put in the captured body is accepted by the endpoint's schema. */
function assertNoRejectedFields(spec: OpenApiDoc, path: string, body: Record<string, unknown>): void {
  const accepted = acceptedFields(spec, path);
  const rejected = Object.keys(body).filter((k) => !accepted.has(k));
  expect(rejected, `flag(s) map to field(s) the server body for ${path} does not accept: ${rejected.join(", ")}`).toEqual([]);
}

const d = hasFixture ? describe : describe.skip;
if (!hasFixture) {
  console.warn(`flag-field-guard: skipped, fixture not found at ${OPENAPI_FIXTURE} (expects packages/sdk checked out alongside packages/cli)`);
}

d("CLI flag-to-body-field guard against the served OpenAPI schema", () => {
  it("search people: every named flag maps to a field POST /search/people accepts", async () => {
    const spec = loadSpec();
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const accountNs = { search: { people: vi.fn().mockResolvedValue({ items: [], cursor: null }) } };
    const client = { account: vi.fn().mockReturnValue(accountNs) };
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchPeople(client as never, {
      account: "acc_1",
      json: true,
      industry: "1",
      location: "1",
      company: "1",
      "past-company": "1",
      school: "1",
      "network-distance": "1",
      "connections-of": "1",
      "followers-of": "1",
      title: "eng",
      "profile-language": "en",
    } as never, out);

    const body = (accountNs.search.people as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    assertNoRejectedFields(spec, "/v1/{account_id}/search/people", body);
  });

  it("search companies: every named flag maps to a field POST /search/companies accepts", async () => {
    const spec = loadSpec();
    const { runSearchCompanies } = await import("../../src/commands/search.js");
    const accountNs = { search: { companies: vi.fn().mockResolvedValue({ items: [], cursor: null }) } };
    const client = { account: vi.fn().mockReturnValue(accountNs) };
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchCompanies(client as never, {
      account: "acc_1",
      json: true,
      industry: "1",
      location: "1",
      "has-job-offers": true,
      headcount: "1-10",
    } as never, out);

    const body = (accountNs.search.companies as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    assertNoRejectedFields(spec, "/v1/{account_id}/search/companies", body);
  });

  it("search posts: every named flag maps to a field POST /search/posts accepts", async () => {
    const spec = loadSpec();
    const { runSearchPosts } = await import("../../src/commands/search.js");
    const accountNs = { search: { posts: vi.fn().mockResolvedValue({ items: [], cursor: null }) } };
    const client = { account: vi.fn().mockReturnValue(accountNs) };
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchPosts(client as never, {
      account: "acc_1",
      json: true,
      "sort-by": "relevance",
      "date-posted": "past-week",
      "content-type": "videos",
      "posted-by-member": "m1",
      "posted-by-company": "c1",
      "posted-by-me": true,
      "mentioning-member": "m1",
      "mentioning-company": "c1",
      "author-industry": "1",
      "author-company": "c1",
      "author-keywords": "ai",
    } as never, out);

    const body = (accountNs.search.posts as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    assertNoRejectedFields(spec, "/v1/{account_id}/search/posts", body);
  });

  it("search jobs: every named flag maps to a field POST /search/jobs accepts", async () => {
    const spec = loadSpec();
    const { runSearchJobs } = await import("../../src/commands/search.js");
    const accountNs = { search: { jobs: vi.fn().mockResolvedValue({ items: [], cursor: null }) } };
    const client = { account: vi.fn().mockReturnValue(accountNs) };
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchJobs(client as never, {
      account: "acc_1",
      json: true,
      location: "1",
      industry: "1",
      seniority: "mid_senior",
      function: "1",
      "job-type": "full_time",
      company: "1",
      "sort-by": "recent",
      "date-posted": "7",
      title: "1",
      presence: "remote",
      benefits: "1",
      commitments: "1",
      "has-verifications": true,
      "under-10-applicants": true,
      "in-your-network": true,
      "fair-chance-employer": true,
      "location-within-area": "10",
    } as never, out);

    const body = (accountNs.search.jobs as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    assertNoRejectedFields(spec, "/v1/{account_id}/search/jobs", body);
  });

  it("search services: every named flag maps to a field POST /search/services accepts", async () => {
    const spec = loadSpec();
    const { runSearchServices } = await import("../../src/commands/search.js");
    const accountNs = { search: { services: vi.fn().mockResolvedValue({ items: [], cursor: null }) } };
    const client = { account: vi.fn().mockReturnValue(accountNs) };
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchServices(client as never, {
      account: "acc_1",
      json: true,
      keywords: "coaching",
      "service-category": "1",
      location: "1",
      connections: "1",
      language: "en",
    } as never, out);

    const body = (accountNs.search.services as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    assertNoRejectedFields(spec, "/v1/{account_id}/search/services", body);
  });

  it("sales-nav search people: every named flag maps to a field POST /sales-navigator/search/people accepts", async () => {
    const spec = loadSpec();
    const { runSalesNavSearchPeople } = await import("../../src/commands/sales-nav.js");
    const ns = { salesNavigator: { searchPeople: vi.fn().mockResolvedValue({ items: [], cursor: null }) } };
    const client = { account: vi.fn().mockReturnValue(ns) };
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSalesNavSearchPeople(client as never, {
      account: "acc_1",
      json: true,
      "first-name": "Ada",
      "last-name": "Lovelace",
      groups: "g1",
      "profile-language": "en",
    } as never, out);

    const body = (ns.salesNavigator.searchPeople as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    assertNoRejectedFields(spec, "/v1/{account_id}/sales-navigator/search/people", body);
  });

  it("sales-nav search companies: every named flag maps to a field POST /sales-navigator/search/companies accepts", async () => {
    const spec = loadSpec();
    const { runSalesNavSearchCompanies } = await import("../../src/commands/sales-nav.js");
    const ns = { salesNavigator: { searchCompanies: vi.fn().mockResolvedValue({ items: [], cursor: null }) } };
    const client = { account: vi.fn().mockReturnValue(ns) };
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSalesNavSearchCompanies(client as never, {
      account: "acc_1",
      json: true,
      keywords: "tech",
    } as never, out);

    const body = (ns.salesNavigator.searchCompanies as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    assertNoRejectedFields(spec, "/v1/{account_id}/sales-navigator/search/companies", body);
  });

  it("recruiter search people: every named flag maps to a field POST /recruiter/search/people accepts", async () => {
    const spec = loadSpec();
    const { runRecruiterSearchPeople } = await import("../../src/commands/recruiter.js");
    const ns = { recruiter: { searchPeople: vi.fn().mockResolvedValue({ items: [], cursor: null }) } };
    const client = { account: vi.fn().mockReturnValue(ns) };
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runRecruiterSearchPeople(client as never, {
      account: "acc_1",
      json: true,
      "employment-type": "FULL_TIME",
      function: "eng",
      "profile-language": "en",
    } as never, out);

    const body = (ns.recruiter.searchPeople as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    assertNoRejectedFields(spec, "/v1/{account_id}/recruiter/search/people", body);
  });
});
