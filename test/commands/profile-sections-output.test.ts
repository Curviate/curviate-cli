/**
 * `--sections` fetches profile sections; the slim default output must carry
 * the ones the caller asked for, and only those. Without `--sections` the slim
 * output is unchanged, and `--verbose` stays the full response.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { CAPTURED_EXPERIENCE, CAPTURED_EDUCATION } from "../fixtures/profile-sections.js";
import { runProfileGet, runProfileMe } from "../../src/commands/profile.js";

const SKILLS = [{ name: "TypeScript", endorsement_count: 3, endorsed: false }];
const PROVIDER_ID = "ACoAACyJnqkBprov456";

const profile = {
  object: "user_profile",
  id: PROVIDER_ID,
  first_name: "Jane",
  last_name: "Smith",
  public_identifier: "janesmith",
  description: "Senior Engineer",
  location: "London, UK",
  emails: [],
  specifics: {
    network_distance: "FIRST_DEGREE",
    is_premium: false,
    experience: CAPTURED_EXPERIENCE,
    education: CAPTURED_EDUCATION,
    skills: SKILLS,
  },
};

let users: { get: Mock };
let client: { account: Mock };

beforeEach(() => {
  users = { get: vi.fn().mockResolvedValue(profile) };
  client = { account: vi.fn().mockReturnValue({ users }) };
});
afterEach(() => vi.restoreAllMocks());

type Run = typeof runProfileGet;
async function read(run: Run, flags: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
  await run(client as never, { account: "acc_1", json: true, id: PROVIDER_ID, ...flags } as never, out);
  const written = out.stdout.write.mock.calls.map((c) => String(c[0])).join("");
  return JSON.parse(written) as Record<string, unknown>;
}

describe.each([
  ["profile <id>", runProfileGet, 8],
  ["profile me", runProfileMe as Run, 9],
] as const)("%s --sections in slim output", (_name, run, slimKeys) => {
  it("adds exactly the requested sections, under their own names", async () => {
    const r = await read(run, { sections: "education,skills" });
    expect(r["education"]).toEqual(CAPTURED_EDUCATION);
    expect(r["skills"]).toEqual(SKILLS);
    // experience was fetched in the fixture but not requested: not added.
    expect(r).not.toHaveProperty("experience");
    expect(Object.keys(r)).toHaveLength(slimKeys + 2);
  });

  it("a _preview value maps to the same section", async () => {
    const r = await read(run, { sections: "linkedin_education_preview" });
    expect(r["education"]).toEqual(CAPTURED_EDUCATION);
    expect(Object.keys(r)).toHaveLength(slimKeys + 1);
  });

  it("a requested section the response lacks is null, not missing", async () => {
    const r = await read(run, { sections: "languages" });
    expect(r).toHaveProperty("languages", null);
  });

  it("linkedin_* adds every section", async () => {
    const r = await read(run, { sections: "*" });
    for (const k of ["experience", "education", "skills", "languages", "certifications", "volunteer_experience", "projects", "recommendations", "interests"]) {
      expect(r).toHaveProperty(k);
    }
    expect(r["experience"]).toEqual(CAPTURED_EXPERIENCE);
    expect(Object.keys(r)).toHaveLength(slimKeys + 9);
  });

  it("--fields can select a requested section", async () => {
    const r = await read(run, { sections: "education", fields: "education" });
    expect(Object.keys(r).filter((k) => k !== "source" && k !== "observed_at")).toEqual(["education"]);
    expect(r["education"]).toEqual(CAPTURED_EDUCATION);
  });

  it("control: without --sections the slim output is unchanged", async () => {
    const r = await read(run, {});
    expect(Object.keys(r)).toHaveLength(slimKeys);
    expect(r).not.toHaveProperty("education");
  });

  it("control: --verbose with --sections is still the full response", async () => {
    const r = await read(run, { sections: "education", verbose: true });
    expect(r).toEqual(profile);
  });
});
