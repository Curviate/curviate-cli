/**
 * `profile` group: routing of the flags to the SDK call, id resolution (slug -> provider id), --sections,
 * slim vs --verbose output, write commands, insight reads. Run functions against mocks.
 */
import { describe, it, expect } from "vitest";
import { CurviateError } from "@curviate/sdk";
import { CAPTURED_EXPERIENCE, CAPTURED_EDUCATION } from "../fixtures/profile-sections.js";
import {
  profileCommand, runProfileAnalytics, runProfileEndorse, runProfileFollow, runProfileFollowers, runProfileFollowing,
  runProfileGet, runProfileMe, runProfileRelations, runProfileSsi, runProfileSubscription, runProfileUnfollow,
  runProfileUpdate, runProfileVisitors,
} from "../../src/commands/profile.js";
import { exitCode } from "../helpers/exit-code.js";
import { calls, go, mkEnv, previews, prints, refuses, streams, text, type Args, type Run } from "../helpers/f3-unit.js";

const PAGE = { items: [], cursor: null };
const SHAPE = {
  users: {
    get: { object: "user_profile", id: "ACoAA_resolved" },
    update: { object: "user", id: "me" },
    follow: { object: "follow" },
    unfollow: { object: "unfollow" },
    listFollowers: PAGE,
    listFollowing: PAGE,
    listRelations: PAGE,
    endorseSkill: { success: true },
  },
  posts: { listUserPosts: PAGE, listUserReactions: PAGE },
  comments: { listUserComments: PAGE },
  companies: { get: { id: "7890123" } },
  profile: {
    subscription: { has_premium: false, plan_title: null, subscriptions: [] },
    analytics: { profile_viewers: { count: 12 }, post_impressions: { count: 0 }, search_appearances: { count: null } },
    visitors: { items: [{ kind: "identified", name: "Jane Doe" }], cursor: null },
    ssi: { overall_score: 62.3, active_seat: true },
  },
};
const ANY = expect.any(Object);
const notFound = new CurviateError({ code: "RESOURCE_NOT_FOUND", message: "Member not found.", httpStatus: 404, userFixable: false, retryLikelyToSucceed: false });
const secs = (...s: string[]) => [expect.objectContaining({ linkedin_sections: s })];

