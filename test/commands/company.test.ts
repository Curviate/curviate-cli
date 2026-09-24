/**
 * Tests for the `company` command group.
 *
 * Covers:
 *   company <id>                    → companies.get (retrieve, hard-moved off profiles.getCompany)
 *   company employees <id>          → companies.employees (facade, --keywords/--location)
 *   company posts <id>              → companies.posts (facade)
 *   company jobs <id>               → companies.jobs (facade, --keywords)
 *   company reply <id> <chat_id> "<text>" [--attach] → companies.sendMessage (reply as the page)
 *   --preview/--all/--sections usage errors (read-command conventions)
 *   --account required (companies.get now always requires account_id)
 *   wrong usage: a non-numeric identifier on a sub-resource surfaces the
 *     server's 400 INVALID_REQUEST as exit 2 (the CLI does not duplicate the
 *     server-side ^\d+$ guard client-side)
 *   slim projection (default mode) + --verbose (full SDK response) for retrieve
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CurviateError } from "@curviate/sdk";
import { noConnectedAccounts } from "../helpers/no-connected-accounts.js";

function makeInvalidRequestError() {
  return new CurviateError({
    code: "INVALID_REQUEST",
    message: "identifier must be numeric.",
    httpStatus: 400,
    userFixable: true,
    retryLikelyToSucceed: false,
  });
}

function makeAccountNs() {
  return {
    companies: {
      get: vi.fn(),
      employees: vi.fn(),
      posts: vi.fn(),
      jobs: vi.fn(),
      invitableFollowers: vi.fn(),
      followInvite: vi.fn(),
      sendMessage: vi.fn(),
    },
  };
}

function makeClient(accountNs: ReturnType<typeof makeAccountNs>) {
  return {
    account: vi.fn().mockReturnValue(accountNs),
  };
}

type CompanyArgs = {
  id?: string;
  account?: string;
  json?: boolean;
  preview?: boolean;
  all?: boolean;
  "api-key"?: string;
  "base-url"?: string;
  timeout?: string;
  profile?: string;
  fields?: string;
  limit?: string;
  cursor?: string;
  "max-pages"?: string;
  verbose?: boolean;
  sections?: string;
  keywords?: string;
  location?: string;
  invitee?: string | string[];
  chatId?: string;
  text?: string;
  attach?: string | string[];
};

function makeOut() {
  return { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
}

function mockExit() {
  return vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new Error(`process.exit(${code})`);
  });
}

// ---------------------------------------------------------------------------
// company <id> (retrieve)
// ---------------------------------------------------------------------------

describe("company command (retrieve)", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.companies.get as Mock).mockResolvedValue({ id: "112013061", object: "company_profile" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("company <id> --account <id> — calls companies.get with the resolved slug", async () => {
    const { runCompanyGet } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyGet(client as never, { id: "https://www.linkedin.com/company/t-systems/about/", account: "acc_1", json: true } as CompanyArgs, out);

    expect(client.account).toHaveBeenCalledWith("acc_1");
    expect(accountNs.companies.get).toHaveBeenCalledWith("t-systems");
  });

  it("company <id> — a numeric id passes through unchanged", async () => {
    const { runCompanyGet } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyGet(client as never, { id: "112013061", account: "acc_1", json: true } as CompanyArgs, out);

    expect(accountNs.companies.get).toHaveBeenCalledWith("112013061");
  });

  it("company <id> without --account → exit 2 (account_id is now required)", async () => {
    const { runCompanyGet } = await import("../../src/commands/company.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runCompanyGet(noConnectedAccounts(client) as never, { id: "t-systems", json: true } as CompanyArgs, out);
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.companies.get).not.toHaveBeenCalled();
  });

  it("company --all → usage error exit 2 (non-paginated)", async () => {
    const { runCompanyGet } = await import("../../src/commands/company.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runCompanyGet(client as never, { id: "t-systems", account: "acc_1", all: true } as CompanyArgs, out);
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("company --sections → usage error exit 2 (sections not supported on company commands)", async () => {
    const { runCompanyGet } = await import("../../src/commands/company.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runCompanyGet(client as never, { id: "t-systems", account: "acc_1", sections: "skills" } as CompanyArgs, out);
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
      expect((out.stderr.write as Mock).mock.calls.join("")).toContain("--sections");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("a 404 RESOURCE_NOT_FOUND (unknown identifier) surfaces as exit 4", async () => {
    const notFoundErr = new CurviateError({
      code: "RESOURCE_NOT_FOUND",
      message: "Company not found.",
      httpStatus: 404,
      userFixable: false,
      retryLikelyToSucceed: false,
    });
    (accountNs.companies.get as Mock).mockRejectedValue(notFoundErr);

    const { runCompanyGet } = await import("../../src/commands/company.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runCompanyGet(client as never, { id: "urn:li:organization:1", account: "acc_1", json: true } as CompanyArgs, out);
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(4)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// slim mode (no --verbose) — unaffected by the retrieve hard-move
// ---------------------------------------------------------------------------

describe("company slim mode (no --verbose)", () => {
  // Real v2 CompanyProfile shape — employee_count/employee_count_range live
  // nested at insights.headcount/insights.headcount_range.from, the
  // establishment date is a bare year at establishment_year, follower_count
  // is singular, and there is no messaging field on this resource at all.
  const richCompany = {
    id: "co_123",
    name: "Acme Corp",
    public_identifier: "acme-corp",
    profile_url: "https://linkedin.com/company/acme-corp",
    industry: ["Technology"],
    website: "https://acme.com",
    establishment_year: 2000,
    locations: [
      { city: "Austin", country_code: "US", postal_code: "78701", area: "TX", is_headquarter: true },
    ],
    insights: { headcount: 500, headcount_range: { from: 201 } },
    follower_count: 12000,
    viewer_permissions: { can_send_message: false },
    description: "A company description",
    activities: [{ id: "act_1" }],
  };

  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.companies.get as Mock).mockResolvedValue(richCompany);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("slim output has exactly the 11 fields", async () => {
    const { runCompanyGet } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyGet(client as never, { id: "acme-corp", account: "acc_1", json: true } as CompanyArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as Record<string, unknown>;
    expect(Object.keys(result)).toHaveLength(11);
    expect(result["employee_count"]).toBe(500);
    expect(result["employee_count_range"]).toEqual({ from: 201 });
    expect(result["establishment_year"]).toBe(2000);
    expect(result["follower_count"]).toBe(12000);
    expect(result).not.toHaveProperty("messaging");
  });

  it("headquarters synthesized from is_headquarter location", async () => {
    const { runCompanyGet } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyGet(client as never, { id: "acme-corp", account: "acc_1", json: true } as CompanyArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as Record<string, unknown>;
    expect(result["headquarters"]).toEqual({ city: "Austin", country_code: "US", postal_code: "78701", area: "TX" });
  });
});

// ---------------------------------------------------------------------------
// --verbose mode
// ---------------------------------------------------------------------------

describe("company --verbose mode", () => {
  const richCompany = {
    id: "co_123",
    name: "Acme Corp",
    viewer_permissions: { can_send_message: false },
    description: "A company description",
    locations: [{ city: "Austin", country: "US", is_headquarter: true }],
  };

  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.companies.get as Mock).mockResolvedValue(richCompany);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--verbose returns full SDK response including viewer_permissions, locations array", async () => {
    const { runCompanyGet } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyGet(
      client as never,
      { id: "acme-corp", account: "acc_1", json: true, verbose: true } as CompanyArgs,
      out,
    );

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as Record<string, unknown>;
    expect(result).toHaveProperty("viewer_permissions");
    expect(result).toHaveProperty("description");
    expect(result).toHaveProperty("locations");
  });
});

// ---------------------------------------------------------------------------
// company employees <id>
// ---------------------------------------------------------------------------

describe("company employees command", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.companies.employees as Mock).mockResolvedValue({
      object: "company_employee_list",
      items: [{ id: "ACoA1", public_identifier: "frank", full_name: "Frank Employee", headline: "Engineer", location: "Berlin", network_distance: null }],
      paging: { total_count: 1 },
      cursor: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("company employees <cid> --account <id> --keywords engineer — forwards keywords/location/limit/cursor", async () => {
    const { runCompanyEmployees } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyEmployees(client as never, {
      id: "112013061",
      account: "acc_1",
      json: true,
      keywords: "engineer",
      location: "reg_1",
      limit: "5",
      cursor: "cur_0",
    } as CompanyArgs, out);

    expect(accountNs.companies.employees).toHaveBeenCalledWith("112013061", {
      limit: 5,
      cursor: "cur_0",
      keywords: "engineer",
      location: "reg_1",
    });
  });

  it("prints the employee list (slim projection keeps paging/cursor)", async () => {
    const { runCompanyEmployees } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyEmployees(client as never, { id: "112013061", account: "acc_1", json: true } as CompanyArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as Record<string, unknown>;
    expect(result["object"]).toBe("company_employee_list");
    expect((result["items"] as unknown[])).toHaveLength(1);
    expect(result["paging"]).toEqual({ total_count: 1 });
    expect(result["cursor"]).toBeNull();
  });

  it("company employees <slug> resolves the slug to the numeric id via companies.get, then lists (D4b)", async () => {
    (accountNs.companies.get as Mock).mockResolvedValue({ id: "112013061", object: "company_profile" });

    const { runCompanyEmployees } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyEmployees(client as never, { id: "t-systems", account: "acc_1", json: true } as CompanyArgs, out);

    // Slug is resolved to the numeric provider_id first (mirrors bare `company <slug>`),
    // then the sub-resource is called with the numeric id — not the raw slug.
    expect(accountNs.companies.get).toHaveBeenCalledWith("t-systems");
    expect(accountNs.companies.employees).toHaveBeenCalledWith("112013061", {});
  });

  it("company employees <url> normalizes the URL to a slug, resolves it, then lists (D4b)", async () => {
    (accountNs.companies.get as Mock).mockResolvedValue({ id: "112013061" });

    const { runCompanyEmployees } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyEmployees(client as never, { id: "https://www.linkedin.com/company/t-systems/about/", account: "acc_1", json: true } as CompanyArgs, out);

    expect(accountNs.companies.get).toHaveBeenCalledWith("t-systems");
    expect(accountNs.companies.employees).toHaveBeenCalledWith("112013061", {});
  });

  it("company employees <numeric-id> passes through with NO extra companies.get call (D4b)", async () => {
    const { runCompanyEmployees } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyEmployees(client as never, { id: "112013061", account: "acc_1", json: true } as CompanyArgs, out);

    expect(accountNs.companies.get).not.toHaveBeenCalled();
    expect(accountNs.companies.employees).toHaveBeenCalledWith("112013061", {});
  });

  it("an unresolvable identifier surfaces companies.get's 404 as exit 4, no employees call (D4b)", async () => {
    const notFound = new CurviateError({
      code: "RESOURCE_NOT_FOUND",
      message: "Company not found.",
      httpStatus: 404,
      userFixable: false,
      retryLikelyToSucceed: false,
    });
    (accountNs.companies.get as Mock).mockRejectedValue(notFound);

    const { runCompanyEmployees } = await import("../../src/commands/company.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runCompanyEmployees(client as never, { id: "no-such-company", account: "acc_1", json: true } as CompanyArgs, out);
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(4)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.companies.employees).not.toHaveBeenCalled();
  });

  it("a genuinely invalid identifier surfaces companies.get's 400 INVALID_REQUEST as exit 2 (D4b)", async () => {
    (accountNs.companies.get as Mock).mockRejectedValue(makeInvalidRequestError());

    const { runCompanyEmployees } = await import("../../src/commands/company.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runCompanyEmployees(client as never, { id: "@@bad@@", account: "acc_1", json: true } as CompanyArgs, out);
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.companies.employees).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// company posts <id>
// ---------------------------------------------------------------------------

describe("company posts command", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.companies.posts as Mock).mockResolvedValue({
      object: "company_post_list",
      items: [{ id: "urn:li:activity:1", text: "We are hiring!", reaction_count: 1, comment_count: 0, author: { name: "Acme" } }],
      paging: { total_count: 1 },
      cursor: "cur_1",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("company posts <cid> --account <id> --limit 3 — forwards limit as the only filter", async () => {
    const { runCompanyPosts } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyPosts(client as never, { id: "112013061", account: "acc_1", json: true, limit: "3" } as CompanyArgs, out);

    expect(accountNs.companies.posts).toHaveBeenCalledWith("112013061", { limit: 3 });
  });

  it("prints post text verbatim (content pass-through)", async () => {
    const { runCompanyPosts } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyPosts(client as never, { id: "112013061", account: "acc_1", json: true } as CompanyArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as Record<string, unknown>;
    const items = result["items"] as Array<Record<string, unknown>>;
    expect(items[0]?.["text"]).toBe("We are hiring!");
  });

  it("D13: item.id surfaces in slim --json output (the v2 wire's only identifier field — not post_urn, which was never real)", async () => {
    const { runCompanyPosts } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyPosts(client as never, { id: "112013061", account: "acc_1", json: true } as CompanyArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as Record<string, unknown>;
    const items = result["items"] as Array<Record<string, unknown>>;
    expect(items[0]?.["id"]).toBe("urn:li:activity:1");
    expect(items[0]).not.toHaveProperty("post_urn");
    expect(items[0]).not.toHaveProperty("posted_at");
  });

  it("D13: --fields id,author.name projects the real v2 keys (not the v1 post_urn)", async () => {
    const { runCompanyPosts } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyPosts(
      client as never,
      { id: "112013061", account: "acc_1", json: true, fields: "id,author.name" } as CompanyArgs,
      out,
    );

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as Record<string, unknown>;
    const items = result["items"] as Array<Record<string, unknown>>;
    expect(items[0]).toEqual({ id: "urn:li:activity:1", "author.name": "Acme" });
  });

  it("company posts <slug> resolves the slug to the numeric id via companies.get, then lists (D4b)", async () => {
    (accountNs.companies.get as Mock).mockResolvedValue({ id: "112013061" });

    const { runCompanyPosts } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyPosts(client as never, { id: "t-systems", account: "acc_1", json: true } as CompanyArgs, out);

    expect(accountNs.companies.get).toHaveBeenCalledWith("t-systems");
    expect(accountNs.companies.posts).toHaveBeenCalledWith("112013061", {});
  });
});

// ---------------------------------------------------------------------------
// company jobs <id>
// ---------------------------------------------------------------------------

describe("company jobs command", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.companies.jobs as Mock).mockResolvedValue({
      object: "company_job_list",
      items: [{ job_urn: "urn:li:job:1", title: "Founders Associate", location: "Berlin", posted_at: "2026-06-01", easy_apply: true, company: { name: "Acme" } }],
      paging: { total_count: 1 },
      cursor: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("company jobs <cid> --account <id> --keywords founder — forwards keywords", async () => {
    const { runCompanyJobs } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyJobs(client as never, { id: "112013061", account: "acc_1", json: true, keywords: "founder" } as CompanyArgs, out);

    expect(accountNs.companies.jobs).toHaveBeenCalledWith("112013061", { keywords: "founder" });
  });

  it("a valid-empty jobs result is not treated as an error", async () => {
    (accountNs.companies.jobs as Mock).mockResolvedValue({ object: "company_job_list", items: [], paging: { total_count: 0 }, cursor: null });

    const { runCompanyJobs } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyJobs(client as never, { id: "112013061", account: "acc_1", json: true } as CompanyArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as Record<string, unknown>;
    expect(result["items"]).toEqual([]);
    expect(result["paging"]).toEqual({ total_count: 0 });
  });

  it("company jobs <slug> resolves the slug to the numeric id via companies.get, then lists (D4b)", async () => {
    (accountNs.companies.get as Mock).mockResolvedValue({ id: "112013061" });

    const { runCompanyJobs } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyJobs(client as never, { id: "t-systems", account: "acc_1", json: true } as CompanyArgs, out);

    expect(accountNs.companies.get).toHaveBeenCalledWith("t-systems");
    expect(accountNs.companies.jobs).toHaveBeenCalledWith("112013061", {});
  });
});

// ---------------------------------------------------------------------------
// company invitable-followers <id>
// ---------------------------------------------------------------------------

describe("company invitable-followers command", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.companies.invitableFollowers as Mock).mockResolvedValue({
      object: "invitable_connection_list",
      items: [
        { object: "invitable_connection", id: "ACoA1", profile_urn: "urn:li:fsd_profile:ACoA1", invite_token: "raw-token-bytes" },
        { object: "invitable_connection", id: "ACoA2", profile_urn: "urn:li:fsd_profile:ACoA2", invite_token: null },
      ],
      cursor: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("company invitable-followers <cid> --account <id> --limit 5 --cursor cur_0 — forwards limit/cursor only", async () => {
    const { runCompanyInvitableFollowers } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyInvitableFollowers(client as never, {
      id: "112013061",
      account: "acc_1",
      json: true,
      limit: "5",
      cursor: "cur_0",
    } as CompanyArgs, out);

    expect(accountNs.companies.invitableFollowers).toHaveBeenCalledWith("112013061", { limit: 5, cursor: "cur_0" });
  });

  it("re-encodes invite_token as base64 in default (slim) output; null passes through unchanged", async () => {
    const { runCompanyInvitableFollowers } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyInvitableFollowers(client as never, { id: "112013061", account: "acc_1", json: true } as CompanyArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as Record<string, unknown>;
    const items = result["items"] as Array<Record<string, unknown>>;
    expect(items[0]?.["invite_token"]).toBe(Buffer.from("raw-token-bytes", "utf8").toString("base64"));
    expect(items[0]?.["id"]).toBe("ACoA1");
    expect(items[1]?.["invite_token"]).toBeNull();
  });

  it("re-encodes invite_token even under --verbose (raw bytes are never re-exposed in any output mode)", async () => {
    const { runCompanyInvitableFollowers } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyInvitableFollowers(client as never, { id: "112013061", account: "acc_1", json: true, verbose: true } as CompanyArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as Record<string, unknown>;
    const items = result["items"] as Array<Record<string, unknown>>;
    expect(items[0]?.["invite_token"]).toBe(Buffer.from("raw-token-bytes", "utf8").toString("base64"));
    // --verbose still surfaces the full envelope (object/profile_urn), unlike a hand-picked slim subset.
    expect(result["object"]).toBe("invitable_connection_list");
    expect(items[0]?.["profile_urn"]).toBe("urn:li:fsd_profile:ACoA1");
  });

  it("--all streams NDJSON with invite_token re-encoded per item", async () => {
    const { runCompanyInvitableFollowers } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyInvitableFollowers(client as never, { id: "112013061", account: "acc_1", json: true, all: true } as CompanyArgs, out);

    const lines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).filter((s) => s.trim().length > 0);
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(first["invite_token"]).toBe(Buffer.from("raw-token-bytes", "utf8").toString("base64"));
  });

  it("company invitable-followers <slug> resolves the slug to the numeric id via companies.get first", async () => {
    (accountNs.companies.get as Mock).mockResolvedValue({ id: "112013061" });

    const { runCompanyInvitableFollowers } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyInvitableFollowers(client as never, { id: "t-systems", account: "acc_1", json: true } as CompanyArgs, out);

    expect(accountNs.companies.get).toHaveBeenCalledWith("t-systems");
    expect(accountNs.companies.invitableFollowers).toHaveBeenCalledWith("112013061", {});
  });

  it("company invitable-followers <numeric-id> passes through with NO extra companies.get call", async () => {
    const { runCompanyInvitableFollowers } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyInvitableFollowers(client as never, { id: "112013061", account: "acc_1", json: true } as CompanyArgs, out);

    expect(accountNs.companies.get).not.toHaveBeenCalled();
  });

  it("without --account → exit 2", async () => {
    const { runCompanyInvitableFollowers } = await import("../../src/commands/company.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runCompanyInvitableFollowers(noConnectedAccounts(client) as never, { id: "112013061", json: true } as CompanyArgs, out);
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// company follow-invite <id> --invitee <AC…>
// ---------------------------------------------------------------------------

describe("company follow-invite command", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.companies.followInvite as Mock).mockResolvedValue({
      object: "company_follow_invite_result",
      results: [
        { object: "company_follow_invite", invitee_id: "ACoA1", status: "invited", invitation_id: "urn:li:fsd_invitation:1", error: null },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("company follow-invite <cid> --invitee AC1 --account <id> — calls companies.followInvite with the resolved id + invitee_ids", async () => {
    const { runCompanyFollowInvite } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyFollowInvite(client as never, { id: "112013061", account: "acc_1", json: true, invitee: "ACoA1" } as CompanyArgs, out);

    expect(accountNs.companies.followInvite).toHaveBeenCalledWith("112013061", { invitee_ids: ["ACoA1"] });
  });

  it("repeatable --invitee (array shape from citty) collects into invitee_ids in order", async () => {
    const { runCompanyFollowInvite } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyFollowInvite(client as never, {
      id: "112013061",
      account: "acc_1",
      json: true,
      invitee: ["ACoA1", "ACoA2", "ACoA3"],
    } as CompanyArgs, out);

    expect(accountNs.companies.followInvite).toHaveBeenCalledWith("112013061", { invitee_ids: ["ACoA1", "ACoA2", "ACoA3"] });
  });

  it("prints the partial-success result envelope on success", async () => {
    const { runCompanyFollowInvite } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyFollowInvite(client as never, { id: "112013061", account: "acc_1", json: true, invitee: "ACoA1" } as CompanyArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as Record<string, unknown>;
    expect(result["object"]).toBe("company_follow_invite_result");
    expect((result["results"] as unknown[])).toHaveLength(1);
  });

  it("no --invitee at all → usage error exit 2, no SDK call (min 1 required)", async () => {
    const { runCompanyFollowInvite } = await import("../../src/commands/company.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runCompanyFollowInvite(client as never, { id: "112013061", account: "acc_1", json: true } as CompanyArgs, out);
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.companies.followInvite).not.toHaveBeenCalled();
  });

  it("without --account → exit 2, no SDK call", async () => {
    const { runCompanyFollowInvite } = await import("../../src/commands/company.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runCompanyFollowInvite(noConnectedAccounts(client) as never, { id: "112013061", json: true, invitee: "ACoA1" } as CompanyArgs, out);
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.companies.followInvite).not.toHaveBeenCalled();
  });

  it("--preview renders the resolved request (resolved numeric id) WITHOUT calling followInvite", async () => {
    (accountNs.companies.get as Mock).mockResolvedValue({ id: "112013061" });

    const { runCompanyFollowInvite } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyFollowInvite(client as never, {
      id: "t-systems",
      account: "acc_1",
      json: true,
      preview: true,
      invitee: ["ACoA1", "ACoA2"],
    } as CompanyArgs, out);

    expect(accountNs.companies.get).toHaveBeenCalledWith("t-systems");
    expect(accountNs.companies.followInvite).not.toHaveBeenCalled();

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const preview = JSON.parse(written) as Record<string, unknown>;
    expect(preview["method"]).toBe("companies.followInvite");
    expect(preview["args"]).toEqual({ identifier: "112013061" });
    expect(preview["body"]).toEqual({ invitee_ids: ["ACoA1", "ACoA2"] });
    expect(preview["account"]).toBe("acc_1");
  });

  it("company follow-invite <slug> resolves the slug to the numeric id via companies.get, then sends", async () => {
    (accountNs.companies.get as Mock).mockResolvedValue({ id: "112013061" });

    const { runCompanyFollowInvite } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyFollowInvite(client as never, { id: "t-systems", account: "acc_1", json: true, invitee: "ACoA1" } as CompanyArgs, out);

    expect(accountNs.companies.get).toHaveBeenCalledWith("t-systems");
    expect(accountNs.companies.followInvite).toHaveBeenCalledWith("112013061", { invitee_ids: ["ACoA1"] });
  });

  it("company follow-invite <numeric-id> passes through with NO extra companies.get call", async () => {
    const { runCompanyFollowInvite } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyFollowInvite(client as never, { id: "112013061", account: "acc_1", json: true, invitee: "ACoA1" } as CompanyArgs, out);

    expect(accountNs.companies.get).not.toHaveBeenCalled();
  });

  it("a 403 RESOURCE_ACCESS_RESTRICTED (not an admin / no invite rights) surfaces as exit 8", async () => {
    const restrictedErr = new CurviateError({
      code: "RESOURCE_ACCESS_RESTRICTED",
      message: "Account does not administer this page with invite rights.",
      httpStatus: 403,
      userFixable: false,
      retryLikelyToSucceed: false,
    });
    (accountNs.companies.followInvite as Mock).mockRejectedValue(restrictedErr);

    const { runCompanyFollowInvite } = await import("../../src/commands/company.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runCompanyFollowInvite(client as never, { id: "112013061", account: "acc_1", json: true, invitee: "ACoA1" } as CompanyArgs, out);
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(8)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("a genuinely invalid identifier surfaces companies.get's 400 INVALID_REQUEST as exit 2, no followInvite call", async () => {
    (accountNs.companies.get as Mock).mockRejectedValue(makeInvalidRequestError());

    const { runCompanyFollowInvite } = await import("../../src/commands/company.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runCompanyFollowInvite(client as never, { id: "@@bad@@", account: "acc_1", json: true, invitee: "ACoA1" } as CompanyArgs, out);
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.companies.followInvite).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// company reply <id> <chat_id> "<text>" [--attach]
// ---------------------------------------------------------------------------

describe("company reply command", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;
  let tmpDir: string;

  beforeEach(async () => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.companies.sendMessage as Mock).mockResolvedValue({
      object: "message_sent",
      message_id: "msg_1",
      sent_as: { kind: "company", company_id: "112013061", name: "RedHire" },
    });
    tmpDir = await mkdtemp(join(tmpdir(), "curviate-test-company-reply-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("company reply <cid> <chat_id> '<text>' --account <id> — calls companies.sendMessage with the resolved id, chat_id verbatim, and text", async () => {
    const { runCompanyReply } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyReply(client as never, {
      id: "112013061",
      chatId: "2-YTQ3ODU3Njgt",
      text: "Thanks for reaching out!",
      account: "acc_1",
      json: true,
    } as CompanyArgs, out);

    expect(accountNs.companies.sendMessage).toHaveBeenCalledWith(
      "112013061",
      "2-YTQ3ODU3Njgt",
      expect.objectContaining({ text: "Thanks for reaching out!" }),
    );
  });

  it("<chat_id> passes through verbatim — no URL/thread normalization applied (unlike message send)", async () => {
    const { runCompanyReply } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyReply(client as never, {
      id: "112013061",
      chatId: "2-abc",
      text: "hi",
      account: "acc_1",
      json: true,
    } as CompanyArgs, out);

    expect(accountNs.companies.sendMessage).toHaveBeenCalledWith("112013061", "2-abc", expect.anything());
  });

  it("company reply <slug> <chat_id> '<text>' resolves the slug to the numeric id via companies.get first", async () => {
    (accountNs.companies.get as Mock).mockResolvedValue({ id: "112013061" });

    const { runCompanyReply } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyReply(client as never, {
      id: "t-systems",
      chatId: "2-YTQ3ODU3Njgt",
      text: "hi",
      account: "acc_1",
      json: true,
    } as CompanyArgs, out);

    expect(accountNs.companies.get).toHaveBeenCalledWith("t-systems");
    expect(accountNs.companies.sendMessage).toHaveBeenCalledWith("112013061", "2-YTQ3ODU3Njgt", expect.anything());
  });

  it("company reply <numeric-id> ... passes through with NO extra companies.get call", async () => {
    const { runCompanyReply } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyReply(client as never, {
      id: "112013061",
      chatId: "2-YTQ3ODU3Njgt",
      text: "hi",
      account: "acc_1",
      json: true,
    } as CompanyArgs, out);

    expect(accountNs.companies.get).not.toHaveBeenCalled();
  });

  it("--attach <file> — passes base64 payload in attachments (v2: no multipart)", async () => {
    const { runCompanyReply } = await import("../../src/commands/company.js");
    const out = makeOut();

    const filePath = join(tmpDir, "img.png");
    await writeFile(filePath, "imgdata");

    await runCompanyReply(client as never, {
      id: "112013061",
      chatId: "2-YTQ3ODU3Njgt",
      text: "see attached",
      attach: filePath,
      account: "acc_1",
      json: true,
    } as CompanyArgs, out);

    const callArgs = (accountNs.companies.sendMessage as Mock).mock.calls[0]![2] as Record<string, unknown>;
    const attachments = callArgs["attachments"] as Array<Record<string, unknown>>;
    expect(attachments[0]).toEqual({
      content: Buffer.from("imgdata").toString("base64"),
      content_type: "image/png",
      filename: "img.png",
    });
  });

  it("--attach <missing> — exits 2, no SDK call", async () => {
    const { runCompanyReply } = await import("../../src/commands/company.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runCompanyReply(client as never, {
        id: "112013061",
        chatId: "2-YTQ3ODU3Njgt",
        text: "hi",
        attach: join(tmpDir, "ghost.png"),
        account: "acc_1",
      } as CompanyArgs, out);
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.companies.sendMessage).not.toHaveBeenCalled();
  });

  it("--preview renders the resolved request (resolved numeric id, chat_id, text) WITHOUT calling sendMessage", async () => {
    (accountNs.companies.get as Mock).mockResolvedValue({ id: "112013061" });

    const { runCompanyReply } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyReply(client as never, {
      id: "t-systems",
      chatId: "2-YTQ3ODU3Njgt",
      text: "preview this",
      account: "acc_1",
      json: true,
      preview: true,
    } as CompanyArgs, out);

    expect(accountNs.companies.get).toHaveBeenCalledWith("t-systems");
    expect(accountNs.companies.sendMessage).not.toHaveBeenCalled();

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const preview = JSON.parse(written) as Record<string, unknown>;
    expect(preview["method"]).toBe("companies.sendMessage");
    expect(preview["args"]).toEqual({ identifier: "112013061", chat_id: "2-YTQ3ODU3Njgt" });
    expect(preview["body"]).toEqual({ text: "preview this" });
    expect(preview["account"]).toBe("acc_1");
  });

  it("--preview prints 'Will send as company page <identifier>' derived from the identifier, without any SDK call", async () => {
    const { runCompanyReply } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyReply(client as never, {
      id: "112013061",
      chatId: "2-YTQ3ODU3Njgt",
      text: "hi",
      account: "acc_1",
      preview: true,
    } as CompanyArgs, out);

    expect(accountNs.companies.sendMessage).not.toHaveBeenCalled();
    const stderrLines = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string);
    // A `company reply` is ALWAYS a page reply, so the will-send-as notice derives from
    // the (resolved) identifier, not the chat-id prefix — the normal 2-… id no longer
    // carries a COMPANY_ marker. It must never say "personal" and never go silent.
    expect(stderrLines).toContain("Will send as company page 112013061\n");
    expect(stderrLines.join("")).not.toContain("personal");
  });

  it("--preview derives the notice from the RESOLVED numeric id when given a slug", async () => {
    (accountNs.companies.get as Mock).mockResolvedValue({ id: "112013061" });

    const { runCompanyReply } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyReply(client as never, {
      id: "t-systems",
      chatId: "2-YTQ3ODU3Njgt",
      text: "hi",
      account: "acc_1",
      preview: true,
    } as CompanyArgs, out);

    expect(accountNs.companies.sendMessage).not.toHaveBeenCalled();
    const stderrLines = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string);
    expect(stderrLines).toContain("Will send as company page 112013061\n");
  });

  it("a company-page send with a resolved name prints 'Sent as <name> (company page)' to stderr", async () => {
    const { runCompanyReply } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyReply(client as never, {
      id: "112013061",
      chatId: "2-YTQ3ODU3Njgt",
      text: "hi",
      account: "acc_1",
      json: true,
    } as CompanyArgs, out);

    const stderrLines = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string);
    expect(stderrLines).toContain("Sent as RedHire (company page)\n");
  });

  it("a company-page send with an uncorrelated page (name null) prints the generic fallback", async () => {
    (accountNs.companies.sendMessage as Mock).mockResolvedValue({
      object: "message_sent",
      message_id: "msg_1",
      sent_as: { kind: "company", company_id: null, name: null },
    });

    const { runCompanyReply } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyReply(client as never, {
      id: "112013061",
      chatId: "2-YTQ3ODU3Njgt",
      text: "hi",
      account: "acc_1",
      json: true,
    } as CompanyArgs, out);

    const stderrLines = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string);
    expect(stderrLines).toContain("Sent as a company page\n");
  });

  it("prints the message_sent result envelope on success", async () => {
    const { runCompanyReply } = await import("../../src/commands/company.js");
    const out = makeOut();

    await runCompanyReply(client as never, {
      id: "112013061",
      chatId: "2-YTQ3ODU3Njgt",
      text: "hi",
      account: "acc_1",
      json: true,
    } as CompanyArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as Record<string, unknown>;
    expect(result["object"]).toBe("message_sent");
    expect(result["message_id"]).toBe("msg_1");
  });

  it("without --account → exit 2, no SDK call", async () => {
    const { runCompanyReply } = await import("../../src/commands/company.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runCompanyReply(noConnectedAccounts(client) as never, {
        id: "112013061",
        chatId: "2-YTQ3ODU3Njgt",
        text: "hi",
        json: true,
      } as CompanyArgs, out);
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.companies.sendMessage).not.toHaveBeenCalled();
  });

  it("a 403 RESOURCE_ACCESS_RESTRICTED (not the page admin) surfaces as exit 8", async () => {
    const restrictedErr = new CurviateError({
      code: "RESOURCE_ACCESS_RESTRICTED",
      message: "Account does not administer this page.",
      httpStatus: 403,
      userFixable: false,
      retryLikelyToSucceed: false,
    });
    (accountNs.companies.sendMessage as Mock).mockRejectedValue(restrictedErr);

    const { runCompanyReply } = await import("../../src/commands/company.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runCompanyReply(client as never, {
        id: "112013061",
        chatId: "2-YTQ3ODU3Njgt",
        text: "hi",
        account: "acc_1",
        json: true,
      } as CompanyArgs, out);
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(8)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("a server 400 for a malformed chat_id surfaces as exit 2 — chat_id passed verbatim, no client-side pre-check", async () => {
    // Post-cutover, a well-formed 2-… id succeeds; a genuinely malformed id gets a plain
    // server-side 400 (not a "use COMPANY_" nudge — that guidance is gone). The CLI does
    // not pre-check the chat id client-side; it forwards it verbatim and surfaces the 400.
    const malformedErr = new CurviateError({
      code: "INVALID_REQUEST",
      message: "chat_id is not a valid conversation id.",
      httpStatus: 400,
      userFixable: true,
      retryLikelyToSucceed: false,
    });
    (accountNs.companies.sendMessage as Mock).mockRejectedValue(malformedErr);

    const { runCompanyReply } = await import("../../src/commands/company.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runCompanyReply(client as never, {
        id: "112013061",
        chatId: "not-a-real-id",
        text: "hi",
        account: "acc_1",
        json: true,
      } as CompanyArgs, out);
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    // The CLI made the call verbatim — validation is server-side, no client pre-check.
    expect(accountNs.companies.sendMessage).toHaveBeenCalledWith("112013061", "not-a-real-id", expect.anything());
  });

  it("a genuinely invalid identifier surfaces companies.get's 400 INVALID_REQUEST as exit 2, no sendMessage call", async () => {
    (accountNs.companies.get as Mock).mockRejectedValue(makeInvalidRequestError());

    const { runCompanyReply } = await import("../../src/commands/company.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runCompanyReply(client as never, {
        id: "@@bad@@",
        chatId: "2-YTQ3ODU3Njgt",
        text: "hi",
        account: "acc_1",
        json: true,
      } as CompanyArgs, out);
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.companies.sendMessage).not.toHaveBeenCalled();
  });

  it("text '-' reads from stdin via the injected reader", async () => {
    const { runCompanyReply } = await import("../../src/commands/company.js");
    const out = makeOut();
    const readStdin = vi.fn().mockResolvedValue("piped reply text");

    await runCompanyReply(
      client as never,
      { id: "112013061", chatId: "2-YTQ3ODU3Njgt", text: "-", account: "acc_1", json: true } as CompanyArgs,
      out,
      readStdin,
    );

    expect(readStdin).toHaveBeenCalled();
    expect(accountNs.companies.sendMessage).toHaveBeenCalledWith(
      "112013061",
      "2-YTQ3ODU3Njgt",
      expect.objectContaining({ text: "piped reply text" }),
    );
  });
});

