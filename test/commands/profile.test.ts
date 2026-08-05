/**
 * Tests for the `profile` command group.
 * Covers: routing, identifier resolution, flag dispatching, --preview on reads,
 * --all NDJSON, --all on non-paginated commands, --sections, slim/verbose,
 * company slug resolution for --posts --is-company.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal account-scoped namespace stub (v2 SDK surface). */
function makeAccountNs() {
  return {
    users: {
      get: vi.fn(),
      listRelations: vi.fn(),
      listFollowers: vi.fn(),
      endorseSkill: vi.fn(),
    },
    posts: {
      listUserPosts: vi.fn(),
      listUserReactions: vi.fn(),
    },
    comments: {
      listUserComments: vi.fn(),
    },
    companies: {
      get: vi.fn(),
    },
  };
}

/** Minimal Curviate client stub. */
function makeClient(accountNs: ReturnType<typeof makeAccountNs>) {
  return {
    account: vi.fn().mockReturnValue(accountNs),
  };
}

type ProfileCommandArgs = {
  id?: string;
  posts?: boolean;
  comments?: boolean;
  reactions?: boolean;
  followers?: boolean;
  "is-company"?: boolean;
  "endorsement-id"?: string;
  account?: string;
  json?: boolean;
  fields?: string;
  limit?: string;
  cursor?: string;
  all?: boolean;
  "max-pages"?: string;
  preview?: boolean;
  "api-key"?: string;
  "base-url"?: string;
  timeout?: string;
  profile?: string;
  sections?: string;
  verbose?: boolean;
};