describe("profile: which SDK call each flag makes", () => {
  calls(SHAPE, [
    ["me -> users.get('me', {})", runProfileMe, {}, "users.get", ["me", {}]],
    ["<url> -> users.get(slug)", runProfileGet, { id: "https://www.linkedin.com/in/jdoe/" }, "users.get", ["jdoe", ANY]],
    ["<id> --posts", runProfileGet, { id: "jdoe", posts: true }, "posts.listUserPosts", ["jdoe", ANY]],
    ["<id> --comments", runProfileGet, { id: "jdoe", comments: true }, "comments.listUserComments", ["jdoe", ANY]],
    ["<id> --reactions", runProfileGet, { id: "jdoe", reactions: true }, "posts.listUserReactions", ["jdoe", ANY]],
    ["<id> --followers", runProfileGet, { id: "jdoe", followers: true }, "users.listFollowers", ["jdoe", ANY]],
    ["me --posts is one self-scoped call", runProfileMe, { posts: true }, "posts.listUserPosts", ["me", ANY]],
    ["me --comments", runProfileMe, { comments: true }, "comments.listUserComments", ["me", ANY]],
    ["me --reactions", runProfileMe, { reactions: true }, "posts.listUserReactions", ["me", ANY]],
    ["me --followers", runProfileMe, { followers: true }, "users.listFollowers", ["me", ANY]],
    ["me --posts --comments: posts wins", runProfileMe, { posts: true, comments: true }, "posts.listUserPosts", ["me", ANY]],
    ["--posts --is-company, numeric id: no company lookup", runProfileGet, { id: "7890123", posts: true, "is-company": true }, "posts.listUserPosts", ["7890123", ANY]],
    ["--posts --is-company, slug: company lookup, then the numeric id", runProfileGet, { id: "acme-corp", posts: true, "is-company": true }, "posts.listUserPosts", ["7890123", ANY]],
    ["--posts --is-company, company URL: slug extracted, then looked up", runProfileGet, { id: "https://www.linkedin.com/company/acme-corp/", posts: true, "is-company": true }, "companies.get", ["acme-corp"]],
    ["me --sections experience,education auto-prefixes", runProfileMe, { sections: "experience,education" }, "users.get", ["me", ...secs("linkedin_experience", "linkedin_education")]],
    ["me --sections '*'", runProfileMe, { sections: "*" }, "users.get", ["me", ...secs("linkedin_*")]],
    ["me --sections linkedin_skills passes unchanged", runProfileMe, { sections: "linkedin_skills" }, "users.get", ["me", ...secs("linkedin_skills")]],
    ["<id> --sections experience auto-prefixes", runProfileGet, { id: "ACoAAA_x", sections: "experience" }, "users.get", ["ACoAAA_x", ...secs("linkedin_experience")]],
    ["update maps flags to snake_case body keys, target me", runProfileUpdate, { headline: "Builder", bio: "hi", "first-name": "Ada", "last-name": "L" }, "users.update", ["me", { first_name: "Ada", last_name: "L", headline: "Builder", bio: "hi" }]],
    ["update --skills becomes the add-only [{name}] shape", runProfileUpdate, { skills: "Rust, Go" }, "users.update", ["me", { skills: [{ name: "Rust" }, { name: "Go" }] }]],
    ["follow is one argument", runProfileFollow, { id: "ACoAAA_x" }, "users.follow", ["ACoAAA_x"]],
    ["unfollow is one argument", runProfileUnfollow, { id: "ACoAAA_x" }, "users.unfollow", ["ACoAAA_x"]],
    ["follow <slug> follows the RESOLVED provider id", runProfileFollow, { id: "raphael-redmer" }, "users.follow", ["ACoAA_resolved"]],
    ["unfollow <slug> unfollows the resolved id", runProfileUnfollow, { id: "raphael-redmer" }, "users.unfollow", ["ACoAA_resolved"]],
    ["followers", runProfileFollowers, { id: "me" }, "users.listFollowers", ["me", {}]],
    ["following forwards --limit/--cursor", runProfileFollowing, { id: "me", limit: "3", cursor: "c1" }, "users.listFollowing", ["me", { limit: 3, cursor: "c1" }]],
    ["endorse <slug> endorses the resolved id", runProfileEndorse, { id: "raphael-redmer", "endorsement-id": "skill_123" }, "users.endorseSkill", ["ACoAA_resolved", { endorsement_id: "skill_123" }]],
    ["endorse <provider id> passes through", runProfileEndorse, { id: "ACoAAdirect", "endorsement-id": "skill_9" }, "users.endorseSkill", ["ACoAAdirect", { endorsement_id: "skill_9" }]],
    ["endorse <url> is normalised then resolved", runProfileEndorse, { id: "https://www.linkedin.com/in/some-user/", "endorsement-id": "skill_1" }, "users.get", ["some-user", {}]],
    ["subscription takes no argument", runProfileSubscription, {}, "profile.subscription", []],
    ["analytics takes no argument", runProfileAnalytics, {}, "profile.analytics", []],
    ["ssi takes no argument", runProfileSsi, {}, "profile.ssi", []],
    ["visitors forwards --limit/--cursor", runProfileVisitors, { limit: "10", cursor: "cur_1" }, "profile.visitors", [{ limit: 10, cursor: "cur_1" }]],
  ]);

  it("a slug is resolved with users.get(slug, {}); a provider id never is", async () => {
    expect((await go(SHAPE, runProfileFollow, { id: "raphael-redmer" })).fn("users.get")).toHaveBeenCalledWith("raphael-redmer", {});
    for (const [run, args] of [[runProfileFollow, { id: "ACoAAA_x" }], [runProfileEndorse, { id: "ACoAAdirect", "endorsement-id": "s" }]] as Array<[Run, Args]>) {
      expect((await go(SHAPE, run, args)).fn("users.get")).not.toHaveBeenCalled();
    }
  });

  it("<slug> --sections resolves first, then fetches the sections with the resolved id; <provider id> and `me` make one call", async () => {
    const e = await go(SHAPE, runProfileGet, { id: "raphael-redmer", sections: "linkedin_experience" });
    expect(e.fn("users.get").mock.calls).toEqual([["raphael-redmer", {}], ["ACoAA_resolved", expect.objectContaining({ linkedin_sections: ["linkedin_experience"] })]]);
    for (const [run, id] of [[runProfileGet, "ACoAAA_x"], [runProfileMe, undefined]] as Array<[Run, string | undefined]>) {
      expect((await go(SHAPE, run, { id, sections: "linkedin_experience" })).fn("users.get")).toHaveBeenCalledTimes(1);
    }
    expect((await go(SHAPE, runProfileGet, { id: "jdoe" })).fn("users.get").mock.calls).toEqual([["jdoe", {}]]);
  });

  it("me --posts makes exactly one call: no users.get pre-call, no other list method", async () => {
    const e = await go(SHAPE, runProfileMe, { posts: true });
    expect(e.fn("users.get")).not.toHaveBeenCalled();
    for (const p of ["comments.listUserComments", "posts.listUserReactions", "users.listFollowers"]) expect(e.fn(p)).not.toHaveBeenCalled();
  });

  it.each(["update", "follow", "unfollow"])("%s (a write) declares no pagination flags", (n) => {
    const args = (profileCommand as unknown as { subCommands: Record<string, { args: object }> }).subCommands[n]!.args;
    for (const f of ["limit", "cursor", "all", "max-pages"]) expect(args).not.toHaveProperty(f);
  });

  it("relations walks listRelations", async () => {
    expect((await go(SHAPE, runProfileRelations)).fn("users.listRelations")).toHaveBeenCalled();
  });

  it("the removed --notify flag and a --description on update are gone", () => {
    const cmd = profileCommand as unknown as { args?: Record<string, unknown>; subCommands?: Record<string, { args?: Record<string, unknown> }> };
    expect(cmd.args).not.toHaveProperty("notify");
    expect(cmd.subCommands!["me"]!.args).not.toHaveProperty("notify");
    expect(cmd.subCommands!["update"]!.args).not.toHaveProperty("description");
  });

  it("update never forwards a stray description", async () => {
    const e = await go(SHAPE, runProfileUpdate, { headline: "x", description: "SHOULD NOT LEAK" });
    expect(e.fn("users.update").mock.calls[0]![1]).not.toHaveProperty("description");
  });
});

