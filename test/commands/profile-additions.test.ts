/**
 * Tests for the new `profile` subcommands: update / follow / unfollow /
 * followers / following, plus the connections -> relations rename.
 *
 * Assert the SDK method called + its exact args (the wire contract).
 *   profile update      → users.update("me", body)  (NO description key)
 *   profile follow <id> → users.follow(id)  (bodyless)
 *   profile unfollow <id> → users.unfollow(id)  (bodyless)
 *   profile followers <id> → users.listFollowers(id, params)
 *   profile following <id> → users.listFollowing(id, params)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { CurviateError } from "@curviate/sdk";

function makeAccountNs() {
  return {
    users: {
      get: vi.fn(),
      update: vi.fn(),
      follow: vi.fn(),
      unfollow: vi.fn(),
      listFollowers: vi.fn(),
      listFollowing: vi.fn(),
      listRelations: vi.fn(),
    },
  };
}

function makeClient(accountNs: ReturnType<typeof makeAccountNs>) {
  return { account: vi.fn().mockReturnValue(accountNs) };
}

function makeOut() {
  return { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
}

function mockExit() {
  return vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new Error(`process.exit(${code})`);
  });
}

type Args = Record<string, unknown>;

describe("profile update", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;
  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.users.update as Mock).mockResolvedValue({ object: "user", id: "me" });
  });
  afterEach(() => vi.restoreAllMocks());

  it("maps flags to snake_case body keys and targets 'me'", async () => {
    const { runProfileUpdate } = await import("../../src/commands/profile.js");
    await runProfileUpdate(
      client as never,
      { headline: "Builder", bio: "hi", "first-name": "Ada", "last-name": "L", account: "acc_1", json: true } as Args,
      makeOut(),
    );
    expect(accountNs.users.update).toHaveBeenCalledWith("me", {
      first_name: "Ada",
      last_name: "L",
      headline: "Builder",
      bio: "hi",
    });
  });

  it("maps --skills (comma list) to the [{name}] add-only body shape", async () => {
    const { runProfileUpdate } = await import("../../src/commands/profile.js");
    await runProfileUpdate(client as never, { skills: "Rust, Go", account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.users.update).toHaveBeenCalledWith("me", { skills: [{ name: "Rust" }, { name: "Go" }] });
  });

  it("never emits a description key (there is no such flag or body field)", async () => {
    const { runProfileUpdate } = await import("../../src/commands/profile.js");
    // Even if a stray description-shaped arg is passed, it must not be forwarded.
    await runProfileUpdate(client as never, { headline: "x", description: "SHOULD NOT LEAK", account: "acc_1", json: true } as Args, makeOut());
    const body = (accountNs.users.update as Mock).mock.calls[0]![1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("description");
  });

  it("with no updatable field exits 2 and makes no SDK call", async () => {
    const { runProfileUpdate } = await import("../../src/commands/profile.js");
    const exitSpy = mockExit();
    try {
      await runProfileUpdate(client as never, { account: "acc_1" } as Args, makeOut());
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.users.update).not.toHaveBeenCalled();
  });

  it("--preview renders the body and never dumps raw picture bytes", async () => {
    const { runProfileUpdate } = await import("../../src/commands/profile.js");
    const out = makeOut();
    await runProfileUpdate(client as never, { headline: "x", account: "acc_1", preview: true, json: true } as Args, out);
    expect(accountNs.users.update).not.toHaveBeenCalled();
    const preview = JSON.parse((out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join(""));
    expect(preview.method).toBe("users.update");
    expect(preview.body).toMatchObject({ headline: "x" });
  });
});

describe("profile follow / unfollow (bodyless)", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;
  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.users.follow as Mock).mockResolvedValue({ object: "follow" });
    (accountNs.users.unfollow as Mock).mockResolvedValue({ object: "unfollow" });
  });
  afterEach(() => vi.restoreAllMocks());

  it("profile follow <id> calls users.follow with a single argument", async () => {
    const { runProfileFollow } = await import("../../src/commands/profile.js");
    await runProfileFollow(client as never, { id: "ACoAAA_x", account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.users.follow).toHaveBeenCalledWith("ACoAAA_x");
    expect((accountNs.users.follow as Mock).mock.calls[0]).toHaveLength(1);
  });

  it("profile unfollow <id> calls users.unfollow with a single argument", async () => {
    const { runProfileUnfollow } = await import("../../src/commands/profile.js");
    await runProfileUnfollow(client as never, { id: "ACoAAA_x", account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.users.unfollow).toHaveBeenCalledWith("ACoAAA_x");
    expect((accountNs.users.unfollow as Mock).mock.calls[0]).toHaveLength(1);
  });

  it("profile follow --preview renders bodyless preview, no SDK call", async () => {
    const { runProfileFollow } = await import("../../src/commands/profile.js");
    const out = makeOut();
    await runProfileFollow(client as never, { id: "ACoAAA_x", account: "acc_1", preview: true, json: true } as Args, out);
    expect(accountNs.users.follow).not.toHaveBeenCalled();
    const preview = JSON.parse((out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join(""));
    expect(preview.method).toBe("users.follow");
    expect(preview.body).toEqual({});
  });

  // D6: slug/vanity identifiers 404 on the follow endpoint (provider-id only),
  // while profile/connect/message auto-resolve. Wire the same id-resolution:
  // a URL/slug is resolved to the member's provider id via a users.get read
  // (which notifies no one) before the follow/unfollow write.

  it("profile follow <slug> resolves the slug to a provider id via users.get, then follows (D6)", async () => {
    (accountNs.users.get as Mock).mockResolvedValue({ object: "user_profile", id: "ACoAA_resolved" });
    const { runProfileFollow } = await import("../../src/commands/profile.js");
    await runProfileFollow(client as never, { id: "raphael-redmer", account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.users.get).toHaveBeenCalledWith("raphael-redmer", {});
    expect(accountNs.users.follow).toHaveBeenCalledWith("ACoAA_resolved");
  });

  it("profile unfollow <slug> resolves the slug via users.get, then unfollows (D6)", async () => {
    (accountNs.users.get as Mock).mockResolvedValue({ object: "user_profile", id: "ACoAA_resolved" });
    const { runProfileUnfollow } = await import("../../src/commands/profile.js");
    await runProfileUnfollow(client as never, { id: "raphael-redmer", account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.users.get).toHaveBeenCalledWith("raphael-redmer", {});
    expect(accountNs.users.unfollow).toHaveBeenCalledWith("ACoAA_resolved");
  });

  it("profile follow <provider_id> skips the resolve call (already a provider id) (D6)", async () => {
    const { runProfileFollow } = await import("../../src/commands/profile.js");
    await runProfileFollow(client as never, { id: "ACoAAA_x", account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.users.get).not.toHaveBeenCalled();
    expect(accountNs.users.follow).toHaveBeenCalledWith("ACoAAA_x");
  });

  it("profile follow <slug> --preview resolves via users.get (read) and renders the RESOLVED id, no follow write (D6)", async () => {
    (accountNs.users.get as Mock).mockResolvedValue({ object: "user_profile", id: "ACoAA_resolved" });
    const { runProfileFollow } = await import("../../src/commands/profile.js");
    const out = makeOut();
    await runProfileFollow(client as never, { id: "raphael-redmer", account: "acc_1", preview: true, json: true } as Args, out);
    expect(accountNs.users.get).toHaveBeenCalledWith("raphael-redmer", {});
    expect(accountNs.users.follow).not.toHaveBeenCalled();
    const preview = JSON.parse((out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join(""));
    expect(preview.method).toBe("users.follow");
    expect(preview.args).toEqual({ user_id: "ACoAA_resolved" });
  });

  it("profile follow <unresolvable-slug> surfaces users.get's 404 as exit 4, no follow write (D6)", async () => {
    const notFound = new CurviateError({
      code: "RESOURCE_NOT_FOUND",
      message: "Member not found.",
      httpStatus: 404,
      userFixable: false,
      retryLikelyToSucceed: false,
    });
    (accountNs.users.get as Mock).mockRejectedValue(notFound);
    const { runProfileFollow } = await import("../../src/commands/profile.js");
    const exitSpy = mockExit();
    try {
      await runProfileFollow(client as never, { id: "no-such-member", account: "acc_1", json: true } as Args, makeOut());
      expect.fail("should have exited");
    } catch (e) {
      expect((e as Error).message).toContain("process.exit(4)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(accountNs.users.follow).not.toHaveBeenCalled();
  });
});

describe("profile followers / following (paginated reads)", () => {
  let accountNs: ReturnType<typeof makeAccountNs>;
  let client: ReturnType<typeof makeClient>;
  const page = { object: "follower_list", items: [], cursor: null };
  beforeEach(() => {
    accountNs = makeAccountNs();
    client = makeClient(accountNs);
    (accountNs.users.listFollowers as Mock).mockResolvedValue(page);
    (accountNs.users.listFollowing as Mock).mockResolvedValue(page);
  });
  afterEach(() => vi.restoreAllMocks());

  it("profile followers <id> calls users.listFollowers with the resolved id", async () => {
    const { runProfileFollowers } = await import("../../src/commands/profile.js");
    await runProfileFollowers(client as never, { id: "me", account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.users.listFollowers).toHaveBeenCalledWith("me", {});
  });

  it("profile following <id> calls users.listFollowing and forwards --limit/--cursor", async () => {
    const { runProfileFollowing } = await import("../../src/commands/profile.js");
    await runProfileFollowing(client as never, { id: "me", limit: "3", cursor: "c1", account: "acc_1", json: true } as Args, makeOut());
    expect(accountNs.users.listFollowing).toHaveBeenCalledWith("me", { limit: 3, cursor: "c1" });
  });
});

describe("profile command surface", () => {
  type CommandLike = { subCommands?: Record<string, { args?: Record<string, unknown>; meta?: { name?: string } }> };

  it("registers relations (not connections) and the new follow surface", async () => {
    const { profileCommand } = await import("../../src/commands/profile.js");
    const subs = (profileCommand as unknown as CommandLike).subCommands ?? {};
    expect(subs).toHaveProperty("relations");
    expect(subs).not.toHaveProperty("connections");
    for (const name of ["update", "follow", "unfollow", "followers", "following"]) {
      expect(subs, `profile ${name} is registered`).toHaveProperty(name);
    }
  });

  it("profile update never advertises a --description flag", async () => {
    const { profileCommand } = await import("../../src/commands/profile.js");
    const subs = (profileCommand as unknown as CommandLike).subCommands ?? {};
    const updateArgs = subs["update"]?.args ?? {};
    expect(updateArgs).not.toHaveProperty("description");
    expect(updateArgs).toHaveProperty("headline");
  });

  it("write subcommands (update/follow/unfollow) omit pagination flags", async () => {
    const { profileCommand } = await import("../../src/commands/profile.js");
    const subs = (profileCommand as unknown as CommandLike).subCommands ?? {};
    for (const name of ["update", "follow", "unfollow"]) {
      const args = subs[name]?.args ?? {};
      for (const flag of ["limit", "cursor", "all", "max-pages"]) {
        expect(args, `profile ${name} must NOT include --${flag}`).not.toHaveProperty(flag);
      }
    }
  });

  // D9: the --help example (`experience,education`) advertised bare values
  // that 400 server-side — the vocabulary is linkedin_-prefixed. Both
  // `profile <id> --sections` and `profile me --sections` must show a
  // canonical (linkedin_-prefixed) example, not the broken bare one.

  it("profile <id> --sections help shows a canonical linkedin_-prefixed example, not the broken bare one", async () => {
    const { profileCommand } = await import("../../src/commands/profile.js");
    const cmd = profileCommand as unknown as { args?: Record<string, { description?: string }> };
    const desc = cmd.args?.["sections"]?.description ?? "";
    expect(desc).toContain("linkedin_");
    expect(desc).not.toContain("e.g. experience,education");
  });

  it("profile me --sections help shows a canonical linkedin_-prefixed example, not the broken bare one", async () => {
    const { profileCommand } = await import("../../src/commands/profile.js");
    const subs = (profileCommand as unknown as CommandLike).subCommands ?? {};
    const desc = (subs["me"]?.args as Record<string, { description?: string }> | undefined)?.["sections"]?.description ?? "";
    expect(desc).toContain("linkedin_");
    expect(desc).not.toContain("e.g. experience,education");
  });
});