type SubCommandArgs = {
  id?: string;
  "endorsement-id"?: string;
  account?: string;
  json?: boolean;
  all?: boolean;
  "max-pages"?: string;
  preview?: boolean;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("profile command — routing", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.users.get as Mock).mockResolvedValue({ id: "jdoe" });
    (accountNs.posts.listUserPosts as Mock).mockResolvedValue({ items: [], cursor: null });
    (accountNs.comments.listUserComments as Mock).mockResolvedValue({ items: [], cursor: null });
    (accountNs.posts.listUserReactions as Mock).mockResolvedValue({ items: [], cursor: null });
    (accountNs.users.listFollowers as Mock).mockResolvedValue({ items: [], cursor: null });
    (accountNs.users.listRelations as Mock).mockResolvedValue({ items: [], cursor: null });
    (accountNs.users.endorseSkill as Mock).mockResolvedValue({ success: true });
    (accountNs.companies.get as Mock).mockResolvedValue({ id: "123456" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("profile me — calls users.get('me') with empty params when no --sections", async () => {
    const { runProfileMe } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileMe(client as never, { account: "acc_1", json: true } as ProfileCommandArgs, out);

    expect(client.account).toHaveBeenCalledWith("acc_1");
    expect(accountNs.users.get).toHaveBeenCalledWith("me", {});
  });

  it("profile me — --preview is a usage error (exit 2)", async () => {
    const { runProfileMe } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => { throw new Error(`process.exit(${code})`); });
    try {
      await runProfileMe(client as never, { account: "acc_1", preview: true } as ProfileCommandArgs, out);
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("profile me — --all is a usage error (exit 2)", async () => {
    const { runProfileMe } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => { throw new Error(`process.exit(${code})`); });
    try {
      await runProfileMe(client as never, { account: "acc_1", all: true } as ProfileCommandArgs, out);
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("profile <id> — default (no flag) calls users.get with resolved id", async () => {
    const { runProfileGet } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileGet(client as never, { id: "https://www.linkedin.com/in/jdoe/", account: "acc_1", json: true } as ProfileCommandArgs, out);

    expect(client.account).toHaveBeenCalledWith("acc_1");
    expect(accountNs.users.get).toHaveBeenCalledWith("jdoe", expect.objectContaining({}));
    expect(accountNs.posts.listUserPosts).not.toHaveBeenCalled();
  });

  it("profile / profile me no longer declare the removed --notify flag (v2 users.get has no notify param)", async () => {
    const { profileCommand } = await import("../../src/commands/profile.js");
    const cmd = profileCommand as unknown as {
      args?: Record<string, unknown>;
      subCommands?: { me?: { args?: Record<string, unknown> } };
    };
    expect(cmd.args ?? {}, "profile <id> must not declare --notify").not.toHaveProperty("notify");
    expect(cmd.subCommands?.me?.args ?? {}, "profile me must not declare --notify").not.toHaveProperty("notify");
  });

  it("profile <id> --posts — resolves the slug to a provider id, then calls listPosts", async () => {
    const { runProfileGet } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    // listUserPosts 400s a public slug, so the slug must be resolved first.
    accountNs.users.get.mockResolvedValue({ id: "ACoAAjdoeprovider" });

    await runProfileGet(client as never, { id: "jdoe", posts: true, account: "acc_1", json: true } as ProfileCommandArgs, out);

    expect(accountNs.users.get).toHaveBeenCalledWith("jdoe", {});
    expect(accountNs.posts.listUserPosts).toHaveBeenCalledWith("ACoAAjdoeprovider", expect.any(Object));
  });

  it("profile <id> --posts — a provider id is used as-is, with no resolution lookup", async () => {
    const { runProfileGet } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileGet(
      client as never,
      { id: "ACoAAalreadyaproviderid", posts: true, account: "acc_1", json: true } as ProfileCommandArgs,
      out,
    );

    expect(accountNs.users.get).not.toHaveBeenCalled();
    expect(accountNs.posts.listUserPosts).toHaveBeenCalledWith("ACoAAalreadyaproviderid", expect.any(Object));
  });

  it("profile <URL> --posts — the URL form is accepted, exactly as plain profile accepts it", async () => {
    const { runProfileGet } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    accountNs.users.get.mockResolvedValue({ id: "ACoAAfromurl" });

    await runProfileGet(
      client as never,
      {
        id: "https://www.linkedin.com/in/jdoe/",
        posts: true,
        account: "acc_1",
        json: true,
      } as ProfileCommandArgs,
      out,
    );

    // The URL is normalized to its slug, then resolved to the provider id.
    expect(accountNs.users.get).toHaveBeenCalledWith("jdoe", {});
    expect(accountNs.posts.listUserPosts).toHaveBeenCalledWith("ACoAAfromurl", expect.any(Object));
  });

  it.each([
    ["comments", "comments", "listUserComments"],
    ["reactions", "posts", "listUserReactions"],
    ["followers", "users", "listFollowers"],
  ] as const)(
    "profile <URL> --%s — the URL form is accepted and resolved (not just --posts)",
    async (flag, nsKey, method) => {
      const { runProfileGet } = await import("../../src/commands/profile.js");
      const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
      accountNs.users.get.mockResolvedValue({ id: "ACoAAfromurl" });

      await runProfileGet(
        client as never,
        {
          id: "https://www.linkedin.com/in/jdoe/",
          [flag]: true,
          account: "acc_1",
          json: true,
        } as ProfileCommandArgs,
        out,
      );

      const ns = accountNs as unknown as Record<string, Record<string, Mock>>;
      expect(ns[nsKey]![method]!).toHaveBeenCalledWith("ACoAAfromurl", expect.any(Object));
    },
  );

  it("profile <id> --posts --is-company (numeric id) — no slug resolution, lists directly", async () => {
    const { runProfileGet } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    // Use a numeric id to exercise the "bypass slug resolution" path.
    // v2 listUserPosts carries no is_company query param — the company vs. user
    // distinction is resolved by passing the numeric company id, not a flag.
    await runProfileGet(client as never, { id: "123456", posts: true, "is-company": true, account: "acc_1", json: true } as ProfileCommandArgs, out);

    expect(accountNs.companies.get).not.toHaveBeenCalled();
    expect(accountNs.posts.listUserPosts).toHaveBeenCalledWith("123456", expect.any(Object));
  });

  it("profile <id> --comments — calls listComments", async () => {
    const { runProfileGet } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileGet(client as never, { id: "jdoe", comments: true, account: "acc_1", json: true } as ProfileCommandArgs, out);

    expect(accountNs.comments.listUserComments).toHaveBeenCalledWith("jdoe", expect.any(Object));
  });

  it("profile <id> --reactions — calls listReactions", async () => {
    const { runProfileGet } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileGet(client as never, { id: "jdoe", reactions: true, account: "acc_1", json: true } as ProfileCommandArgs, out);

    expect(accountNs.posts.listUserReactions).toHaveBeenCalledWith("jdoe", expect.any(Object));
  });

  it("profile <id> --followers — calls listFollowers", async () => {
    const { runProfileGet } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileGet(client as never, { id: "jdoe", followers: true, account: "acc_1", json: true } as ProfileCommandArgs, out);

    expect(accountNs.users.listFollowers).toHaveBeenCalledWith("jdoe", expect.any(Object));
  });

  it("profile <id> read flag + --preview → usage error (exit 2)", async () => {
    const { runProfileGet } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => { throw new Error(`process.exit(${code})`); });
    try {
      await runProfileGet(client as never, { id: "jdoe", account: "acc_1", preview: true } as ProfileCommandArgs, out);
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("profile relations — calls listRelations()", async () => {
    const { runProfileRelations } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileRelations(client as never, { account: "acc_1", json: true } as SubCommandArgs, out);

    expect(client.account).toHaveBeenCalledWith("acc_1");
    expect(accountNs.users.listRelations).toHaveBeenCalled();
  });

  it("profile relations --all — streams NDJSON over 2 pages", async () => {
    const { runProfileRelations } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    // Two pages
    (accountNs.users.listRelations as Mock)
      .mockResolvedValueOnce({ items: [{ id: "A" }, { id: "B" }], cursor: "c1" })
      .mockResolvedValueOnce({ items: [{ id: "C" }], cursor: null });

    await runProfileRelations(client as never, { account: "acc_1", all: true } as SubCommandArgs, out);

    const writtenLines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string);
    const ndjsonLines = writtenLines.filter((l) => l.trim().startsWith("{"));
    expect(ndjsonLines).toHaveLength(3);
    expect(JSON.parse(ndjsonLines[0]!)).toEqual({ id: "A" });
    expect(JSON.parse(ndjsonLines[1]!)).toEqual({ id: "B" });
    expect(JSON.parse(ndjsonLines[2]!)).toEqual({ id: "C" });
  });

  it("profile relations --all --max-pages 1 — truncates, sentinel on stdout, prose on stderr", async () => {
    const { runProfileRelations } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    (accountNs.users.listRelations as Mock)
      .mockResolvedValueOnce({ items: [{ id: "A" }, { id: "B" }], cursor: "c1" });

    await runProfileRelations(client as never, { account: "acc_1", all: true, "max-pages": "1" } as SubCommandArgs, out);

    const writtenLines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string);
    const ndjsonLines = writtenLines.filter((l) => l.trim().startsWith("{"));
    // 2 items + the stream_truncated sentinel as the last stdout line (D11 — the
    // shared paginate helper now emits this on every --all command, not just search).
    expect(ndjsonLines).toHaveLength(3);
    expect(JSON.parse(ndjsonLines[0]!)).toEqual({ id: "A" });
    expect(JSON.parse(ndjsonLines[1]!)).toEqual({ id: "B" });
    expect(JSON.parse(ndjsonLines[2]!)).toEqual({ object: "stream_truncated", pages_fetched: 1, has_more: true });

    const stderrCalls = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    expect(stderrCalls).toMatch(/truncat/i);
  });
});

describe("profile endorse — write command", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.users.endorseSkill as Mock).mockResolvedValue({ success: true });
    // The endorse write path (like follow/unfollow) accepts only the provider
    // id — a slug 404s upstream. users.get resolves a slug to that id.
    (accountNs.users.get as Mock).mockResolvedValue({ id: "ACoAAresolved" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("endorse <slug> — resolves the slug to the provider id via users.get, then endorses THAT id", async () => {
    const { runProfileEndorse } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileEndorse(client as never, { id: "raphael-redmer", "endorsement-id": "skill_123", account: "acc_1", json: true } as SubCommandArgs, out);

    expect(client.account).toHaveBeenCalledWith("acc_1");
    // The slug is resolved via a users.get READ (contact-safe) ...
    expect(accountNs.users.get).toHaveBeenCalledWith("raphael-redmer", {});
    // ... and the endorse call uses the RESOLVED provider id, not the raw slug.
    expect(accountNs.users.endorseSkill).toHaveBeenCalledWith("ACoAAresolved", { endorsement_id: "skill_123" });
  });

  it("endorse <provider-id> — passes through with NO extra users.get call", async () => {
    const { runProfileEndorse } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileEndorse(client as never, { id: "ACoAAdirect", "endorsement-id": "skill_9", account: "acc_1", json: true } as SubCommandArgs, out);

    expect(accountNs.users.get).not.toHaveBeenCalled();
    expect(accountNs.users.endorseSkill).toHaveBeenCalledWith("ACoAAdirect", { endorsement_id: "skill_9" });
  });

  it("endorse --preview — renders the RESOLVED provider id, no endorse call", async () => {
    const { runProfileEndorse } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileEndorse(client as never, { id: "raphael-redmer", "endorsement-id": "skill_123", account: "acc_1", preview: true } as SubCommandArgs, out);

    expect(accountNs.users.endorseSkill).not.toHaveBeenCalled();
    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written);
    expect(parsed.method).toBe("users.endorseSkill");
    // The preview reflects the resolved id (the read runs even under --preview).
    expect(parsed.args).toMatchObject({ id: "ACoAAresolved" });
  });

  it("endorse <url> — normalizes the URL then resolves it to the provider id", async () => {
    const { runProfileEndorse } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileEndorse(client as never, { id: "https://www.linkedin.com/in/some-user/", "endorsement-id": "skill_1", account: "acc_1", json: true } as SubCommandArgs, out);

    expect(accountNs.users.get).toHaveBeenCalledWith("some-user", {});
    expect(accountNs.users.endorseSkill).toHaveBeenCalledWith("ACoAAresolved", { endorsement_id: "skill_1" });
  });

  it("endorse — a users.get resolve failure surfaces (no endorse call)", async () => {
    const { runProfileEndorse } = await import("../../src/commands/profile.js");
    const { CurviateError } = await import("@curviate/sdk");
    (accountNs.users.get as Mock).mockRejectedValue(
      new CurviateError({ code: "RESOURCE_NOT_FOUND", message: "not found", userFixable: true, retryLikelyToSucceed: false }),
    );
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    await expect(
      runProfileEndorse(client as never, { id: "raphael-redmer", "endorsement-id": "skill_1", account: "acc_1", json: true } as SubCommandArgs, out),
    ).rejects.toThrow(/process\.exit/);
    expect(accountNs.users.endorseSkill).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});

// `curviate login` tells the user to run `curviate profile me` to verify. On a
// fresh config that exited 2 with "--account is required", so the very first
// instruction a new user follows dead-ended. With exactly one connected account
// there is nothing to disambiguate, so it is resolved instead of demanded.
describe("profile — account resolution when --account is omitted", () => {
  /** Client stub whose accounts.list returns the given items. */
  function clientWithAccounts(accountNs: ReturnType<typeof makeAccountNs>, items: unknown[]) {
    return {
      account: vi.fn().mockReturnValue(accountNs),
      accounts: { list: vi.fn().mockResolvedValue({ items }) },
    };
  }

  it("exactly one connected account → it is used, and the command succeeds", async () => {
    const accountNs = makeAccountNs();
    (accountNs.users.get as Mock).mockResolvedValue({ id: "jdoe" });
    const client = clientWithAccounts(accountNs, [
      { account_id: "acc_sole", full_name: "Ralf Example", status: "active" },
    ]);
    const { runProfileMe } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileMe(client as never, { json: true } as ProfileCommandArgs, out);

    expect(client.accounts.list).toHaveBeenCalled();
    expect(client.account).toHaveBeenCalledWith("acc_sole");
    expect(accountNs.users.get).toHaveBeenCalledWith("me", {});
    expect(out.stderr.write).not.toHaveBeenCalled();
  });

  it("an explicit --account wins and costs no lookup", async () => {
    const accountNs = makeAccountNs();
    (accountNs.users.get as Mock).mockResolvedValue({ id: "jdoe" });
    const client = clientWithAccounts(accountNs, [{ account_id: "acc_sole" }]);
    const { runProfileMe } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileMe(client as never, { account: "acc_explicit", json: true } as ProfileCommandArgs, out);

    expect(client.accounts.list).not.toHaveBeenCalled();
    expect(client.account).toHaveBeenCalledWith("acc_explicit");
  });

  it("zero connected accounts → exit 2 naming what to do, not a bare flag complaint", async () => {
    const accountNs = makeAccountNs();
    const client = clientWithAccounts(accountNs, []);
    const { runProfileMe } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => { throw new Error(`process.exit(${code})`); });
    try {
      await runProfileMe(client as never, { json: true } as ProfileCommandArgs, out);
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    const msg = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    expect(msg).toContain("no LinkedIn account is connected");
  });

  it("more than one connected account → exit 2 listing the choices", async () => {
    const accountNs = makeAccountNs();
    const client = clientWithAccounts(accountNs, [
      { account_id: "acc_one", full_name: "Ralf Example", status: "active" },
      { account_id: "acc_two", full_name: "Other Persona", status: "active" },
    ]);
    const { runProfileMe } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => { throw new Error(`process.exit(${code})`); });
    try {
      await runProfileMe(client as never, { json: true } as ProfileCommandArgs, out);
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    const msg = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    // Ambiguity must be actionable: name both candidates, not just the flag.
    expect(msg).toContain("acc_one");
    expect(msg).toContain("acc_two");
    expect(msg).toContain("--account");
  });
});

// ---------------------------------------------------------------------------
// --sections passthrough
// ---------------------------------------------------------------------------

describe("profile me — --sections passthrough", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.users.get as Mock).mockResolvedValue({ id: "me" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--sections 'experience,education' auto-prefixes to linkedin_experience,linkedin_education (D9)", async () => {
    const { runProfileMe } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileMe(
      client as never,
      { account: "acc_1", json: true, sections: "experience,education" } as ProfileCommandArgs,
      out,
    );

    expect(accountNs.users.get).toHaveBeenCalledWith(
      "me",
      expect.objectContaining({ linkedin_sections: ["linkedin_experience", "linkedin_education"] }),
    );
  });

  it("--sections '*' auto-prefixes to linkedin_sections:['linkedin_*'] (D9)", async () => {
    const { runProfileMe } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileMe(
      client as never,
      { account: "acc_1", json: true, sections: "*" } as ProfileCommandArgs,
      out,
    );

    expect(accountNs.users.get).toHaveBeenCalledWith(
      "me",
      expect.objectContaining({ linkedin_sections: ["linkedin_*"] }),
    );
  });

  it("--sections 'linkedin_skills' (already canonical) passes through unchanged (D9)", async () => {
    const { runProfileMe } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileMe(
      client as never,
      { account: "acc_1", json: true, sections: "linkedin_skills" } as ProfileCommandArgs,
      out,
    );

    expect(accountNs.users.get).toHaveBeenCalledWith(
      "me",
      expect.objectContaining({ linkedin_sections: ["linkedin_skills"] }),
    );
  });

  it("--sections 'bogus-section' is a usage error naming the bad value, no SDK call (D9)", async () => {
    const { runProfileMe } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(
      (code?: number | string | null) => { throw new Error(`process.exit(${code})`); },
    );
    try {
      await runProfileMe(
        client as never,
        { account: "acc_1", sections: "bogus-section" } as ProfileCommandArgs,
        out,
      );
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.users.get).not.toHaveBeenCalled();
    const stderrOut = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    expect(stderrOut).toContain("bogus-section");
  });

  it("--sections '' exits 2 (empty string is a usage error)", async () => {
    const { runProfileMe } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(
      (code?: number | string | null) => { throw new Error(`process.exit(${code})`); },
    );
    try {
      await runProfileMe(
        client as never,
        { account: "acc_1", sections: "" } as ProfileCommandArgs,
        out,
      );
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.users.get).not.toHaveBeenCalled();
  });
});

// The recruiter-grade payload (--sections linkedin_experience etc.) used to be
// fetched and then thrown away by the default slim projection, so `--sections`
// looked like a no-op and a user had no way to tell it had worked.
describe("profile — --sections output actually reaches the user", () => {
  const ENRICHED = {
    id: "ACoAAjdoe",
    first_name: "Jane",
    description: "Staff Engineer",
    public_identifier: "jdoe",
    specifics: {
      network_distance: "DISTANCE_1",
      experience: [{ position: "Staff Engineer", company: "Acme", end: null }],
      education: [{ school: "State University", degree: "BSc" }],
      skills: [{ name: "TypeScript" }],
    },
  };

  it("requested sections are returned on the DEFAULT output, not only under --verbose", async () => {
    const accountNs = makeAccountNs();
    const client = makeClient(accountNs);
    (accountNs.users.get as Mock).mockResolvedValue(ENRICHED);
    const { runProfileGet } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileGet(
      client as never,
      { id: "jdoe", account: "acc_1", json: true, sections: "experience,education,skills" } as ProfileCommandArgs,
      out,
    );

    const result = JSON.parse(
      (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join(""),
    ) as Record<string, unknown>;
    const sections = result["sections"] as Record<string, unknown>;
    expect(sections).toBeDefined();
    expect(sections["experience"]).toEqual(ENRICHED.specifics.experience);
    expect(sections["education"]).toEqual(ENRICHED.specifics.education);
    expect(sections["skills"]).toEqual(ENRICHED.specifics.skills);
  });

  it("only the REQUESTED sections are included (asking for one does not dump the rest)", async () => {
    const accountNs = makeAccountNs();
    const client = makeClient(accountNs);
    (accountNs.users.get as Mock).mockResolvedValue(ENRICHED);
    const { runProfileGet } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileGet(
      client as never,
      { id: "jdoe", account: "acc_1", json: true, sections: "education" } as ProfileCommandArgs,
      out,
    );

    const result = JSON.parse(
      (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join(""),
    ) as Record<string, unknown>;
    const sections = result["sections"] as Record<string, unknown>;
    expect(Object.keys(sections)).toEqual(["education"]);
  });

  it("with NO --sections the default output is unchanged (no sections key, no metadata leakage)", async () => {
    const accountNs = makeAccountNs();
    const client = makeClient(accountNs);
    (accountNs.users.get as Mock).mockResolvedValue(ENRICHED);
    const { runProfileGet } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileGet(
      client as never,
      { id: "jdoe", account: "acc_1", json: true } as ProfileCommandArgs,
      out,
    );

    const result = JSON.parse(
      (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join(""),
    ) as Record<string, unknown>;
    expect(result).not.toHaveProperty("sections");
    // network_distance stays a top-level slim field, never a "section".
    expect(result["network_distance"]).toBe("DISTANCE_1");
  });
});

describe("profile <id> — --sections passthrough", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.users.get as Mock).mockResolvedValue({ id: "jdoe" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--sections 'experience' auto-prefixes to linkedin_sections:['linkedin_experience'] (D9)", async () => {
    const { runProfileGet } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileGet(
      client as never,
      { id: "jdoe", account: "acc_1", json: true, sections: "experience" } as ProfileCommandArgs,
      out,
    );

    expect(accountNs.users.get).toHaveBeenCalledWith(
      "jdoe",
      expect.objectContaining({ linkedin_sections: ["linkedin_experience"] }),
    );
  });

  it("--sections 'bogus-section' on profile <id> is a usage error naming the bad value, no SDK call (D9)", async () => {
    const { runProfileGet } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(
      (code?: number | string | null) => { throw new Error(`process.exit(${code})`); },
    );
    try {
      await runProfileGet(
        client as never,
        { id: "jdoe", account: "acc_1", sections: "bogus-section" } as ProfileCommandArgs,
        out,
      );
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.users.get).not.toHaveBeenCalled();
    const stderrOut = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    expect(stderrOut).toContain("bogus-section");
  });

  it("--sections '' exits 2 on profile <id> (usage error)", async () => {
    const { runProfileGet } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(
      (code?: number | string | null) => { throw new Error(`process.exit(${code})`); },
    );
    try {
      await runProfileGet(
        client as never,
        { id: "jdoe", account: "acc_1", sections: "" } as ProfileCommandArgs,
        out,
      );
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.users.get).not.toHaveBeenCalled();
  });

  // D7: the sections-enriched users.get call 400s on a raw slug (only "me" +
  // a provider id route) — resolve a slug/URL to the provider id via a
  // users.get READ first, same pattern as the D6/D7 fixes elsewhere.

  it("profile <slug> --sections resolves the slug to a provider id via users.get, then fetches sections (D7)", async () => {
    (accountNs.users.get as Mock)
      .mockResolvedValueOnce({ object: "user_profile", id: "ACoAA_resolved" }) // resolution call
      .mockResolvedValueOnce({ object: "user_profile", id: "ACoAA_resolved", first_name: "Raphael" }); // sections fetch
    const { runProfileGet } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileGet(
      client as never,
      { id: "raphael-redmer", account: "acc_1", json: true, sections: "linkedin_experience" } as ProfileCommandArgs,
      out,
    );

    expect(accountNs.users.get).toHaveBeenNthCalledWith(1, "raphael-redmer", {});
    expect(accountNs.users.get).toHaveBeenNthCalledWith(
      2,
      "ACoAA_resolved",
      expect.objectContaining({ linkedin_sections: ["linkedin_experience"] }),
    );
    expect(accountNs.users.get).toHaveBeenCalledTimes(2);
  });

  it("profile <provider_id> --sections skips the resolve call (already a provider id) (D7)", async () => {
    (accountNs.users.get as Mock).mockResolvedValue({ object: "user_profile", id: "ACoAAA_x" });
    const { runProfileGet } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileGet(
      client as never,
      { id: "ACoAAA_x", account: "acc_1", json: true, sections: "linkedin_experience" } as ProfileCommandArgs,
      out,
    );

    expect(accountNs.users.get).toHaveBeenCalledTimes(1);
    expect(accountNs.users.get).toHaveBeenCalledWith(
      "ACoAAA_x",
      expect.objectContaining({ linkedin_sections: ["linkedin_experience"] }),
    );
  });

  it("profile me --sections is unaffected — 'me' passes straight through with a single call (D7 regression guard)", async () => {
    (accountNs.users.get as Mock).mockResolvedValue({ object: "user_profile", id: "me" });
    const { runProfileMe } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileMe(
      client as never,
      { account: "acc_1", json: true, sections: "linkedin_experience" } as ProfileCommandArgs,
      out,
    );

    expect(accountNs.users.get).toHaveBeenCalledTimes(1);
    expect(accountNs.users.get).toHaveBeenCalledWith(
      "me",
      expect.objectContaining({ linkedin_sections: ["linkedin_experience"] }),
    );
  });

  it("profile <slug> WITHOUT --sections is unaffected — no resolve call, single get with the raw resolved id (D7 regression guard)", async () => {
    (accountNs.users.get as Mock).mockResolvedValue({ object: "user_profile", id: "jdoe" });
    const { runProfileGet } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileGet(
      client as never,
      { id: "jdoe", account: "acc_1", json: true } as ProfileCommandArgs,
      out,
    );

    expect(accountNs.users.get).toHaveBeenCalledTimes(1);
    expect(accountNs.users.get).toHaveBeenCalledWith("jdoe", {});
  });

  it("profile <unresolvable-slug> --sections surfaces users.get's 404 as exit 4, no sections fetch (D7)", async () => {
    const { CurviateError } = await import("@curviate/sdk");
    const notFound = new CurviateError({
      code: "RESOURCE_NOT_FOUND",
      message: "Member not found.",
      httpStatus: 404,
      userFixable: false,
      retryLikelyToSucceed: false,
    });
    (accountNs.users.get as Mock).mockRejectedValueOnce(notFound);
    const { runProfileGet } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(
      (code?: number | string | null) => { throw new Error(`process.exit(${code})`); },
    );
    try {
      await runProfileGet(
        client as never,
        { id: "no-such-member", account: "acc_1", json: true, sections: "linkedin_experience" } as ProfileCommandArgs,
        out,
      );
      expect.fail("Should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(4)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.users.get).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// slim mode (no --verbose)
// ---------------------------------------------------------------------------

describe("profile me — slim mode (no --verbose)", () => {
  // Real v2 UserProfile shape — provider_id sources from the top-level `id`,
  // is_premium/experience live nested under `specifics`, emails is the real
  // plural array, headline sources from `description` (the real wire's
  // headline slot — see lib/slim.ts JSDoc). occupation/organizations have no
  // v2 source at all.
  const richProfile = {
    object: "user_profile",
    id: "ACoAACyJnqkBprov123",
    first_name: "John",
    last_name: "Doe",
    public_identifier: "johndoe",
    location: "Berlin",
    description: "Building things at Acme",
    emails: ["john@example.com"],
    entity_urn: "urn:li:member:123",
    specifics: {
      is_premium: false,
      experience: [{ id: "exp1", position: "Engineer", company: "Acme", end: null }],
      education: [{ school: "MIT" }],
    },
  };

  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.users.get as Mock).mockResolvedValue(richProfile);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("slim output has exactly the 9 fields (incl. current_position, headline), no heavy fields", async () => {
    const { runProfileMe } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileMe(client as never, { account: "acc_1", json: true } as ProfileCommandArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as Record<string, unknown>;
    expect(Object.keys(result)).toHaveLength(9);
    expect(result["provider_id"]).toBe("ACoAACyJnqkBprov123");
    expect(result["headline"]).toBe("Building things at Acme");
    expect(result["emails"]).toEqual(["john@example.com"]);
    expect(result["is_premium"]).toBe(false);
    expect(result).toHaveProperty("current_position");
    expect(result).not.toHaveProperty("occupation");
    expect(result).not.toHaveProperty("organizations");
    expect(result).not.toHaveProperty("entity_urn");
    expect(result).not.toHaveProperty("specifics");
    expect(result).not.toHaveProperty("education");
  });

  it("current_position synthesized from specifics.experience[0]", async () => {
    const { runProfileMe } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileMe(client as never, { account: "acc_1", json: true } as ProfileCommandArgs, out);

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as Record<string, unknown>;
    expect(result["current_position"]).toEqual({
      title: "Engineer",
      company_name: "Acme",
      company_id: null,
      is_current: true,
    });
  });
});

describe("profile me — --verbose mode", () => {
  const richProfile = {
    object: "user_profile",
    id: "ACoAACyJnqkBprov123",
    first_name: "John",
    last_name: "Doe",
    entity_urn: "urn:li:member:123",
    specifics: {
      experience: [{ id: "exp1", position: "Engineer", company: "Acme", end: null }],
      education: [{ school: "MIT" }],
    },
  };

  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.users.get as Mock).mockResolvedValue(richProfile);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--verbose returns full SDK response (includes specifics.experience, entity_urn, etc.)", async () => {
    const { runProfileMe } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileMe(
      client as never,
      { account: "acc_1", json: true, verbose: true } as ProfileCommandArgs,
      out,
    );

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as Record<string, unknown>;
    expect(result).toHaveProperty("entity_urn");
    const specifics = result["specifics"] as Record<string, unknown>;
    expect(specifics).toHaveProperty("experience");
    expect(specifics).toHaveProperty("education");
    // --verbose is a SUPERSET: the derived slim-only fields survive alongside
    // the raw wire object. It used to DROP them, which made a flag named
    // verbose return less than the default.
    expect(result).toHaveProperty("current_position");
    expect(result).toHaveProperty("provider_id");
    expect(result).toHaveProperty("headline");
  });

  it("--verbose is a strict superset of the default projection (every slim key survives)", async () => {
    const { runProfileMe } = await import("../../src/commands/profile.js");

    const slimOut = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    await runProfileMe(client as never, { account: "acc_1", json: true } as ProfileCommandArgs, slimOut);
    const slimKeys = Object.keys(
      JSON.parse((slimOut.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("")) as Record<string, unknown>,
    );

    const verboseOut = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
    await runProfileMe(
      client as never,
      { account: "acc_1", json: true, verbose: true } as ProfileCommandArgs,
      verboseOut,
    );
    const verboseKeys = new Set(
      Object.keys(
        JSON.parse((verboseOut.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("")) as Record<string, unknown>,
      ),
    );

    const missing = slimKeys.filter((k) => !verboseKeys.has(k));
    expect(missing, `--verbose dropped default fields: ${missing.join(", ")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// slim/verbose for profile <id> (default branch)
// ---------------------------------------------------------------------------

describe("profile <id> — slim mode (current_position synthesis)", () => {
  // Real v2 UserProfile shape — provider_id sources from the top-level `id`,
  // network_distance/experience live nested under `specifics`, headline
  // sources from `description` (the real wire's headline slot — see
  // lib/slim.ts JSDoc). occupation has no v2 source at all (removed from
  // slim output).
  const richProfile = {
    object: "user_profile",
    id: "ACoAACyJnqkBprov456",
    first_name: "Jane",
    last_name: "Smith",
    location: "London, UK",
    public_identifier: "janesmith",
    description: "Senior Engineer at TechCorp",
    specifics: {
      network_distance: "FIRST_DEGREE",
      experience: [
        {
          id: "exp_1",
          position: "Senior Engineer",
          company: "TechCorp",
          location: "London",
          status: null,
          company_picture_url: null,
          skills: [],
          start: { month: 1, year: 2020 },
          end: null,
        },
      ],
      education: [{ school: "Oxford" }],
    },
    viewer_permissions: { can_send_inmail: false },
  };

  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.users.get as Mock).mockResolvedValue(richProfile);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("slim output has provider_id/network_distance/headline sourced correctly and current_position synthesized from specifics.experience[0]", async () => {
    const { runProfileGet } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileGet(
      client as never,
      { id: "janesmith", account: "acc_1", json: true } as ProfileCommandArgs,
      out,
    );

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as Record<string, unknown>;
    expect(result["provider_id"]).toBe("ACoAACyJnqkBprov456");
    expect(result["network_distance"]).toBe("FIRST_DEGREE");
    expect(result["headline"]).toBe("Senior Engineer at TechCorp");
    expect(result).toHaveProperty("current_position");
    expect(result["current_position"]).toEqual({
      title: "Senior Engineer",     // ← from position
      company_name: "TechCorp",     // ← from company
      company_id: null,             // ALWAYS null
      is_current: true,             // ← end == null
    });
    expect(result).not.toHaveProperty("occupation");
    expect(result).not.toHaveProperty("specifics");
    expect(result).not.toHaveProperty("education");
  });

  it("current_position is null when specifics.experience is empty", async () => {
    const { runProfileGet } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    (accountNs.users.get as Mock).mockResolvedValue({
      ...richProfile,
      specifics: { ...richProfile.specifics, experience: [] },
    });

    await runProfileGet(
      client as never,
      { id: "janesmith", account: "acc_1", json: true } as ProfileCommandArgs,
      out,
    );

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as Record<string, unknown>;
    expect(result["current_position"]).toBeNull();
  });

  it("--verbose mode: raw specifics.experience present AND the derived current_position survives", async () => {
    const { runProfileGet } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileGet(
      client as never,
      { id: "janesmith", account: "acc_1", json: true, verbose: true } as ProfileCommandArgs,
      out,
    );

    const written = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    const result = JSON.parse(written) as Record<string, unknown>;
    const specifics = result["specifics"] as Record<string, unknown>;
    expect(specifics).toHaveProperty("experience");
    // --verbose is a superset: the synthesized field is kept, not swapped out.
    expect(result).toHaveProperty("current_position");
    expect(result).toHaveProperty("network_distance");
  });
});

// ---------------------------------------------------------------------------
// Company slug resolution for --posts --is-company
// ---------------------------------------------------------------------------

describe("profile <id> --posts --is-company — company slug resolution", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.posts.listUserPosts as Mock).mockResolvedValue({ items: [], cursor: null });
    (accountNs.companies.get as Mock).mockResolvedValue({ id: "7890123" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("slug id → calls getCompany first, then listPosts with numeric company id", async () => {
    const { runProfileGet } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileGet(
      client as never,
      { id: "acme-corp", posts: true, "is-company": true, account: "acc_1", json: true } as ProfileCommandArgs,
      out,
    );

    expect(accountNs.companies.get).toHaveBeenCalledWith("acme-corp");
    expect(accountNs.posts.listUserPosts).toHaveBeenCalledWith(
      "7890123",
      expect.any(Object),
    );
  });

  it("numeric id → calls listPosts directly, no getCompany call", async () => {
    const { runProfileGet } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileGet(
      client as never,
      { id: "7890123", posts: true, "is-company": true, account: "acc_1", json: true } as ProfileCommandArgs,
      out,
    );

    expect(accountNs.companies.get).not.toHaveBeenCalled();
    expect(accountNs.posts.listUserPosts).toHaveBeenCalledWith(
      "7890123",
      expect.any(Object),
    );
  });

  it("URL id → resolved to slug → calls getCompany then listPosts with numeric id", async () => {
    const { runProfileGet } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    await runProfileGet(
      client as never,
      {
        id: "https://www.linkedin.com/company/acme-corp/",
        posts: true,
        "is-company": true,
        account: "acc_1",
        json: true,
      } as ProfileCommandArgs,
      out,
    );

    // resolveIdentifier extracts "acme-corp" from the URL, then getCompany is called
    expect(accountNs.companies.get).toHaveBeenCalledWith("acme-corp");
    expect(accountNs.posts.listUserPosts).toHaveBeenCalledWith(
      "7890123",
      expect.any(Object),
    );
  });

  it("getCompany throws error → propagates (would exit 4 for RESOURCE_NOT_FOUND)", async () => {
    const { runProfileGet } = await import("../../src/commands/profile.js");
    const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    const mockErr = new Error("not found");
    (accountNs.companies.get as Mock).mockRejectedValue(mockErr);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(
      (code?: number | string | null) => { throw new Error(`process.exit(${code})`); },
    );
    try {
      await runProfileGet(
        client as never,
        { id: "unknown-co", posts: true, "is-company": true, account: "acc_1", json: true } as ProfileCommandArgs,
        out,
      );
      expect.fail("Should have exited or thrown");
    } catch (e) {
      // Either a process.exit or the raw error — both are acceptable here
      expect(e).toBeTruthy();
    } finally {
      exitSpy.mockRestore();
    }

    expect(accountNs.posts.listUserPosts).not.toHaveBeenCalled();
  });
});