describe("profile: refusals and failures", () => {
  refuses(SHAPE, [
    ["me --all (a single profile is not paginated)", runProfileMe, { all: true }, 2],
    ["me --sections bogus-section", runProfileMe, { sections: "bogus-section" }, 2],
    ["me --sections ''", runProfileMe, { sections: "" }, 2],
    ["<id> --sections bogus-section", runProfileGet, { id: "jdoe", sections: "bogus-section" }, 2],
    ["<id> --sections ''", runProfileGet, { id: "jdoe", sections: "" }, 2],
    ["me with no connected account", runProfileMe, { account: null }, 2],
    ["update with no updatable field", runProfileUpdate, {}, 2],
    ["subscription --all", runProfileSubscription, { all: true }, 2],
    ["analytics --all", runProfileAnalytics, { all: true }, 2],
    ["ssi --all", runProfileSsi, { all: true }, 2],
    ["subscription with no connected account", runProfileSubscription, { account: null }, 2],
  ]);

  it("a bad --sections value is named on stderr", async () => {
    const e = mkEnv(SHAPE);
    expect(await exitCode(() => runProfileMe(e.client as never, { account: "acc_1", sections: "bogus-section" }, e.out as never))).toBe(2);
    expect(e.out.stderr.write.mock.calls.join("")).toContain("bogus-section");
  });

  it.each([
    ["follow", runProfileFollow, { id: "no-such-member" }, "users.follow"],
    ["endorse", runProfileEndorse, { id: "no-such-member", "endorsement-id": "s" }, "users.endorseSkill"],
    ["<slug> --sections", runProfileGet, { id: "no-such-member", sections: "linkedin_experience" }, "users.get"],
  ] as Array<[string, Run, Args, string]>)("%s: an unresolvable slug surfaces users.get's 404 as exit 4, no write or second fetch", async (_l, run, args, path) => {
    const e = mkEnv(SHAPE);
    e.fn("users.get").mockRejectedValueOnce(notFound);
    expect(await exitCode(() => run(e.client as never, { account: "acc_1", json: true, ...args }, e.out as never))).toBe(4);
    if (path === "users.get") expect(e.fn(path)).toHaveBeenCalledTimes(1);
    else expect(e.fn(path)).not.toHaveBeenCalled();
  });

  it("a company lookup failure propagates and lists nothing", async () => {
    const e = mkEnv(SHAPE);
    e.fn("companies.get").mockRejectedValue(new Error("not found"));
    const r = await exitCode(() => runProfileGet(e.client as never, { id: "unknown-co", posts: true, "is-company": true, account: "acc_1", json: true }, e.out as never)).catch((err) => err);
    expect(r).toBeTruthy();
    expect(e.fn("posts.listUserPosts")).not.toHaveBeenCalled();
  });

  it("relations --all --max-pages 1 truncates: sentinel on stdout, prose on stderr", async () => {
    const e = await go(SHAPE, runProfileRelations, { json: undefined, all: true, "max-pages": "1" }, (x) =>
      x.fn("users.listRelations").mockResolvedValueOnce({ items: [{ id: "A" }, { id: "B" }], cursor: "c1" }),
    );
    const lines = text(e.out).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([{ id: "A" }, { id: "B" }, { object: "stream_truncated", pages_fetched: 1, has_more: true }]);
    expect(e.out.stderr.write.mock.calls.join("")).toMatch(/truncat/i);
  });
});

