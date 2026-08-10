/**
 * Tests for the `search` command group.
 * Key assertions: search people/companies/posts/jobs use POST body,
 * cursor/limit go to query (not body); from-URL search is the bare `search <url>` form.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

function makeAccountNs() {
  return {
    search: {
      people: vi.fn(),
      companies: vi.fn(),
      posts: vi.fn(),
      jobs: vi.fn(),
      getParameters: vi.fn(),
      groups: vi.fn(),
      services: vi.fn(),
      getServiceParameters: vi.fn(),
    },
  };
}

function makeClient(accountNs: ReturnType<typeof makeAccountNs>) {
  return {
    account: vi.fn().mockReturnValue(accountNs),
  };
}

type SearchArgs = {
  keywords?: string;
  url?: string;
  type?: string;
  limit?: string;
  cursor?: string;
  all?: boolean;
  "max-pages"?: string;
  account?: string;
  json?: boolean;
  verbose?: boolean;
  preview?: boolean;
  fields?: string;
  "api-key"?: string;
  "base-url"?: string;
  timeout?: string;
  profile?: string;
  // filter escape hatch + named convenience flags
  filters?: string;
  "filters-file"?: string;
  industry?: string;
  location?: string;
  company?: string;
  "past-company"?: string;
  school?: string;
  "network-distance"?: string;
  "connections-of"?: string;
  "followers-of"?: string;
  "sort-by"?: string;
  "date-posted"?: string;
  "content-type"?: string;
  seniority?: string;
  function?: string;
  "employment-type"?: string;
  "job-type"?: string;
  region?: string;
  // People-specific filter flags
  title?: string;
  "profile-language"?: string;
  // search-AX v2: search companies
  "has-job-offers"?: boolean;
  headcount?: string;
  // search-AX v2: search jobs
  presence?: string;
  benefits?: string;
  commitments?: string;
  "has-verifications"?: boolean;
  "under-10-applicants"?: boolean;
  "in-your-network"?: boolean;
  "fair-chance-employer"?: boolean;
  "location-within-area"?: string;
  // search-AX v2: search posts
  "posted-by-member"?: string;
  "posted-by-company"?: string;
  "posted-by-me"?: boolean;
  "mentioning-member"?: string;
  "mentioning-company"?: string;
  "author-industry"?: string;
  "author-company"?: string;
  "author-keywords"?: string;
  // search groups
  query?: string;
  // search services
  "service-category"?: string;
  connections?: string;
  language?: string;
};

function makeExitMock() {
  return vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new Error(`process.exit(${code})`);
  });
}

describe("search people", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.search.people as Mock).mockResolvedValue({ object: "people_search_result", items: [], cursor: null });
    (accountNs.search.companies as Mock).mockResolvedValue({ object: "company_search_result", items: [], cursor: null });
    (accountNs.search.posts as Mock).mockResolvedValue({ object: "post_search_result", items: [], cursor: null });
    (accountNs.search.jobs as Mock).mockResolvedValue({ object: "job_search_result", items: [], cursor: null });
    (accountNs.search.getParameters as Mock).mockResolvedValue({ object: "search_parameter_list", parameters: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("search people --keywords ai — calls search.people with body containing keywords", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchPeople(client as never, { keywords: "ai", account: "acc_1", json: true } as SearchArgs, out);

    expect(client.account).toHaveBeenCalledWith("acc_1");
    expect(accountNs.search.people).toHaveBeenCalledWith(
      expect.objectContaining({ keywords: "ai" }),
    );
  });

  it("search people --cursor c1 --limit 5 — passes cursor+limit to SDK method", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchPeople(client as never, {
      account: "acc_1",
      cursor: "c1",
      limit: "5",
      json: true,
    } as SearchArgs, out);

    // The SDK method receives cursor+limit merged into the body/query param
    // (the SDK internally splits them out to query)
    expect(accountNs.search.people).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: "c1", limit: 5 }),
    );
  });

  it("search people --preview → usage error exit 2 (read command)", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => { throw new Error(`process.exit(${code})`); });
    try {
      await runSearchPeople(client as never, { account: "acc_1", preview: true } as SearchArgs, out);
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("search people --all — streams NDJSON over 2 pages", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    (accountNs.search.people as Mock)
      .mockResolvedValueOnce({ items: [{ id: "p1" }, { id: "p2" }], cursor: "c1" })
      .mockResolvedValueOnce({ items: [{ id: "p3" }], cursor: null });

    await runSearchPeople(client as never, { account: "acc_1", all: true } as SearchArgs, out);

    const writtenLines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string);
    const ndjsonLines = writtenLines.filter((l) => l.trim().startsWith("{"));
    expect(ndjsonLines).toHaveLength(3);
  });
});

describe("search people — filters escape hatch + named flags", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.search.people as Mock).mockResolvedValue({ items: [], cursor: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--filters '<json>' merges the parsed object into the POST body verbatim", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchPeople(client as never, {
      account: "acc_1",
      filters: '{"open_to":["recruiters"],"profile_language":["en"]}',
      json: true,
    } as SearchArgs, out);

    const body = (accountNs.search.people as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({ open_to: ["recruiters"], profile_language: ["en"] });
  });

  it("--keywords + --filters combine (keywords merges over filters)", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchPeople(client as never, {
      account: "acc_1",
      keywords: "ml",
      filters: '{"industry":["96"]}',
      json: true,
    } as SearchArgs, out);

    const body = (accountNs.search.people as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({ industry: ["96"], keywords: "ml" });
  });

  it("named flags map to the exact API field names (string arrays comma-split)", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchPeople(client as never, {
      account: "acc_1",
      industry: "96,4",
      location: "103644278",
      company: "1441",
      "past-company": "111",
      school: "222",
      "network-distance": "1,2",
      "connections-of": "ACoAAB",
      "followers-of": "ACoAAC",
      json: true,
    } as SearchArgs, out);

    const body = (accountNs.search.people as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({
      industry: ["96", "4"],
      location: ["103644278"],
      company: ["1441"],
      past_company: ["111"],
      school: ["222"],
      network_distance: [1, 2],
      connections_of: ["ACoAAB"],
      followers_of: ["ACoAAC"],
    });
  });

  it("named flags merge OVER --filters for the same key", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchPeople(client as never, {
      account: "acc_1",
      filters: '{"industry":["OLD"],"keywords":"from-filters"}',
      industry: "96",
      json: true,
    } as SearchArgs, out);

    const body = (accountNs.search.people as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body["industry"]).toEqual(["96"]);
    expect(body["keywords"]).toBe("from-filters");
  });

  it("bad --filters JSON exits 2 before any SDK call", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    const exitSpy = makeExitMock();

    try {
      await runSearchPeople(client as never, {
        account: "acc_1",
        filters: "{ not valid json ",
      } as SearchArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.search.people).not.toHaveBeenCalled();
  });

  it("non-object --filters (array) exits 2 before any SDK call", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    const exitSpy = makeExitMock();

    try {
      await runSearchPeople(client as never, {
        account: "acc_1",
        filters: "[1,2,3]",
      } as SearchArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.search.people).not.toHaveBeenCalled();
  });
});

describe("search companies / posts / jobs", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.search.companies as Mock).mockResolvedValue({ items: [], cursor: null });
    (accountNs.search.posts as Mock).mockResolvedValue({ items: [], cursor: null });
    (accountNs.search.jobs as Mock).mockResolvedValue({ items: [], cursor: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("search companies --keywords acme — calls search.companies", async () => {
    const { runSearchCompanies } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchCompanies(client as never, { keywords: "acme", account: "acc_1", json: true } as SearchArgs, out);

    expect(accountNs.search.companies).toHaveBeenCalledWith(
      expect.objectContaining({ keywords: "acme" }),
    );
  });

  it("search companies named flags + --filters map to exact API fields", async () => {
    const { runSearchCompanies } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchCompanies(client as never, {
      account: "acc_1",
      industry: "96",
      location: "103644278",
      "network-distance": "1",
      filters: '{"has_job_offers":true}',
      json: true,
    } as SearchArgs, out);

    const body = (accountNs.search.companies as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({
      has_job_offers: true,
      industry: ["96"],
      location: ["103644278"],
      network_distance: [1],
    });
  });

  it("search posts --keywords ai — calls search.posts", async () => {
    const { runSearchPosts } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchPosts(client as never, { keywords: "ai", account: "acc_1", json: true } as SearchArgs, out);

    expect(accountNs.search.posts).toHaveBeenCalledWith(
      expect.objectContaining({ keywords: "ai" }),
    );
  });

  it("search posts named scalar flags map to exact API fields", async () => {
    const { runSearchPosts } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchPosts(client as never, {
      account: "acc_1",
      "sort-by": "relevance",
      "date-posted": "past-week",
      "content-type": "videos",
      json: true,
    } as SearchArgs, out);

    const body = (accountNs.search.posts as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({
      sort_by: "relevance",
      date_posted: "past_week",  // hyphen → underscore normalized
      content_type: "videos",
    });
  });

  it("search jobs --keywords engineer — calls search.jobs", async () => {
    const { runSearchJobs } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchJobs(client as never, { keywords: "engineer", account: "acc_1", json: true } as SearchArgs, out);

    expect(accountNs.search.jobs).toHaveBeenCalledWith(
      expect.objectContaining({ keywords: "engineer" }),
    );
  });

  it("search jobs named flags (string arrays + scalars) map to exact API fields", async () => {
    const { runSearchJobs } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchJobs(client as never, {
      account: "acc_1",
      location: "103644278,90000084",
      industry: "96",
      seniority: "3",
      function: "eng",
      "job-type": "F",
      company: "1441",
      "sort-by": "DD",
      region: "eu",
      filters: '{"easy_apply":true}',
      json: true,
    } as SearchArgs, out);

    const body = (accountNs.search.jobs as Mock).mock.calls[0]![0] as Record<string, unknown>;
    // --location on jobs maps to body region (single string, not location array).
    // When both --location and --region are supplied, --region wins (applied last).
    expect(body).toEqual({
      easy_apply: true,
      industry: ["96"],
      seniority: ["3"],
      function: ["eng"],
      job_type: ["F"],
      company: ["1441"],
      sort_by: "DD",
      region: "eu",  // --region wins over --location on jobs
    });
  });

  it("search jobs bad --filters exits 2 before any SDK call", async () => {
    const { runSearchJobs } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    const exitSpy = makeExitMock();

    try {
      await runSearchJobs(client as never, {
        account: "acc_1",
        filters: "{bad",
      } as SearchArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.search.jobs).not.toHaveBeenCalled();
  });
});

describe("search parameters — GET, not paginated", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.search.getParameters as Mock).mockResolvedValue({ parameters: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("search parameters --type LOCATION --keywords london — calls getParameters", async () => {
    const { runSearchParameters } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchParameters(client as never, {
      type: "LOCATION",
      keywords: "london",
      account: "acc_1",
      json: true,
    } as SearchArgs, out);

    expect(accountNs.search.getParameters).toHaveBeenCalledWith(
      expect.objectContaining({ type: "LOCATION", keywords: "london" }),
    );
  });

  it("search parameters — missing --keywords exits 2 before any SDK call (v2: keywords always required)", async () => {
    const { runSearchParameters } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => { throw new Error(`process.exit(${code})`); });
    try {
      await runSearchParameters(client as never, {
        type: "EMPLOYMENT_TYPE",
        account: "acc_1",
      } as SearchArgs, out);
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.search.getParameters).not.toHaveBeenCalled();
  });

  it("search parameters --preview → usage error exit 2", async () => {
    const { runSearchParameters } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => { throw new Error(`process.exit(${code})`); });
    try {
      await runSearchParameters(client as never, {
        type: "LOCATION",
        account: "acc_1",
        preview: true,
      } as SearchArgs, out);
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("search parameters --all → usage error exit 2 (non-paginated)", async () => {
    const { runSearchParameters } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => { throw new Error(`process.exit(${code})`); });
    try {
      await runSearchParameters(client as never, {
        type: "LOCATION",
        account: "acc_1",
        all: true,
      } as SearchArgs, out);
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// search people new filter flags + invalid-flag rejection
// ---------------------------------------------------------------------------

describe("search people filter flags (title, profile-language, invalid-flag rejection)", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.search.people as Mock).mockResolvedValue({ items: [], cursor: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--title maps to advanced_keywords.title (keyword string, not id)", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchPeople(client as never, {
      account: "acc_1",
      title: "AI Engineer",
      json: true,
    } as SearchArgs, out);

    const body = (accountNs.search.people as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body["advanced_keywords"]).toEqual({ title: "AI Engineer" });
  });

  it("--title merges INTO existing advanced_keywords from --filters (named flag wins on conflict)", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchPeople(client as never, {
      account: "acc_1",
      filters: '{"advanced_keywords":{"company":"Acme","title":"OLD"}}',
      title: "AI Engineer",
      json: true,
    } as SearchArgs, out);

    const body = (accountNs.search.people as Mock).mock.calls[0]![0] as Record<string, unknown>;
    // title overrides, company preserved (merge not overwrite)
    expect(body["advanced_keywords"]).toEqual({ company: "Acme", title: "AI Engineer" });
  });

  it("--profile-language maps to profile_language (comma-split array)", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchPeople(client as never, {
      account: "acc_1",
      "profile-language": "en,de,fr",
      json: true,
    } as SearchArgs, out);

    const body = (accountNs.search.people as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body["profile_language"]).toEqual(["en", "de", "fr"]);
  });

  it("--seniority on people → exit 2 (invalid on classic search)", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    const exitSpy = makeExitMock();

    try {
      await runSearchPeople(client as never, {
        account: "acc_1",
        seniority: "3",
        json: true,
      } as SearchArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.search.people).not.toHaveBeenCalled();
  });

  it("--function on people → exit 2 (invalid on classic search)", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    const exitSpy = makeExitMock();

    try {
      await runSearchPeople(client as never, {
        account: "acc_1",
        function: "eng",
        json: true,
      } as SearchArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.search.people).not.toHaveBeenCalled();
  });

  it("--employment-type on people → exit 2 (invalid on classic search)", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    const exitSpy = makeExitMock();

    try {
      await runSearchPeople(client as never, {
        account: "acc_1",
        "employment-type": "F",
        json: true,
      } as SearchArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.search.people).not.toHaveBeenCalled();
  });

  it("--sort-by on people → exit 2 (invalid on classic search)", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    const exitSpy = makeExitMock();

    try {
      await runSearchPeople(client as never, {
        account: "acc_1",
        "sort-by": "recent",
        json: true,
      } as SearchArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.search.people).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// search jobs --location → body region (single string)
// ---------------------------------------------------------------------------

describe("search jobs --location maps to region body field", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.search.jobs as Mock).mockResolvedValue({ items: [], cursor: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--location on jobs maps to body region (single string, not location array)", async () => {
    const { runSearchJobs } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchJobs(client as never, {
      account: "acc_1",
      location: "103644278",
      json: true,
    } as SearchArgs, out);

    const body = (accountNs.search.jobs as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body["region"]).toBe("103644278");
    expect(body["location"]).toBeUndefined();
  });

  it("--region on jobs maps to body region (alias)", async () => {
    const { runSearchJobs } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchJobs(client as never, {
      account: "acc_1",
      region: "eu",
      json: true,
    } as SearchArgs, out);

    const body = (accountNs.search.jobs as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body["region"]).toBe("eu");
  });

  it("--location on people/companies still maps to location array (unchanged)", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    (accountNs.search.people as Mock).mockResolvedValue({ items: [], cursor: null });
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchPeople(client as never, {
      account: "acc_1",
      location: "103644278",
      json: true,
    } as SearchArgs, out);

    const body = (accountNs.search.people as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body["location"]).toEqual(["103644278"]);
    expect(body["region"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// search posts --date-posted hyphen → underscore normalization
// ---------------------------------------------------------------------------

describe("search posts --date-posted normalization (hyphen to underscore)", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.search.posts as Mock).mockResolvedValue({ items: [], cursor: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("past-day alias normalizes to past_day", async () => {
    const { runSearchPosts } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchPosts(client as never, {
      account: "acc_1",
      "date-posted": "past-day",
      json: true,
    } as SearchArgs, out);

    const body = (accountNs.search.posts as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body["date_posted"]).toBe("past_day");
  });

  it("past-week alias normalizes to past_week", async () => {
    const { runSearchPosts } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchPosts(client as never, {
      account: "acc_1",
      "date-posted": "past-week",
      json: true,
    } as SearchArgs, out);

    const body = (accountNs.search.posts as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body["date_posted"]).toBe("past_week");
  });

  it("past-month alias normalizes to past_month", async () => {
    const { runSearchPosts } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchPosts(client as never, {
      account: "acc_1",
      "date-posted": "past-month",
      json: true,
    } as SearchArgs, out);

    const body = (accountNs.search.posts as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body["date_posted"]).toBe("past_month");
  });

  it("already-underscore value passes through unchanged", async () => {
    const { runSearchPosts } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchPosts(client as never, {
      account: "acc_1",
      "date-posted": "past_week",
      json: true,
    } as SearchArgs, out);

    const body = (accountNs.search.posts as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body["date_posted"]).toBe("past_week");
  });
});

// ---------------------------------------------------------------------------
// --all truncation: JSON sentinel to stdout AND prose note to stderr —
// unified across all four search entities (D11 — search previously wrote
// the stdout sentinel but silently dropped the stderr prose that every
// other --all command emits; both channels are now mandatory everywhere).
// ---------------------------------------------------------------------------

describe("--all truncation: JSON sentinel on stdout AND prose note on stderr", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("search people --all truncated → last stdout line is stream_truncated JSON object", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    // Two pages with cursor — max-pages=1 triggers truncation after page 1
    (accountNs.search.people as Mock)
      .mockResolvedValueOnce({ items: [{ id: "p1" }], cursor: "c1" })
      .mockResolvedValueOnce({ items: [{ id: "p2" }], cursor: null });

    await runSearchPeople(client as never, {
      account: "acc_1",
      all: true,
      "max-pages": "1",
    } as SearchArgs, out);

    const writtenLines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string);
    const lastLine = writtenLines[writtenLines.length - 1]!.trim();
    const parsed = JSON.parse(lastLine) as Record<string, unknown>;
    expect(parsed["object"]).toBe("stream_truncated");
    expect(parsed["pages_fetched"]).toBe(1);
    expect(parsed["has_more"]).toBe(true);
    // Complementary, not exclusive: a human-readable note also goes to stderr
    // (previously search silently dropped this while every other --all
    // command emitted it — D11's "inverse" finding, now unified).
    expect((out.stderr.write as Mock).mock.calls.some((c) => String(c[0]).match(/truncat/i))).toBe(true);
  });

  it("search companies --all truncated → last stdout line is stream_truncated JSON, stderr gets the prose note", async () => {
    const { runSearchCompanies } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    (accountNs.search.companies as Mock)
      .mockResolvedValueOnce({ items: [{ id: "co1" }], cursor: "c1" })
      .mockResolvedValueOnce({ items: [{ id: "co2" }], cursor: null });

    await runSearchCompanies(client as never, {
      account: "acc_1",
      all: true,
      "max-pages": "1",
    } as SearchArgs, out);

    const writtenLines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string);
    const lastLine = writtenLines[writtenLines.length - 1]!.trim();
    const parsed = JSON.parse(lastLine) as Record<string, unknown>;
    expect(parsed).toEqual({ object: "stream_truncated", pages_fetched: 1, has_more: true });
    expect((out.stderr.write as Mock).mock.calls.some((c) => String(c[0]).match(/truncat/i))).toBe(true);
  });

  it("search posts --all truncated → last stdout line is stream_truncated JSON, stderr gets the prose note", async () => {
    const { runSearchPosts } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    (accountNs.search.posts as Mock)
      .mockResolvedValueOnce({ items: [{ id: "post1" }], cursor: "c1" })
      .mockResolvedValueOnce({ items: [{ id: "post2" }], cursor: null });

    await runSearchPosts(client as never, {
      account: "acc_1",
      all: true,
      "max-pages": "1",
    } as SearchArgs, out);

    const writtenLines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string);
    const lastLine = writtenLines[writtenLines.length - 1]!.trim();
    const parsed = JSON.parse(lastLine) as Record<string, unknown>;
    expect(parsed).toEqual({ object: "stream_truncated", pages_fetched: 1, has_more: true });
    expect((out.stderr.write as Mock).mock.calls.some((c) => String(c[0]).match(/truncat/i))).toBe(true);
  });

  it("search jobs --all truncated → last stdout line is stream_truncated JSON, stderr gets the prose note", async () => {
    const { runSearchJobs } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    (accountNs.search.jobs as Mock)
      .mockResolvedValueOnce({ items: [{ job_urn: "j1" }], cursor: "c1" })
      .mockResolvedValueOnce({ items: [{ job_urn: "j2" }], cursor: null });

    await runSearchJobs(client as never, {
      account: "acc_1",
      all: true,
      "max-pages": "1",
    } as SearchArgs, out);

    const writtenLines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string);
    const lastLine = writtenLines[writtenLines.length - 1]!.trim();
    const parsed = JSON.parse(lastLine) as Record<string, unknown>;
    expect(parsed["object"]).toBe("stream_truncated");
    expect(parsed["pages_fetched"]).toBe(1);
    expect(parsed["has_more"]).toBe(true);
    expect((out.stderr.write as Mock).mock.calls.some((c) => String(c[0]).match(/truncat/i))).toBe(true);
  });

  it("search people --all with natural exhaustion (cursor null) → no truncation line on stdout or stderr", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    (accountNs.search.people as Mock)
      .mockResolvedValueOnce({ items: [{ id: "p1" }], cursor: "c1" })
      .mockResolvedValueOnce({ items: [{ id: "p2" }], cursor: null });

    await runSearchPeople(client as never, {
      account: "acc_1",
      all: true,
      // no --max-pages cap hit: default maxPages(100) never reached before natural exhaustion
    } as SearchArgs, out);

    const writtenLines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string);
    expect(writtenLines.some((l) => l.includes("stream_truncated"))).toBe(false);
    expect((out.stderr.write as Mock).mock.calls.some((c) => String(c[0]).match(/truncat/i))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// search people slim defaults
// ---------------------------------------------------------------------------

describe("search people slim: correct field names, excluded fields, verbose restores", () => {
  const peopleItem = {
    id: "abc123",
    full_name: "Alice Smith",
    public_identifier: "alice-smith",
    headline: "AI Engineer",
    location: "Berlin, Germany",
    network_distance: "DISTANCE_2",
    visibility: "full",
    avatar_url: "https://example.com/pic.jpg",
    linkedin_urn: "urn:li:member:123",
    is_premium: false,
    is_open_profile: false,
  };

  const sdkResponse = {
    object: "people_search_result",
    items: [peopleItem],
    config: { params: {} },
    paging: { start: 0, page_count: 1, total_count: 1 },
    cursor: null,
  };

  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.search.people as Mock).mockResolvedValue(sdkResponse);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("slim mode: contains id/full_name/public_identifier/headline/location/network_distance/visibility ONLY", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchPeople(client as never, { keywords: "ai", account: "acc_1", json: true } as SearchArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as { items: Array<Record<string, unknown>> };
    const item = result.items[0]!;

    // Expected slim fields
    expect(item["id"]).toBe("abc123");
    expect(item["full_name"]).toBe("Alice Smith");
    expect(item["public_identifier"]).toBe("alice-smith");
    expect(item["headline"]).toBe("AI Engineer");
    expect(item["location"]).toBe("Berlin, Germany");
    expect(item["network_distance"]).toBe("DISTANCE_2");
    // `visibility` ships in the DEFAULT (non-verbose) view, not verbose-only:
    // it is what tells a default-mode user which rows are actually usable.
    expect(item["visibility"]).toBe("full");

    // Excluded verbose-only fields
    expect(item["avatar_url"]).toBeUndefined();
    expect(item["linkedin_urn"]).toBeUndefined();
    expect(item["is_premium"]).toBeUndefined();
    expect(item["is_open_profile"]).toBeUndefined();

    // Must NOT use old incorrect field names
    expect(item["provider_id"]).toBeUndefined();
    expect(item["first_name"]).toBeUndefined();
    expect(item["last_name"]).toBeUndefined();
  });

  it("slim mode: a hidden item's visibility reaches the default view (not silently dropped)", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    (accountNs.search.people as Mock).mockResolvedValue({
      ...sdkResponse,
      items: [{ ...peopleItem, id: "hidden1", full_name: "LinkedIn Member", public_identifier: undefined, visibility: "hidden" }],
    });

    await runSearchPeople(client as never, { keywords: "ai", account: "acc_1", json: true } as SearchArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as { items: Array<Record<string, unknown>> };
    expect(result.items[0]!["visibility"]).toBe("hidden");
  });

  it("--verbose restores avatar_url, linkedin_urn, is_premium", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchPeople(client as never, { keywords: "ai", account: "acc_1", json: true, verbose: true } as SearchArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as { items: Array<Record<string, unknown>> };
    const item = result.items[0]!;
    expect(item["avatar_url"]).toBe("https://example.com/pic.jpg");
    expect(item["linkedin_urn"]).toBe("urn:li:member:123");
    expect(item["is_premium"]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// search companies slim defaults
// ---------------------------------------------------------------------------

describe("search companies slim: field set, industry conditional omission", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("slim mode: id/name/industry/location/followers_count; excludes summary/headcount/profile_url", async () => {
    const { runSearchCompanies } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    (accountNs.search.companies as Mock).mockResolvedValue({
      items: [{
        id: "c1",
        name: "Acme AI",
        industry: ["technology", "internet"],
        location: "San Francisco, CA",
        followers_count: 5000,
        summary: "AI solutions",
        headcount: "51-200",
        profile_url: "https://linkedin.com/company/acme",
      }],
      cursor: null,
    });

    await runSearchCompanies(client as never, { keywords: "ai", account: "acc_1", json: true } as SearchArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as { items: Array<Record<string, unknown>> };
    const item = result.items[0]!;

    expect(item["id"]).toBe("c1");
    expect(item["name"]).toBe("Acme AI");
    expect(item["industry"]).toEqual(["technology", "internet"]);
    expect(item["location"]).toBe("San Francisco, CA");
    expect(item["followers_count"]).toBe(5000);
    expect(item["summary"]).toBeUndefined();
    expect(item["headcount"]).toBeUndefined();
    expect(item["profile_url"]).toBeUndefined();
  });

  it("industry key ABSENT (not null/empty) when not returned by server", async () => {
    const { runSearchCompanies } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    (accountNs.search.companies as Mock).mockResolvedValue({
      items: [{ id: "c2", name: "BetaCo", location: null, followers_count: null }],
      cursor: null,
    });

    await runSearchCompanies(client as never, { keywords: "ai", account: "acc_1", json: true } as SearchArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as { items: Array<Record<string, unknown>> };
    const item = result.items[0]!;

    expect(item["id"]).toBe("c2");
    expect(Object.prototype.hasOwnProperty.call(item, "industry")).toBe(false);
  });

  it("--verbose restores summary, headcount, profile_url", async () => {
    const { runSearchCompanies } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    (accountNs.search.companies as Mock).mockResolvedValue({
      items: [{
        id: "c1", name: "Acme AI",
        summary: "AI solutions", headcount: "51-200", profile_url: "https://linkedin.com/company/acme",
      }],
      cursor: null,
    });

    await runSearchCompanies(client as never, { keywords: "ai", account: "acc_1", json: true, verbose: true } as SearchArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as { items: Array<Record<string, unknown>> };
    const item = result.items[0]!;
    expect(item["summary"]).toBe("AI solutions");
    expect(item["headcount"]).toBe("51-200");
    expect(item["profile_url"]).toBe("https://linkedin.com/company/acme");
  });
});

// ---------------------------------------------------------------------------
// search jobs slim defaults
// ---------------------------------------------------------------------------

describe("search jobs slim: company_name synthesized from nested company.name, verbose restores raw company object", () => {
  // REQ-164 regression fixture: NO top-level company_name key anywhere — only
  // the nested company.name. A projector reading item["company_name"] directly
  // would emit null here; only reading company.name passes.
  const jobItem = {
    job_urn: "urn:li:job:1",
    title: "AI Engineer",
    location: "Berlin, Germany",
    posted_at: "2026-01-01T00:00:00Z",
    easy_apply: true,
    company: { id: "c1", name: "Acme AI", logo_url: "https://logo.example.com" },
    reference_id: "ref_abc",
    url: "https://linkedin.com/jobs/view/1",
    reposted: false,
    promoted: false,
    benefits: [],
  };

  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.search.jobs as Mock).mockResolvedValue({ items: [jobItem], cursor: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("slim mode: company_name derived from nested company.name (no top-level key exists)", async () => {
    const { runSearchJobs } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchJobs(client as never, { keywords: "ai", account: "acc_1", json: true } as SearchArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as { items: Array<Record<string, unknown>> };
    const item = result.items[0]!;

    expect(item["job_urn"]).toBe("urn:li:job:1");
    expect(item["title"]).toBe("AI Engineer");
    expect(item["location"]).toBe("Berlin, Germany");
    // This is the REQ-164 regression assertion: derived from company.name, not
    // a flat item["company_name"] passthrough (which does not exist on the fixture).
    expect(item["company_name"]).toBe("Acme AI");
    expect(item["posted_at"]).toBe("2026-01-01T00:00:00Z");
    expect(item["easy_apply"]).toBe(true);
    expect(item["company"]).toBeUndefined();
    expect(item["reference_id"]).toBeUndefined();
    expect(item["url"]).toBeUndefined();
    expect(item["reposted"]).toBeUndefined();
    expect(item["promoted"]).toBeUndefined();
    expect(item["benefits"]).toBeUndefined();
  });

  it("--verbose restores the raw company nested object; company_name is NOT synthesized in verbose", async () => {
    const { runSearchJobs } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchJobs(client as never, { keywords: "ai", account: "acc_1", json: true, verbose: true } as SearchArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as { items: Array<Record<string, unknown>> };
    const item = result.items[0]!;
    expect(item["company"]).toEqual({ id: "c1", name: "Acme AI", logo_url: "https://logo.example.com" });
    // --verbose prints the raw response verbatim (no synthesis) — the raw
    // response has no top-level company_name key at all.
    expect(item["company_name"]).toBeUndefined();
  });

  it("company: null (REQ-177 — agency/confidential listing) → slim company_name is null, no crash", async () => {
    (accountNs.search.jobs as Mock).mockResolvedValue({
      items: [{ ...jobItem, company: null }],
      cursor: null,
    });
    const { runSearchJobs } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchJobs(client as never, { keywords: "ai", account: "acc_1", json: true } as SearchArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as { items: Array<Record<string, unknown>> };
    const item = result.items[0]!;
    expect(item["company_name"]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// search posts slim: 200-char text truncation + author.name only
// ---------------------------------------------------------------------------

describe("search posts slim: text truncation and author projection", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("text >200 chars truncated to 200 chars in slim mode", async () => {
    const { runSearchPosts } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    (accountNs.search.posts as Mock).mockResolvedValue({
      items: [{
        id: "urn:li:activity:123",
        author: { name: "Bob", id: "urn:li:member:456", is_company: false, public_identifier: "bob" },
        text: "A".repeat(300),
        reaction_count: 42,
        comment_count: 7,
        share_url: "https://linkedin.com/posts/bob_1",
        repost_count: 1,
        is_repost: false,
      }],
      cursor: null,
    });

    await runSearchPosts(client as never, { keywords: "ai", account: "acc_1", json: true } as SearchArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as { items: Array<Record<string, unknown>> };
    const item = result.items[0]!;

    // Expected slim fields (D13: id is the real wire identifier — post_urn
    // and posted_at were never real keys on this v2 response)
    expect(item["id"]).toBe("urn:li:activity:123");
    expect(item["author"]).toEqual({ name: "Bob" });  // only name sub-field
    expect((item["text"] as string).length).toBe(200);
    expect(item["text"]).toBe("A".repeat(200));
    expect(item["reaction_count"]).toBe(42);
    expect(item["comment_count"]).toBe(7);

    // Excluded verbose-only fields
    expect(item["share_url"]).toBeUndefined();
    expect(item["repost_count"]).toBeUndefined();
    expect(item["is_repost"]).toBeUndefined();
    expect(item["post_urn"]).toBeUndefined();
    expect(item["posted_at"]).toBeUndefined();
    // author sub-fields beyond name excluded
    expect((item["author"] as Record<string, unknown>)["id"]).toBeUndefined();
    expect((item["author"] as Record<string, unknown>)["is_company"]).toBeUndefined();
    expect((item["author"] as Record<string, unknown>)["public_identifier"]).toBeUndefined();
  });

  it("text <=200 chars not truncated", async () => {
    const { runSearchPosts } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    (accountNs.search.posts as Mock).mockResolvedValue({
      items: [{ id: "urn:li:activity:124", author: { name: "Alice" }, text: "Short post", reaction_count: 1, comment_count: 0 }],
      cursor: null,
    });

    await runSearchPosts(client as never, { keywords: "ai", account: "acc_1", json: true } as SearchArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as { items: Array<Record<string, unknown>> };
    expect(result.items[0]!["text"]).toBe("Short post");
  });

  it("null text emits text: null", async () => {
    const { runSearchPosts } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    (accountNs.search.posts as Mock).mockResolvedValue({
      items: [{ id: "urn:li:activity:125", author: { name: "Carl" }, text: null, reaction_count: 0, comment_count: 0 }],
      cursor: null,
    });

    await runSearchPosts(client as never, { keywords: "ai", account: "acc_1", json: true } as SearchArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as { items: Array<Record<string, unknown>> };
    expect(result.items[0]!["text"]).toBeNull();
  });

  it("--verbose restores full text and full author object", async () => {
    const { runSearchPosts } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const longText = "A".repeat(300);
    (accountNs.search.posts as Mock).mockResolvedValue({
      items: [{
        id: "urn:li:activity:123",
        author: { name: "Bob", id: "urn:li:member:456" },
        text: longText,
        reaction_count: 42,
        comment_count: 7,
        share_url: "https://linkedin.com/posts/bob_1",
        repost_count: 1,
      }],
      cursor: null,
    });

    await runSearchPosts(client as never, { keywords: "ai", account: "acc_1", json: true, verbose: true } as SearchArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as { items: Array<Record<string, unknown>> };
    const item = result.items[0]!;
    expect(item["text"]).toBe(longText);
    expect((item["author"] as Record<string, unknown>)["id"]).toBe("urn:li:member:456");
    expect(item["share_url"]).toBe("https://linkedin.com/posts/bob_1");
    expect(item["repost_count"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// search jobs --date-posted: numeric days, no enum normalization
// ---------------------------------------------------------------------------

describe("search jobs --date-posted: numeric body field, no hyphen normalization", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.search.jobs as Mock).mockResolvedValue({ items: [], cursor: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--date-posted 7 → body date_posted: 7 (number)", async () => {
    const { runSearchJobs } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchJobs(client as never, {
      account: "acc_1",
      "date-posted": "7",
      json: true,
    } as SearchArgs, out);

    const body = (accountNs.search.jobs as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body["date_posted"]).toBe(7);
    expect(typeof body["date_posted"]).toBe("number");
  });

  it("--date-posted 30 → body date_posted: 30 (number)", async () => {
    const { runSearchJobs } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchJobs(client as never, {
      account: "acc_1",
      "date-posted": "30",
      json: true,
    } as SearchArgs, out);

    const body = (accountNs.search.jobs as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body["date_posted"]).toBe(30);
    expect(typeof body["date_posted"]).toBe("number");
  });

  it("jobs --date-posted is NOT hyphen-normalized (no string replacement applied)", async () => {
    // Posts normalise past-week → past_week; jobs just coerces to Number.
    // Passing "14" should arrive as the number 14, not a string.
    const { runSearchJobs } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchJobs(client as never, {
      account: "acc_1",
      "date-posted": "14",
      json: true,
    } as SearchArgs, out);

    const body = (accountNs.search.jobs as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body["date_posted"]).toBe(14);
    expect(typeof body["date_posted"]).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// search companies --has-job-offers / --headcount
// ---------------------------------------------------------------------------

describe("search companies: --has-job-offers / --headcount named flags", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.search.companies as Mock).mockResolvedValue({ items: [], cursor: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--has-job-offers → body has_job_offers: true", async () => {
    const { runSearchCompanies } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchCompanies(client as never, { "has-job-offers": true, account: "acc_1", json: true } as SearchArgs, out);

    const body = (accountNs.search.companies as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({ has_job_offers: true });
  });

  it("--headcount 1001-5000 → body headcount: [{min:1001,max:5000}]", async () => {
    const { runSearchCompanies } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchCompanies(client as never, { headcount: "1001-5000", account: "acc_1", json: true } as SearchArgs, out);

    const body = (accountNs.search.companies as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({ headcount: [{ min: 1001, max: 5000 }] });
  });

  it("--headcount 1-10,501-1000 → two bucket objects in listed order", async () => {
    const { runSearchCompanies } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchCompanies(client as never, { headcount: "1-10,501-1000", account: "acc_1", json: true } as SearchArgs, out);

    const body = (accountNs.search.companies as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({
      headcount: [
        { min: 1, max: 10 },
        { min: 501, max: 1000 },
      ],
    });
  });

  it("--has-job-offers + --headcount 51-200 → both keys present", async () => {
    const { runSearchCompanies } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchCompanies(client as never, {
      "has-job-offers": true,
      headcount: "51-200",
      account: "acc_1",
      json: true,
    } as SearchArgs, out);

    const body = (accountNs.search.companies as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({ has_job_offers: true, headcount: [{ min: 51, max: 200 }] });
  });

  it("--headcount not-a-bucket → exit 2, no SDK call", async () => {
    const { runSearchCompanies } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    const exitSpy = makeExitMock();

    try {
      await runSearchCompanies(client as never, { headcount: "not-a-bucket", account: "acc_1" } as SearchArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.search.companies).not.toHaveBeenCalled();
  });

  it("all 7 fully-specified buckets are individually recognized (no exit 2)", async () => {
    const { runSearchCompanies } = await import("../../src/commands/search.js");
    const buckets = ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000"];

    for (const bucket of buckets) {
      accountNs = makeAccountNs();
      client = makeClient(accountNs);
      (accountNs.search.companies as Mock).mockResolvedValue({ items: [], cursor: null });
      const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

      await runSearchCompanies(client as never, { headcount: bucket, account: "acc_1", json: true } as SearchArgs, out);

      expect(accountNs.search.companies).toHaveBeenCalledTimes(1);
    }
  });

  it("--headcount 10001+ (open/unresolved top bucket) → exit 2, deferred rather than guessed", async () => {
    const { runSearchCompanies } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    const exitSpy = makeExitMock();

    try {
      await runSearchCompanies(client as never, { headcount: "10001+", account: "acc_1" } as SearchArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.search.companies).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// search jobs --title → body role
// ---------------------------------------------------------------------------

describe("search jobs --title maps to body role", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.search.jobs as Mock).mockResolvedValue({ items: [], cursor: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--title 30128 → body role: ['30128']", async () => {
    const { runSearchJobs } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchJobs(client as never, { title: "30128", account: "acc_1", json: true } as SearchArgs, out);

    const body = (accountNs.search.jobs as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({ role: ["30128"] });
  });

  it("--title 30128,26089 → body role: ['30128','26089']", async () => {
    const { runSearchJobs } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchJobs(client as never, { title: "30128,26089", account: "acc_1", json: true } as SearchArgs, out);

    const body = (accountNs.search.jobs as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({ role: ["30128", "26089"] });
  });

  it("--keywords engineer --title 30128 → both keywords and role present", async () => {
    const { runSearchJobs } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchJobs(client as never, {
      keywords: "engineer",
      title: "30128",
      account: "acc_1",
      json: true,
    } as SearchArgs, out);

    const body = (accountNs.search.jobs as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({ keywords: "engineer", role: ["30128"] });
  });
});

// ---------------------------------------------------------------------------
// search jobs additional named flags
// ---------------------------------------------------------------------------

describe("search jobs: presence/benefits/commitments/has-verifications/under-10-applicants/in-your-network/fair-chance-employer", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.search.jobs as Mock).mockResolvedValue({ items: [], cursor: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--presence remote,hybrid → body presence: ['remote','hybrid']", async () => {
    const { runSearchJobs } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchJobs(client as never, { presence: "remote,hybrid", account: "acc_1", json: true } as SearchArgs, out);

    const body = (accountNs.search.jobs as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({ presence: ["remote", "hybrid"] });
  });

  it("--benefits medical_insurance → body benefits: ['medical_insurance']", async () => {
    const { runSearchJobs } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchJobs(client as never, { benefits: "medical_insurance", account: "acc_1", json: true } as SearchArgs, out);

    const body = (accountNs.search.jobs as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({ benefits: ["medical_insurance"] });
  });

  it("--commitments full_time → body commitments: ['full_time']", async () => {
    const { runSearchJobs } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchJobs(client as never, { commitments: "full_time", account: "acc_1", json: true } as SearchArgs, out);

    const body = (accountNs.search.jobs as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({ commitments: ["full_time"] });
  });

  it("--has-verifications → body has_verifications: true", async () => {
    const { runSearchJobs } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchJobs(client as never, { "has-verifications": true, account: "acc_1", json: true } as SearchArgs, out);

    const body = (accountNs.search.jobs as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({ has_verifications: true });
  });

  it("--under-10-applicants → body under_10_applicants: true", async () => {
    const { runSearchJobs } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchJobs(client as never, { "under-10-applicants": true, account: "acc_1", json: true } as SearchArgs, out);

    const body = (accountNs.search.jobs as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({ under_10_applicants: true });
  });

  it("--in-your-network → body in_your_network: true", async () => {
    const { runSearchJobs } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchJobs(client as never, { "in-your-network": true, account: "acc_1", json: true } as SearchArgs, out);

    const body = (accountNs.search.jobs as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({ in_your_network: true });
  });

  it("--fair-chance-employer → body fair_chance_employer: true", async () => {
    const { runSearchJobs } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchJobs(client as never, { "fair-chance-employer": true, account: "acc_1", json: true } as SearchArgs, out);

    const body = (accountNs.search.jobs as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({ fair_chance_employer: true });
  });

  it("all 7 flags combined → all 7 keys present together", async () => {
    const { runSearchJobs } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchJobs(client as never, {
      presence: "remote",
      benefits: "medical_insurance",
      commitments: "full_time",
      "has-verifications": true,
      "under-10-applicants": true,
      "in-your-network": true,
      "fair-chance-employer": true,
      account: "acc_1",
      json: true,
    } as SearchArgs, out);

    const body = (accountNs.search.jobs as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({
      presence: ["remote"],
      benefits: ["medical_insurance"],
      commitments: ["full_time"],
      has_verifications: true,
      under_10_applicants: true,
      in_your_network: true,
      fair_chance_employer: true,
    });
  });
});

// ---------------------------------------------------------------------------
// search people --connections-of / --followers-of → array
// ---------------------------------------------------------------------------

describe("search people: --connections-of / --followers-of comma-separated → array", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.search.people as Mock).mockResolvedValue({ items: [], cursor: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--connections-of urn:li:member:747216553 → body connections_of: [<value>] (single value wrapped in array)", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchPeople(client as never, {
      "connections-of": "urn:li:member:747216553",
      account: "acc_1",
      json: true,
    } as SearchArgs, out);

    const body = (accountNs.search.people as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({ connections_of: ["urn:li:member:747216553"] });
  });

  it("--connections-of 'id1,id2' → body connections_of: ['id1','id2']", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchPeople(client as never, { "connections-of": "id1,id2", account: "acc_1", json: true } as SearchArgs, out);

    const body = (accountNs.search.people as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({ connections_of: ["id1", "id2"] });
  });

  it("--followers-of id1 → body followers_of: ['id1']", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchPeople(client as never, { "followers-of": "id1", account: "acc_1", json: true } as SearchArgs, out);

    const body = (accountNs.search.people as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({ followers_of: ["id1"] });
  });
});

// ---------------------------------------------------------------------------
// search posts nested filter flags
// ---------------------------------------------------------------------------

describe("search posts: posted_by / mentioning / author nested filter flags merge, do not replace", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.search.posts as Mock).mockResolvedValue({ items: [], cursor: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--posted-by-member id1 → body posted_by: {member:['id1']}", async () => {
    const { runSearchPosts } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchPosts(client as never, { "posted-by-member": "id1", account: "acc_1", json: true } as SearchArgs, out);

    const body = (accountNs.search.posts as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({ posted_by: { member: ["id1"] } });
  });

  it("--posted-by-member id1 --posted-by-me → both merge into ONE posted_by object", async () => {
    const { runSearchPosts } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchPosts(client as never, {
      "posted-by-member": "id1",
      "posted-by-me": true,
      account: "acc_1",
      json: true,
    } as SearchArgs, out);

    const body = (accountNs.search.posts as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({ posted_by: { member: ["id1"], me: true } });
  });

  it("--mentioning-member id1 --mentioning-company c1 → body mentioning: {member:['id1'],company:['c1']}", async () => {
    const { runSearchPosts } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchPosts(client as never, {
      "mentioning-member": "id1",
      "mentioning-company": "c1",
      account: "acc_1",
      json: true,
    } as SearchArgs, out);

    const body = (accountNs.search.posts as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({ mentioning: { member: ["id1"], company: ["c1"] } });
  });

  it("--author-industry i1 --author-company c1 --author-keywords 'CTO' → body author: {industry:['i1'],company:['c1'],keywords:'CTO'}", async () => {
    const { runSearchPosts } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchPosts(client as never, {
      "author-industry": "i1",
      "author-company": "c1",
      "author-keywords": "CTO",
      account: "acc_1",
      json: true,
    } as SearchArgs, out);

    const body = (accountNs.search.posts as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({ author: { industry: ["i1"], company: ["c1"], keywords: "CTO" } });
  });

  it("--posted-by-member id1 --mentioning-company c1 → distinct top-level keys, not merged with each other", async () => {
    const { runSearchPosts } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchPosts(client as never, {
      "posted-by-member": "id1",
      "mentioning-company": "c1",
      account: "acc_1",
      json: true,
    } as SearchArgs, out);

    const body = (accountNs.search.posts as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({
      posted_by: { member: ["id1"] },
      mentioning: { company: ["c1"] },
    });
  });
});

// ---------------------------------------------------------------------------
// search jobs --location-within-area
// ---------------------------------------------------------------------------

describe("search jobs --location-within-area parses to a number", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.search.jobs as Mock).mockResolvedValue({ items: [], cursor: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--location-within-area 25 --location 101282230 → location_within_area: 25 (number) + region (jobs geo mapping)", async () => {
    const { runSearchJobs } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchJobs(client as never, {
      "location-within-area": "25",
      location: "101282230",
      account: "acc_1",
      json: true,
    } as SearchArgs, out);

    const body = (accountNs.search.jobs as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({ location_within_area: 25, region: "101282230" });
    expect(typeof body["location_within_area"]).toBe("number");
  });

  it("--location-within-area abc → exit 2, no SDK call (non-numeric, before any SDK call)", async () => {
    const { runSearchJobs } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    const exitSpy = makeExitMock();

    try {
      await runSearchJobs(client as never, { "location-within-area": "abc", account: "acc_1" } as SearchArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.search.jobs).not.toHaveBeenCalled();
  });
});

describe("search groups — GET, keyword-only", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.search.groups as Mock).mockResolvedValue({
      object: "group_search_result",
      items: [{ object: "group", id: "9123014", name: "GTM Engineering", member_count: 4000 }],
      cursor: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("search groups <query> — calls search.groups with keywords", async () => {
    const { runSearchGroups } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchGroups(client as never, { query: "gtm engineering", account: "acc_1", json: true } as SearchArgs, out);

    expect(accountNs.search.groups).toHaveBeenCalledWith(expect.objectContaining({ keywords: "gtm engineering" }));
  });

  it("search groups --json prints the full response shape", async () => {
    const { runSearchGroups } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchGroups(client as never, { query: "gtm", account: "acc_1", json: true } as SearchArgs, out);

    const written = JSON.parse((out.stdout.write as Mock).mock.calls[0]![0] as string);
    expect(written.items[0]).toEqual({ object: "group", id: "9123014", name: "GTM Engineering", member_count: 4000 });
  });

  it("search groups — --limit/--cursor pass through", async () => {
    const { runSearchGroups } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchGroups(
      client as never,
      { query: "gtm", account: "acc_1", limit: "5", cursor: "cur_1", json: true } as SearchArgs,
      out,
    );

    expect(accountNs.search.groups).toHaveBeenCalledWith(
      expect.objectContaining({ keywords: "gtm", limit: 5, cursor: "cur_1" }),
    );
  });

  it("search groups --all — streams NDJSON across pages", async () => {
    const { runSearchGroups } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    (accountNs.search.groups as Mock)
      .mockResolvedValueOnce({ items: [{ id: "1" }], cursor: "cur_1" })
      .mockResolvedValueOnce({ items: [{ id: "2" }], cursor: null });

    await runSearchGroups(client as never, { query: "gtm", account: "acc_1", all: true } as SearchArgs, out);

    const lines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).filter((l) => l.trim().startsWith("{"));
    expect(lines).toHaveLength(2);
  });

  it("search groups — missing <query> exits 2 before any SDK call", async () => {
    const { runSearchGroups } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    const exitSpy = makeExitMock();

    try {
      await runSearchGroups(client as never, { account: "acc_1" } as SearchArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.search.groups).not.toHaveBeenCalled();
  });

  it("search groups --preview → usage error exit 2", async () => {
    const { runSearchGroups } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    const exitSpy = makeExitMock();

    try {
      await runSearchGroups(client as never, { query: "gtm", account: "acc_1", preview: true } as SearchArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("search services — POST body", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.search.services as Mock).mockResolvedValue({
      object: "service_search_result",
      items: [{ object: "service_provider", id: "ACoAA1", name: "Jane Doe" }],
      cursor: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("search services --keywords marketing — calls search.services with keywords in the body", async () => {
    const { runSearchServices } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchServices(client as never, { keywords: "marketing", account: "acc_1", json: true } as SearchArgs, out);

    expect(accountNs.search.services).toHaveBeenCalledWith(expect.objectContaining({ keywords: "marketing" }));
  });

  it("search services --json prints the full response shape", async () => {
    const { runSearchServices } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchServices(client as never, { keywords: "marketing", account: "acc_1", json: true } as SearchArgs, out);

    const written = JSON.parse((out.stdout.write as Mock).mock.calls[0]![0] as string);
    expect(written.items[0]).toEqual({ object: "service_provider", id: "ACoAA1", name: "Jane Doe" });
  });

  it("search services --service-category/--location/--connections/--language map to the request body", async () => {
    const { runSearchServices } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchServices(
      client as never,
      {
        "service-category": "cat_1,cat_2",
        location: "loc_1",
        connections: "1,2",
        language: "en,de",
        account: "acc_1",
        json: true,
      } as SearchArgs,
      out,
    );

    expect(accountNs.search.services).toHaveBeenCalledWith(
      expect.objectContaining({
        service_category: ["cat_1", "cat_2"],
        location: ["loc_1"],
        connections: [1, 2],
        language: ["en", "de"],
      }),
    );
  });

  it("search services --all — streams NDJSON across pages", async () => {
    const { runSearchServices } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    (accountNs.search.services as Mock)
      .mockResolvedValueOnce({ items: [{ id: "1" }], cursor: "cur_1" })
      .mockResolvedValueOnce({ items: [{ id: "2" }], cursor: null });

    await runSearchServices(client as never, { keywords: "marketing", account: "acc_1", all: true } as SearchArgs, out);

    const lines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).filter((l) => l.trim().startsWith("{"));
    expect(lines).toHaveLength(2);
  });

  it("search services --preview → usage error exit 2", async () => {
    const { runSearchServices } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    const exitSpy = makeExitMock();

    try {
      await runSearchServices(client as never, { keywords: "marketing", account: "acc_1", preview: true } as SearchArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("search services — missing account exits 2", async () => {
    const { runSearchServices } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    const exitSpy = makeExitMock();

    try {
      await runSearchServices(client as never, { keywords: "marketing", json: true } as SearchArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("search service-parameters — GET, not paginated", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.search.getServiceParameters as Mock).mockResolvedValue({
      object: "search_parameter_list",
      items: [{ id: "cat_1", name: "Marketing" }],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("search service-parameters --keywords marke --type service_category — calls getServiceParameters", async () => {
    const { runSearchServiceParameters } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchServiceParameters(
      client as never,
      { keywords: "marke", type: "service_category", account: "acc_1", json: true } as SearchArgs,
      out,
    );

    expect(accountNs.search.getServiceParameters).toHaveBeenCalledWith(
      expect.objectContaining({ keywords: "marke", type: "service_category" }),
    );
  });

  it("search service-parameters — --type omitted still calls the SDK (server defaults to service_category)", async () => {
    const { runSearchServiceParameters } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runSearchServiceParameters(client as never, { keywords: "berlin", account: "acc_1", json: true } as SearchArgs, out);

    expect(accountNs.search.getServiceParameters).toHaveBeenCalledWith(
      expect.objectContaining({ keywords: "berlin" }),
    );
    const call = (accountNs.search.getServiceParameters as Mock).mock.calls[0]![0] as Record<string, unknown>;
    expect(call).not.toHaveProperty("type");
  });

  it("search service-parameters — missing --keywords exits 2 before any SDK call", async () => {
    const { runSearchServiceParameters } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    const exitSpy = makeExitMock();

    try {
      await runSearchServiceParameters(client as never, { type: "location", account: "acc_1" } as SearchArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.search.getServiceParameters).not.toHaveBeenCalled();
  });

  it("search service-parameters --preview → usage error exit 2", async () => {
    const { runSearchServiceParameters } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    const exitSpy = makeExitMock();

    try {
      await runSearchServiceParameters(
        client as never,
        { keywords: "marke", account: "acc_1", preview: true } as SearchArgs,
        out,
      );
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("search service-parameters --all → usage error exit 2 (not paginated)", async () => {
    const { runSearchServiceParameters } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    const exitSpy = makeExitMock();

    try {
      await runSearchServiceParameters(
        client as never,
        { keywords: "marke", account: "acc_1", all: true } as SearchArgs,
        out,
      );
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

/**
 * The CLI renderer must not drop a response's top-level `notices[]` —
 * covering both a filter value that took the id fast path (field + value
 * present) and a page whose results are anonymised upstream (page-scoped,
 * no field/value). These drive the actual shipped command handler
 * (`runSearchPeople`) against a mocked SDK response, the same boundary the
 * real CLI crosses when the server returns notices, and assert on the real
 * bytes written to stdout, not on an intermediate formatter call.
 */
