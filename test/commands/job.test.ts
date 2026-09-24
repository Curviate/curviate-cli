/**
 * Tests for the `job` command group.
 *
 * Coverage:
 *   job get <url|id>   → jobs.get (account-scoped, resolveJobIdentifier)
 *
 * Read command: --preview and --account-missing are usage errors (exit 2).
 * Slim projection (default) excludes hiring_team/cost/created_at, keeps
 * description. --verbose returns the full SDK response.
 * Unknown job → RESOURCE_NOT_FOUND → exit 4.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { noConnectedAccounts } from "../helpers/no-connected-accounts.js";

function makeAccountNs() {
  return {
    jobs: {
      get: vi.fn(),
    },
  };
}

function makeClient(accountNs: ReturnType<typeof makeAccountNs>) {
  return {
    account: vi.fn().mockReturnValue(accountNs),
  };
}

type JobArgs = {
  id?: string;
  account?: string;
  json?: boolean;
  fields?: string;
  preview?: boolean;
  "api-key"?: string;
  "base-url"?: string;
  timeout?: string;
  profile?: string;
  verbose?: boolean;
};

function makeOut() {
  return {
    stdout: { write: vi.fn() },
    stderr: { write: vi.fn() },
  };
}

function mockExit() {
  return vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new Error(`process.exit(${code})`);
  });
}

// Real Core `job_posting` v2 shape: `company` is a nested object (no
// top-level company_id), the applicant count is `applications_count`, and
// the only timestamp is `created_at` (no `published_at` on this shape at
// all — see the D13-sweep note on slimJob).
const richJob = {
  object: "job_posting",
  id: "4428113858",
  title: "Founders Associate",
  company: { id: "67756343", name: "LEAGUES", public_identifier: "leagues" },
  state: "LISTED",
  location: "Stuttgart, Baden-Württemberg, Germany",
  cost: 0,
  applications_count: 75,
  description: "Über deine Rolle: build the founding team.",
  created_at: "2026-06-12T10:07:09.000Z",
  hiring_team: [],
};

function makeNotFoundError() {
  return Object.assign(new Error("Job offer not found"), {
    code: "RESOURCE_NOT_FOUND",
    userFixable: true,
    retryLikelyToSucceed: false,
    toJSON: () => ({ code: "RESOURCE_NOT_FOUND", message: "Job offer not found" }),
  });
}

describe("job get — identifier resolution", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.jobs.get as Mock).mockResolvedValue(richJob);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("job get with a full job URL resolves to the numeric id and calls jobs.get", async () => {
    const { runJobGet } = await import("../../src/commands/job.js");
    const out = makeOut();

    await runJobGet(
      client as never,
      { id: "https://www.linkedin.com/jobs/view/4428113858", account: "acc_1", json: true } as JobArgs,
      out,
    );

    expect(accountNs.jobs.get).toHaveBeenCalledWith("4428113858");
  });

  it("job get with a bare numeric id calls jobs.get with an identical request", async () => {
    const { runJobGet } = await import("../../src/commands/job.js");
    const out = makeOut();

    await runJobGet(client as never, { id: "4428113858", account: "acc_1", json: true } as JobArgs, out);

    expect(accountNs.jobs.get).toHaveBeenCalledWith("4428113858");
  });

  it("job get scopes the call to the given --account", async () => {
    const { runJobGet } = await import("../../src/commands/job.js");
    const out = makeOut();

    await runJobGet(client as never, { id: "4428113858", account: "acc_9", json: true } as JobArgs, out);

    expect(client.account).toHaveBeenCalledWith("acc_9");
  });
});

describe("job get — usage errors", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.jobs.get as Mock).mockResolvedValue(richJob);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("job get without --account is a usage error", async () => {
    const { runJobGet } = await import("../../src/commands/job.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runJobGet(noConnectedAccounts(client) as never, { id: "4428113858" } as JobArgs, out);
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.jobs.get).not.toHaveBeenCalled();
  });
});

describe("job get — slim mode (default, no --verbose)", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.jobs.get as Mock).mockResolvedValue(richJob);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("slim output has exactly the 10 documented fields", async () => {
    const { runJobGet } = await import("../../src/commands/job.js");
    const out = makeOut();

    await runJobGet(client as never, { id: "4428113858", account: "acc_1", json: true } as JobArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as Record<string, unknown>;
    expect(Object.keys(result)).toHaveLength(10);
  });

  it("slim output includes a non-empty description", async () => {
    const { runJobGet } = await import("../../src/commands/job.js");
    const out = makeOut();

    await runJobGet(client as never, { id: "4428113858", account: "acc_1", json: true } as JobArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as Record<string, unknown>;
    expect(result["description"]).toBe(richJob.description);
  });

  it("slim output excludes hiring_team and cost", async () => {
    const { runJobGet } = await import("../../src/commands/job.js");
    const out = makeOut();

    await runJobGet(client as never, { id: "4428113858", account: "acc_1", json: true } as JobArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as Record<string, unknown>;
    expect(result).not.toHaveProperty("hiring_team");
    expect(result).not.toHaveProperty("cost");
  });

  it("D13 sweep: company_id is synthesized from the nested company.id, applications_count surfaces, published_at falls back to created_at (Core shape has no published_at)", async () => {
    const { runJobGet } = await import("../../src/commands/job.js");
    const out = makeOut();

    await runJobGet(client as never, { id: "4428113858", account: "acc_1", json: true } as JobArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as Record<string, unknown>;
    expect(result["company_id"]).toBe("67756343");
    expect(result["applications_count"]).toBe(75);
    expect(result["published_at"]).toBe("2026-06-12T10:07:09.000Z");
    expect(result).not.toHaveProperty("applicants_counter");
  });

  it("--json is emitted by default when stdout is not a TTY (agent-first pipe behavior)", async () => {
    const { runJobGet } = await import("../../src/commands/job.js");
    const out = makeOut();

    // No explicit json:true — relies on the test environment's non-TTY stdout.
    await runJobGet(client as never, { id: "4428113858", account: "acc_1" } as JobArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    expect(() => JSON.parse(written)).not.toThrow();
  });
});

describe("job get --verbose mode", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.jobs.get as Mock).mockResolvedValue(richJob);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--verbose returns the full SDK response including hiring_team, cost, created_at", async () => {
    const { runJobGet } = await import("../../src/commands/job.js");
    const out = makeOut();

    await runJobGet(
      client as never,
      { id: "4428113858", account: "acc_1", json: true, verbose: true } as JobArgs,
      out,
    );

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as Record<string, unknown>;
    expect(result).toHaveProperty("hiring_team");
    expect(result).toHaveProperty("cost");
    expect(result).toHaveProperty("created_at");
  });
});

describe("job get — unknown job", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("unknown job exits with the resource-not-found exit code", async () => {
    const notFoundErr = makeNotFoundError();
    (accountNs.jobs.get as Mock).mockRejectedValue(notFoundErr);

    const { CurviateError } = await import("@curviate/sdk");
    Object.setPrototypeOf(notFoundErr, CurviateError.prototype);

    const { runJobGet } = await import("../../src/commands/job.js");
    const out = makeOut();
    const exitSpy = mockExit();

    try {
      await runJobGet(client as never, { id: "9999999999999", account: "acc_1", json: true } as JobArgs, out);
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(4)");
    } finally {
      exitSpy.mockRestore();
    }

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.error.code).toBe("RESOURCE_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// flag hygiene — job get is a single-object read, no pagination flags
// ---------------------------------------------------------------------------

describe("job get — no pagination flags in help (fields allowed)", () => {
  const PAGINATION_ONLY_FLAGS = ["limit", "cursor", "all", "max-pages"] as const;

  it("job get args definition has no pagination-only flags, keeps --fields", async () => {
    const { jobCommand } = await import("../../src/commands/job.js");
    type ArgsRecord = Record<string, unknown>;
    type CommandLike = { args?: ArgsRecord; subCommands?: Record<string, CommandLike> };
    const cmd = jobCommand as unknown as CommandLike;
    const args = (cmd.subCommands ?? {})["get"]?.args ?? {};

    for (const flag of PAGINATION_ONLY_FLAGS) {
      expect(args, `job get args must NOT include --${flag}`).not.toHaveProperty(flag);
    }
    expect(args, "job get must keep --fields (single-object read)").toHaveProperty("fields");
  });
});