describe("profile: output", () => {
  prints(SHAPE, [
    ["subscription --json (a free account is a result, not an error)", runProfileSubscription, {}, "profile.subscription"],
    ["analytics --json keeps a real zero apart from a null card", runProfileAnalytics, {}, "profile.analytics"],
    ["visitors --json", runProfileVisitors, {}, "profile.visitors"],
    ["ssi --json keeps float precision", runProfileSsi, {}, "profile.ssi"],
  ]);
  streams(SHAPE, [
    ["relations", runProfileRelations, {}, "users.listRelations"],
    ["visitors", runProfileVisitors, {}, "profile.visitors"],
  ]);
  previews(SHAPE, [
    ["update", runProfileUpdate, { headline: "x" }, "users.update", { body: { headline: "x" } }],
    ["follow", runProfileFollow, { id: "ACoAAA_x" }, "users.follow", { body: {} }],
  ]);

  it("follow / endorse <slug> --preview reads (resolves) but never writes, and renders the resolved id", async () => {
    const e = await go(SHAPE, runProfileFollow, { id: "raphael-redmer", preview: true });
    expect(e.fn("users.follow")).not.toHaveBeenCalled();
    expect(JSON.parse(text(e.out)).args).toEqual({ user_id: "ACoAA_resolved" });
    const n = await go(SHAPE, runProfileEndorse, { id: "raphael-redmer", "endorsement-id": "skill_123", preview: true });
    expect(n.fn("users.endorseSkill")).not.toHaveBeenCalled();
    expect(JSON.parse(text(n.out)).args).toMatchObject({ id: "ACoAA_resolved" });
  });
});