describe("search people: renders notices[] from the SDK response", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;
  const originalIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.stdout.isTTY = originalIsTTY;
  });

  // filter-value shape: a filter value took the id fast path (field + value present).
  const filterNotice = {
    code: "FILTER_VALUE_UNCHECKED",
    message: "The value was treated as an id and was not looked up.",
    field: "industry",
    value: "42",
  };

  // page-scope shape: page-scoped, no field/value (an anonymised-results page).
  const pageNotice = {
    code: "ALL_RESULTS_HIDDEN",
    message: "Every result on this page is hidden from the connected account.",
  };

  it("--json: the response's notices[] array reaches stdout intact (filter-value shape: field + value)", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    (accountNs.search.people as Mock).mockResolvedValue({
      items: [],
      cursor: null,
      notices: [filterNotice],
    });

    await runSearchPeople(client as never, {
      account: "acc_1",
      industry: "42",
      json: true,
    } as SearchArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written) as { notices?: unknown[] };
    expect(parsed.notices).toEqual([filterNotice]);
  });

  it("--json: the response's notices[] array reaches stdout intact (page-scope shape: page-scoped, no field/value)", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    (accountNs.search.people as Mock).mockResolvedValue({
      items: [{ id: "p_1", full_name: "LinkedIn Member", visibility: "hidden" }],
      cursor: null,
      notices: [pageNotice],
    });

    await runSearchPeople(client as never, {
      account: "acc_1",
      keywords: "ai",
      json: true,
    } as SearchArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written) as { notices?: unknown[] };
    expect(parsed.notices).toEqual([pageNotice]);
  });

  it("human mode (TTY, no --json): a notice renders as visible text on stdout, not silently dropped", async () => {
    process.stdout.isTTY = true;
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    (accountNs.search.people as Mock).mockResolvedValue({
      items: [],
      cursor: null,
      notices: [filterNotice],
    });

    await runSearchPeople(client as never, {
      account: "acc_1",
      industry: "42",
      json: false,
    } as SearchArgs, out);

    const rendered = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    expect(rendered).toContain("FILTER_VALUE_UNCHECKED");
    expect(rendered).toContain("The value was treated as an id and was not looked up.");
    expect(rendered).toContain("field: industry");
    expect(rendered).toContain("value: 42");
  });

  it("human mode (TTY, no --json): an all-hidden page (page-scope notice) still tells the user something was returned, not just an empty list", async () => {
    process.stdout.isTTY = true;
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    (accountNs.search.people as Mock).mockResolvedValue({
      items: [],
      cursor: null,
      notices: [pageNotice],
    });

    await runSearchPeople(client as never, {
      account: "acc_1",
      keywords: "ai",
      json: false,
    } as SearchArgs, out);

    const rendered = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    expect(rendered).toContain("ALL_RESULTS_HIDDEN");
    expect(rendered).toContain("Every result on this page is hidden from the connected account.");
  });

  it("human mode (TTY, no --json): a partly-hidden page marks the hidden row AND surfaces the page notice, the full reported harm", async () => {
    process.stdout.isTTY = true;
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    (accountNs.search.people as Mock).mockResolvedValue({
      items: [
        { id: "p_1", full_name: "LinkedIn Member", public_identifier: null, headline: null, location: null, network_distance: "OUT_OF_NETWORK", visibility: "hidden" },
      ],
      cursor: null,
      notices: [{
        code: "SOME_RESULTS_HIDDEN",
        message: "Some results on this page are hidden from the connected account.",
      }],
    });

    await runSearchPeople(client as never, {
      account: "acc_1",
      keywords: "ai",
      json: false,
    } as SearchArgs, out);

    const rendered = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    // The page-level explanation is present...
    expect(rendered).toContain("SOME_RESULTS_HIDDEN");
    // ...AND the row itself carries the discriminator, not just an unmarked
    // "LinkedIn Member" name with nothing telling the user it is unusable.
    expect(rendered).toContain("visibility: hidden");
  });

  it("REGRESSION: a response with no notices renders byte-identically in --json mode", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const { slimSearchPeople } = await import("../../src/lib/slim.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    const response = { items: [{ id: "p_1", full_name: "Alice", public_identifier: "alice", headline: null, location: null, network_distance: "FIRST_DEGREE" }], cursor: null };
    (accountNs.search.people as Mock).mockResolvedValue(response);

    await runSearchPeople(client as never, {
      account: "acc_1",
      keywords: "ai",
      json: true,
    } as SearchArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    // Compared against the existing slim-projection output (unaffected by this
    // fix), not a hand-typed literal, so key ordering from `slimSearchPeople`
    // does not create a spurious mismatch unrelated to notices.
    expect(written).toBe(JSON.stringify(slimSearchPeople(response)) + "\n");
    expect(written).not.toContain("notice");
  });

  it("REGRESSION: a response with no notices renders byte-identically in human mode", async () => {
    process.stdout.isTTY = true;
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    (accountNs.search.people as Mock).mockResolvedValue({
      items: [{ id: "p_1", public_identifier: "alice", full_name: "Alice", headline: null, location: null, network_distance: "FIRST_DEGREE", visibility: "full" }],
      cursor: null,
    });

    await runSearchPeople(client as never, {
      account: "acc_1",
      keywords: "ai",
      json: false,
    } as SearchArgs, out);

    const rendered = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    expect(rendered).not.toContain("notice");
    expect(rendered).toBe(
      "id: p_1\npublic_identifier: alice\nfull_name: Alice\nheadline: null\nlocation: null\nnetwork_distance: FIRST_DEGREE\nvisibility: full\n",
    );
  });

  it("--all: a page's notices[] reach stderr (diagnostics), and stdout stays pure NDJSON data", async () => {
    const { runSearchPeople } = await import("../../src/commands/search.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    (accountNs.search.people as Mock).mockResolvedValueOnce({
      items: [],
      cursor: null,
      notices: [pageNotice],
    });

    await runSearchPeople(client as never, {
      account: "acc_1",
      keywords: "ai",
      all: true,
    } as SearchArgs, out);

    const stderrText = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    expect(stderrText).toContain("ALL_RESULTS_HIDDEN");
    const stdoutText = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    expect(stdoutText).not.toContain("ALL_RESULTS_HIDDEN");
  });
});