describe("profile: slim vs --verbose", () => {
  const rich = {
    object: "user_profile", id: "ACoAACyJnqkBprov123", first_name: "John", last_name: "Doe", public_identifier: "johndoe",
    location: "Berlin", description: "Building things at Acme", emails: ["john@example.com"], entity_urn: "urn:li:member:123",
    specifics: { is_premium: false, network_distance: "FIRST_DEGREE", experience: CAPTURED_EXPERIENCE, education: CAPTURED_EDUCATION },
  };
  const read = async (run: Run, args: Args, profile: object = rich) => {
    const e = await go(SHAPE, run, args, (x) => x.fn("users.get").mockResolvedValue(profile));
    return JSON.parse(text(e.out)) as Record<string, unknown>;
  };
  const FOUNDER = { title: "Founder", company_name: "Example Ventures", company_id: "112013061", is_current: true };

  it("me: exactly the 9 slim fields, current_position from specifics.experience[0], no heavy fields", async () => {
    const r = await read(runProfileMe, {});
    expect(Object.keys(r)).toHaveLength(9);
    expect(r).toMatchObject({ provider_id: "ACoAACyJnqkBprov123", headline: "Building things at Acme", emails: ["john@example.com"], is_premium: false, current_position: FOUNDER });
    for (const k of ["occupation", "organizations", "entity_urn", "specifics", "education"]) expect(r).not.toHaveProperty(k);
  });

  it("<id>: network_distance and headline sourced correctly; current_position null when there is no experience", async () => {
    const r = await read(runProfileGet, { id: "janesmith" });
    expect(r).toMatchObject({ provider_id: "ACoAACyJnqkBprov123", network_distance: "FIRST_DEGREE", current_position: FOUNDER });
    const none = await read(runProfileGet, { id: "janesmith" }, { ...rich, specifics: { ...rich.specifics, experience: [] } });
    expect(none["current_position"]).toBeNull();
  });

  it("is_current is false end-to-end for a role the member has left", async () => {
    const r = await read(runProfileMe, {}, { ...rich, specifics: { ...rich.specifics, experience: [CAPTURED_EXPERIENCE[1]] } });
    expect(r["current_position"]).toEqual({ title: "Senior Machine Learning Engineer", company_name: "Example Systems", company_id: "112013062", is_current: false });
  });

  it.each([[runProfileMe, {}], [runProfileGet, { id: "janesmith" }]] as Array<[Run, Args]>)("--verbose is the full response (no current_position synthesis)", async (run, args) => {
    const r = await read(run, { ...args, verbose: true });
    expect(r).toHaveProperty("specifics.experience");
    expect(r).not.toHaveProperty("current_position");
  });

  describe.each([["profile <id>", runProfileGet, 8], ["profile me", runProfileMe, 9]] as Array<[string, Run, number]>)("%s --sections in slim output", (_n, run, slimKeys) => {
    const SKILLS = [{ name: "TypeScript", endorsement_count: 3, endorsed: false }];
    const withSkills = { ...rich, specifics: { ...rich.specifics, skills: SKILLS } };
    const sections = (flags: Args) => read(run, { id: "ACoAAA_x", ...flags }, withSkills);

    it("adds exactly the requested sections under their own names", async () => {
      const r = await sections({ sections: "education,skills" });
      expect(r).toMatchObject({ education: CAPTURED_EDUCATION, skills: SKILLS });
      expect(r).not.toHaveProperty("experience");
      expect(Object.keys(r)).toHaveLength(slimKeys + 2);
    });
    it("a _preview value maps to the same section; a requested section the response lacks is null", async () => {
      const r = await sections({ sections: "linkedin_education_preview" });
      expect(r["education"]).toEqual(CAPTURED_EDUCATION);
      expect(Object.keys(r)).toHaveLength(slimKeys + 1);
      expect(await sections({ sections: "languages" })).toHaveProperty("languages", null);
    });
    it("'*' adds every section; --fields can select one; --verbose with --sections is the full response", async () => {
      const all = await sections({ sections: "*" });
      for (const k of ["experience", "education", "skills", "languages", "certifications", "volunteer_experience", "projects", "recommendations", "interests"]) expect(all).toHaveProperty(k);
      expect(Object.keys(all)).toHaveLength(slimKeys + 9);
      const only = await sections({ sections: "education", fields: "education" });
      expect(Object.keys(only).filter((k) => k !== "source" && k !== "observed_at")).toEqual(["education"]);
      expect(await sections({ sections: "education", verbose: true })).toEqual(withSkills);
    });
  });
});
