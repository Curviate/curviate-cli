/**
 * Tests for slim projection functions in src/lib/slim.ts.
 *
 * Each slim function extracts a stable subset of the full SDK response to
 * keep default CLI output compact without losing the fields agents need.
 */

import { describe, it, expect } from "vitest";
import {
  synthesizeCurrentPosition,
  synthesizeHeadquarters,
  slimProfileMe,
  slimProfile,
  slimCompany,
  slimJob,
  slimInviteSentItem,
  slimInviteSent,
  slimInviteReceivedItem,
  slimInviteReceived,
  slimSearchPostsItem,
  slimSearchPosts,
} from "../../src/lib/slim.js";
import { CAPTURED_EXPERIENCE, CAPTURED_EDUCATION } from "../fixtures/profile-sections.js";

// ---------------------------------------------------------------------------
// synthesizeCurrentPosition
//
// Asserted against CAPTURED_EXPERIENCE — the live capture, not a fixture
// written to match what the projector already assumed. The previous suite
// pinned `position` / `company`-as-a-string / `end`, none of which exist on
// the wire, so it stayed green while the projector emitted title:null,
// company_name-as-an-object, and is_current:true for every ended role.
// ---------------------------------------------------------------------------

describe("synthesizeCurrentPosition", () => {
  const current = CAPTURED_EXPERIENCE[0]!;
  const endedFebruary = CAPTURED_EXPERIENCE[1]!;
  const endedOrdinary = CAPTURED_EXPERIENCE[2]!;

  it("reads title from job_title, the real wire key (there is no `position` key)", () => {
    const result = synthesizeCurrentPosition([current]);
    expect(result!.title).toBe("Founder");
  });

  it("reads company_name from company.name — company is an object on the wire, never a name string", () => {
    const result = synthesizeCurrentPosition([current]);
    expect(result!.company_name).toBe("Example Ventures");
  });

  it("reads company_id from company.id — a genuine company id, unlike the entry's own id", () => {
    const result = synthesizeCurrentPosition([current]);
    expect(result!.company_id).toBe("112013061");
    // The entry id is an experience-entry id and must never leak into it.
    expect(result!.company_id).not.toBe(current["id"]);
  });

  it("is_current true only when ended_on is absent — absence is the only current signal", () => {
    expect(synthesizeCurrentPosition([current])!.is_current).toBe(true);
  });

  it("is_current false for an ended role (ordinary end month)", () => {
    const result = synthesizeCurrentPosition([endedOrdinary]);
    expect(result!.is_current).toBe(false);
    expect(result!.title).toBe("Data Science Developer");
    expect(result!.company_name).toBe("Example Media");
  });

  it("is_current false for a February-ending role, whose ended_on falls in the following March", () => {
    // `03/02/2025` means February 2025 (first-of-month plus 29 days). The
    // presence of the key is what settles is_current; the month never enters.
    expect(endedFebruary["ended_on"]).toBe("03/02/2025");
    expect(synthesizeCurrentPosition([endedFebruary])!.is_current).toBe(false);
  });

  it("the whole captured array projects entry 0, and only entry 0 decides is_current", () => {
    // Ordering guard: a capture whose first entry is the current role must not
    // be read as current merely because some other entry is.
    const result = synthesizeCurrentPosition(CAPTURED_EXPERIENCE);
    expect(result).toEqual({
      title: "Founder",
      company_name: "Example Ventures",
      company_id: "112013061",
      is_current: true,
    });
    const endedFirst = synthesizeCurrentPosition([endedOrdinary, current]);
    expect(endedFirst!.is_current).toBe(false);
  });

  it("empty array → null", () => {
    expect(synthesizeCurrentPosition([])).toBeNull();
  });

  it("non-array input → null", () => {
    expect(synthesizeCurrentPosition(null as unknown as unknown[])).toBeNull();
  });

  it("absent job_title → title null", () => {
    const result = synthesizeCurrentPosition([{ company: { name: "Acme" } }]);
    expect(result!.title).toBeNull();
  });

  it("absent company → company_name and company_id both null", () => {
    const result = synthesizeCurrentPosition([{ job_title: "Dev" }]);
    expect(result!.company_name).toBeNull();
    expect(result!.company_id).toBeNull();
  });

  it("a non-object company projects null rather than leaking a non-string into company_name", () => {
    // Defensive: the wire is index-signature typed, so nothing stops a future
    // shape change reaching here. A visible null beats a wrong-typed value.
    const result = synthesizeCurrentPosition([{ job_title: "Dev", company: "Acme" }]);
    expect(result!.company_name).toBeNull();
    expect(result!.company_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// synthesizeHeadquarters
// ---------------------------------------------------------------------------

describe("synthesizeHeadquarters", () => {
  // Real v2 CompanyProfile `locations[]` item shape: { is_headquarter?,
  // country_code?, city?, postal_code?, area?, street? } — `country_code`/
  // `postal_code`/`area`/`street` all verified live (staging, `company
  // microsoft --verbose`). `area` (region/state, e.g. "Washington") is real
  // and frequently populated (~29% of Microsoft's 45 locations, including
  // its HQ entry) even though the SDK's generated `.d.ts` for this endpoint
  // doesn't declare it — the type under-documents the wire here; `area` was
  // already part of the pre-fix v1-shaped output and stays. `street` is also
  // real on the wire but was never part of the slim output and stays
  // verbose-only (out of scope for this fix — no prior surface to restore).
  // There is no `country` key (fictitious v1 name) — `country_code` is real.
  it("finds is_headquarter:true entry and extracts city/country_code/postal_code/area", () => {
    const result = synthesizeHeadquarters([
      { city: "Berlin", country_code: "DE", postal_code: "10115", area: "Berlin", is_headquarter: false },
      { city: "Munich", country_code: "DE", postal_code: "80333", area: "Bavaria", is_headquarter: true },
    ]);
    expect(result).toEqual({ city: "Munich", country_code: "DE", postal_code: "80333", area: "Bavaria" });
  });

  it("no is_headquarter:true entry → null", () => {
    const result = synthesizeHeadquarters([
      { city: "Paris", country_code: "FR", postal_code: "75001", is_headquarter: false },
    ]);
    expect(result).toBeNull();
  });

  it("empty array → null", () => {
    expect(synthesizeHeadquarters([])).toBeNull();
  });

  it("postal_code absent in hq → postal_code null", () => {
    const result = synthesizeHeadquarters([
      { city: "Austin", country_code: "US", area: "TX", is_headquarter: true },
    ]);
    expect(result!.postal_code).toBeNull();
  });

  it("country_code absent in hq → country_code null", () => {
    const result = synthesizeHeadquarters([
      { city: "Austin", postal_code: "78701", area: "TX", is_headquarter: true },
    ]);
    expect(result!.country_code).toBeNull();
  });

  it("area absent in hq → area null (area is genuinely optional — most locations lack it)", () => {
    const result = synthesizeHeadquarters([
      { city: "Austin", country_code: "US", postal_code: "78701", is_headquarter: true },
    ]);
    expect(result!.area).toBeNull();
  });

  it("does not leak extra keys (zip, is_headquarter, street), and never re-introduces the fictitious v1 country key", () => {
    const result = synthesizeHeadquarters([
      {
        city: "Austin",
        country_code: "US",
        postal_code: "78701",
        area: "TX",
        is_headquarter: true,
        zip: "78701",
        street: "500 Congress Ave",
      },
    ]);
    expect(result).not.toHaveProperty("zip");
    expect(result).not.toHaveProperty("is_headquarter");
    expect(result).not.toHaveProperty("street");
    expect(result).not.toHaveProperty("country");
  });
});

// ---------------------------------------------------------------------------
// slimProfileMe
// ---------------------------------------------------------------------------

describe("slimProfileMe", () => {
  // Real v2 UserProfile shape (`GET /v1/{account_id}/users/{user_id}`, per
  // the SDK's generated types) — `profile me` and `profile <id>` are backed
  // by the IDENTICAL response (userId "me" vs. a target member). There is no
  // top-level `provider_id` (the real identifier is `id`), no top-level
  // `is_premium`/`network_distance` (both nested under `specifics`), no
  // plural-vs-singular `email` (the real field is `emails: string[]`), and
  // no `occupation`/`organizations` field anywhere on this resource.
  // `description` and `bio` are BOTH real and distinct on reads: `description`
  // carries the profile headline, `bio` carries the About-section paragraph
  // (verified live — see slimProfileMe's JSDoc). Both are present here so the
  // headline tests below prove the mapping reads the right one.
  const fullProfile = {
    object: "user_profile",
    id: "ACoAACyJnqkBprov123",
    type: "individual",
    display_name: "John Doe",
    first_name: "John",
    last_name: "Doe",
    public_identifier: "johndoe",
    profile_url: "https://linkedin.com/in/johndoe",
    public_picture_url: "https://media.licdn.com/john.jpg",
    description: "Founder @ RedHire — building AI recruiting agents",
    bio: "20 years building developer tools; ex-Google, ex-Stripe.",
    location: "Berlin, Germany",
    created_at: "2020-01-01T00:00:00.000Z",
    emails: ["john@example.com", "john.doe@work.com"],
    phone_numbers: ["+49123456789"],
    is_blocked: false,
    is_following: true,
    followers_count: 42,
    relations_count: 300,
    specifics: {
      network_distance: "SELF",
      member_id: "member_1",
      can_send_inmail: false,
      is_open_profile: false,
      is_premium: true,
      is_influencer: false,
      experience: CAPTURED_EXPERIENCE,
      education: CAPTURED_EDUCATION,
      throttled_sections: ["experience"],
    },
  };

  it("projects exactly the 9 slim fields", () => {
    const result = slimProfileMe(fullProfile);
    expect(Object.keys(result)).toHaveLength(9);
    expect(Object.keys(result).sort()).toEqual(
      [
        "current_position",
        "emails",
        "first_name",
        "headline",
        "is_premium",
        "last_name",
        "location",
        "provider_id",
        "public_identifier",
      ].sort(),
    );
  });

  it("provider_id sourced from the real id field (there is no top-level provider_id on the wire)", () => {
    const result = slimProfileMe(fullProfile);
    expect(result["provider_id"]).toBe("ACoAACyJnqkBprov123");
  });

  it("headline sourced from description — the real wire serves the profile headline in the description field on reads", () => {
    const result = slimProfileMe(fullProfile);
    expect(result["headline"]).toBe("Founder @ RedHire — building AI recruiting agents");
  });

  it("headline does NOT source from bio — bio holds the About-section paragraph, a separate field", () => {
    const result = slimProfileMe(fullProfile);
    expect(result["headline"]).not.toBe(fullProfile.bio);
    expect(result).not.toHaveProperty("bio");
  });

  it("headline null when description is absent", () => {
    const withoutDescription = Object.fromEntries(
      Object.entries(fullProfile).filter(([k]) => k !== "description"),
    );
    expect(slimProfileMe(withoutDescription)["headline"]).toBeNull();
  });

  it("emails is the real plural array field (v1's singular email always projected null)", () => {
    const result = slimProfileMe(fullProfile);
    expect(result["emails"]).toEqual(["john@example.com", "john.doe@work.com"]);
    expect(result).not.toHaveProperty("email");
  });

  it("emails defaults to an empty array when absent, never null", () => {
    const withoutEmails = Object.fromEntries(
      Object.entries(fullProfile).filter(([k]) => k !== "emails"),
    );
    expect(slimProfileMe(withoutEmails)["emails"]).toEqual([]);
  });

  it("is_premium sourced from specifics.is_premium (nested — no top-level is_premium on the wire)", () => {
    const result = slimProfileMe(fullProfile);
    expect(result["is_premium"]).toBe(true);
  });

  it("is_premium null when specifics is absent", () => {
    const withoutSpecifics = Object.fromEntries(
      Object.entries(fullProfile).filter(([k]) => k !== "specifics"),
    );
    expect(slimProfileMe(withoutSpecifics)["is_premium"]).toBeNull();
  });

  it("current_position synthesized from specifics.experience[0] (parity with profile <id>)", () => {
    const result = slimProfileMe(fullProfile);
    expect(result["current_position"]).toEqual({
      title: "Founder",
      company_name: "Example Ventures",
      company_id: "112013061",
      is_current: true,
    });
  });

  it("current_position is null when specifics.experience absent (no linkedin_sections enrichment)", () => {
    const noExperience = {
      ...fullProfile,
      specifics: Object.fromEntries(
        Object.entries(fullProfile.specifics).filter(([k]) => k !== "experience"),
      ),
    };
    expect(slimProfileMe(noExperience)["current_position"]).toBeNull();
  });

  it("current_position is null when specifics itself is absent", () => {
    const withoutSpecifics = Object.fromEntries(
      Object.entries(fullProfile).filter(([k]) => k !== "specifics"),
    );
    expect(slimProfileMe(withoutSpecifics)["current_position"]).toBeNull();
  });

  it("occupation and organizations are entirely absent — no v2 source for either", () => {
    const result = slimProfileMe(fullProfile);
    expect(result).not.toHaveProperty("occupation");
    expect(result).not.toHaveProperty("organizations");
  });

  it("excludes noise fields (object, type, display_name, profile_url, public_picture_url, description, bio, created_at, phone_numbers, is_blocked, is_following, followers_count, relations_count, raw specifics)", () => {
    const result = slimProfileMe(fullProfile);
    expect(result).not.toHaveProperty("object");
    expect(result).not.toHaveProperty("type");
    expect(result).not.toHaveProperty("display_name");
    expect(result).not.toHaveProperty("profile_url");
    expect(result).not.toHaveProperty("public_picture_url");
    // the raw `description` key itself must not survive verbatim — it is
    // remapped to `headline`, not copied through under its own name.
    expect(result).not.toHaveProperty("description");
    expect(result).not.toHaveProperty("bio");
    expect(result).not.toHaveProperty("created_at");
    expect(result).not.toHaveProperty("phone_numbers");
    expect(result).not.toHaveProperty("is_blocked");
    expect(result).not.toHaveProperty("is_following");
    expect(result).not.toHaveProperty("followers_count");
    expect(result).not.toHaveProperty("relations_count");
    expect(result).not.toHaveProperty("specifics");
  });

  it("location null when absent", () => {
    const sparse = Object.fromEntries(
      Object.entries(fullProfile).filter(([k]) => k !== "location"),
    );
    const result = slimProfileMe(sparse);
    expect(result["location"]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// slimProfile (profile <id>)
// ---------------------------------------------------------------------------

describe("slimProfile", () => {
  // Same real v2 UserProfile shape as slimProfileMe (see that block) — this
  // is `profile <id>`, backed by the identical `GET
  // /v1/{account_id}/users/{user_id}` response with a target member's id
  // instead of "me". `specifics.experience[0]` item shape (verified against
  // a live probe): {id, company, position, location, status,
  // company_picture_url, skills, start, end}. `description` (headline) and
  // `bio` (About-section paragraph) are both real and distinct — see
  // slimProfileMe's fixture comment and slimProfile's JSDoc.
  const fullProfile = {
    object: "user_profile",
    id: "ACoAACyJnqkBprov456",
    type: "individual",
    display_name: "Jane Smith",
    first_name: "Jane",
    last_name: "Smith",
    public_identifier: "janesmith",
    profile_url: "https://linkedin.com/in/janesmith",
    description: "Senior Engineer at TechCorp | Distributed systems",
    bio: "Building scalable backend systems for a decade.",
    location: "London, UK",
    followers_count: 900,
    relations_count: 500,
    specifics: {
      network_distance: "FIRST_DEGREE",
      is_premium: false,
      is_open_to_work: false,
      experience: CAPTURED_EXPERIENCE,
      education: CAPTURED_EDUCATION,
      throttled_sections: ["experience"],
    },
  };

  it("projects exactly the 8 slim fields", () => {
    const result = slimProfile(fullProfile);
    expect(Object.keys(result)).toHaveLength(8);
    expect(Object.keys(result).sort()).toEqual(
      [
        "current_position",
        "first_name",
        "headline",
        "last_name",
        "location",
        "network_distance",
        "provider_id",
        "public_identifier",
      ].sort(),
    );
  });

  it("provider_id sourced from the real id field (there is no top-level provider_id on the wire)", () => {
    const result = slimProfile(fullProfile);
    expect(result["provider_id"]).toBe("ACoAACyJnqkBprov456");
  });

  it("network_distance sourced from specifics.network_distance (nested — no top-level network_distance on the wire)", () => {
    const result = slimProfile(fullProfile);
    expect(result["network_distance"]).toBe("FIRST_DEGREE");
  });

  it("network_distance null when specifics is absent", () => {
    const withoutSpecifics = Object.fromEntries(
      Object.entries(fullProfile).filter(([k]) => k !== "specifics"),
    );
    expect(slimProfile(withoutSpecifics)["network_distance"]).toBeNull();
  });

  it("headline sourced from description — same real wire, same mapping as slimProfileMe", () => {
    const result = slimProfile(fullProfile);
    expect(result["headline"]).toBe("Senior Engineer at TechCorp | Distributed systems");
  });

  it("headline does NOT source from bio — bio holds the About-section paragraph, a separate field", () => {
    const result = slimProfile(fullProfile);
    expect(result["headline"]).not.toBe(fullProfile.bio);
  });

  it("headline null when description is absent", () => {
    const withoutDescription = Object.fromEntries(
      Object.entries(fullProfile).filter(([k]) => k !== "description"),
    );
    expect(slimProfile(withoutDescription)["headline"]).toBeNull();
  });

  it("occupation is entirely absent — no v2 source", () => {
    const result = slimProfile(fullProfile);
    expect(result).not.toHaveProperty("occupation");
  });

  it("current_position synthesized from specifics.experience[0] with correct field mapping", () => {
    const result = slimProfile(fullProfile);
    expect(result["current_position"]).toEqual({
      title: "Founder",                 // <- job_title
      company_name: "Example Ventures", // <- company.name
      company_id: "112013061",          // <- company.id
      is_current: true,                 // <- ended_on absent
    });
  });

  it("company_id is the company's id, never the experience entry's own id", () => {
    const result = slimProfile(fullProfile);
    const pos = result["current_position"] as Record<string, unknown>;
    expect(pos["company_id"]).toBe("112013061");
    expect(pos["company_id"]).not.toBe(CAPTURED_EXPERIENCE[0]!["id"]);
  });

  it("is_current false when the entry carries ended_on", () => {
    const result = slimProfile({
      ...fullProfile,
      specifics: {
        ...fullProfile.specifics,
        // The captured February-ending role: ended 18 months before the
        // captured current one, and must not read as current.
        experience: [CAPTURED_EXPERIENCE[1]],
      },
    });
    const pos = result["current_position"] as Record<string, unknown>;
    expect(pos["is_current"]).toBe(false);
    expect(pos["title"]).toBe("Senior Machine Learning Engineer");
  });

  it("current_position is null when specifics.experience is empty", () => {
    const result = slimProfile({
      ...fullProfile,
      specifics: { ...fullProfile.specifics, experience: [] },
    });
    expect(result["current_position"]).toBeNull();
  });

  it("current_position is null when specifics.experience is absent", () => {
    const noExperience = {
      ...fullProfile,
      specifics: Object.fromEntries(
        Object.entries(fullProfile.specifics).filter(([k]) => k !== "experience"),
      ),
    };
    const result = slimProfile(noExperience);
    expect(result["current_position"]).toBeNull();
  });

  it("current_position is null when specifics itself is absent", () => {
    const withoutSpecifics = Object.fromEntries(
      Object.entries(fullProfile).filter(([k]) => k !== "specifics"),
    );
    expect(slimProfile(withoutSpecifics)["current_position"]).toBeNull();
  });

  it("excludes specifics raw object, display_name, object, type, profile_url, description, bio, followers_count, relations_count", () => {
    const result = slimProfile(fullProfile);
    expect(result).not.toHaveProperty("specifics");
    expect(result).not.toHaveProperty("display_name");
    expect(result).not.toHaveProperty("object");
    expect(result).not.toHaveProperty("type");
    expect(result).not.toHaveProperty("profile_url");
    // the raw `description` key itself must not survive verbatim — it is
    // remapped to `headline`, not copied through under its own name.
    expect(result).not.toHaveProperty("description");
    expect(result).not.toHaveProperty("bio");
    expect(result).not.toHaveProperty("followers_count");
    expect(result).not.toHaveProperty("relations_count");
  });
});

// ---------------------------------------------------------------------------
// slimCompany
// ---------------------------------------------------------------------------

describe("slimCompany", () => {
  // Real v2 CompanyProfile shape (`GET /v1/{account_id}/companies/{identifier}`,
  // per the SDK's generated types) — `employee_count`/`employee_count_range`
  // live nested at `insights.headcount`/`insights.headcount_range.from` (no
  // `to` — the range is documented open-ended-high), the establishment date
  // is a bare year at `establishment_year` (not a `foundation_date` string),
  // the follower count key is singular `follower_count`, and there is no
  // `messaging` field anywhere on this resource.
  const fullCompany = {
    object: "company_profile",
    id: "co_123",
    name: "Acme Corp",
    public_identifier: "acme-corp",
    profile_url: "https://linkedin.com/company/acme-corp",
    industry: ["Technology"],
    website: "https://acme.com",
    establishment_year: 2000,
    follower_count: 12000,
    locations: [
      { city: "Austin", country_code: "US", postal_code: "78701", area: "TX", is_headquarter: true },
      { city: "New York", country_code: "US", postal_code: "10001", is_headquarter: false },
    ],
    insights: {
      headcount: 500,
      headcount_range: { from: 201 },
      average_tenure: 3.2,
    },
    description: "A company description",
    tagline: "Building the future",
    is_active: true,
    viewer_permissions: { can_send_message: false },
    activities: [{ id: "act_1" }],
  };

  it("projects exactly the 11 slim fields", () => {
    const result = slimCompany(fullCompany);
    expect(Object.keys(result)).toHaveLength(11);
    expect(Object.keys(result).sort()).toEqual(
      [
        "employee_count",
        "employee_count_range",
        "establishment_year",
        "follower_count",
        "headquarters",
        "id",
        "industry",
        "name",
        "profile_url",
        "public_identifier",
        "website",
      ].sort(),
    );
  });

  it("excludes messaging entirely — no messaging field exists on the real v2 schema", () => {
    const result = slimCompany(fullCompany);
    expect(result).not.toHaveProperty("messaging");
  });

  it("employee_count sourced from insights.headcount (not a nonexistent top-level employee_count)", () => {
    const result = slimCompany(fullCompany);
    expect(result["employee_count"]).toBe(500);
  });

  it("employee_count_range sourced from insights.headcount_range, {from} only — no to is invented", () => {
    const result = slimCompany(fullCompany);
    expect(result["employee_count_range"]).toEqual({ from: 201 });
    expect(result["employee_count_range"]).not.toHaveProperty("to");
    expect(result["employee_count_range"]).not.toHaveProperty("min");
    expect(result["employee_count_range"]).not.toHaveProperty("max");
  });

  it("employee_count / employee_count_range null when insights is absent", () => {
    const withoutInsights = Object.fromEntries(
      Object.entries(fullCompany).filter(([k]) => k !== "insights"),
    );
    const result = slimCompany(withoutInsights);
    expect(result["employee_count"]).toBeNull();
    expect(result["employee_count_range"]).toBeNull();
  });

  it("employee_count_range.from is null when headcount_range is present but empty", () => {
    const result = slimCompany({ ...fullCompany, insights: { headcount: 500, headcount_range: {} } });
    expect(result["employee_count_range"]).toEqual({ from: null });
  });

  it("establishment_year sourced from the real establishment_year field (not the fictitious foundation_date)", () => {
    const result = slimCompany(fullCompany);
    expect(result["establishment_year"]).toBe(2000);
    expect(result).not.toHaveProperty("foundation_date");
  });

  it("follower_count sourced from the real singular follower_count key", () => {
    const result = slimCompany(fullCompany);
    expect(result["follower_count"]).toBe(12000);
    expect(result).not.toHaveProperty("followers_count");
  });

  it("industry passes through the real array shape unchanged", () => {
    const result = slimCompany(fullCompany);
    expect(result["industry"]).toEqual(["Technology"]);
  });

  it("headquarters synthesized from is_headquarter location (city/country_code/postal_code/area)", () => {
    const result = slimCompany(fullCompany);
    expect(result["headquarters"]).toEqual({ city: "Austin", country_code: "US", postal_code: "78701", area: "TX" });
  });

  it("headquarters is null when no is_headquarter location", () => {
    const result = slimCompany({
      ...fullCompany,
      locations: [
        { city: "Paris", country_code: "FR", postal_code: "75001", is_headquarter: false },
      ],
    });
    expect(result["headquarters"]).toBeNull();
  });

  it("postal_code is null when absent in hq location", () => {
    const result = slimCompany({
      ...fullCompany,
      locations: [{ city: "Berlin", country_code: "DE", is_headquarter: true }],
    });
    const hq = result["headquarters"] as Record<string, unknown>;
    expect(hq["postal_code"]).toBeNull();
  });

  it("excludes viewer_permissions, description, tagline, is_active, activities, insights raw object, locations raw array", () => {
    const result = slimCompany(fullCompany);
    expect(result).not.toHaveProperty("viewer_permissions");
    expect(result).not.toHaveProperty("description");
    expect(result).not.toHaveProperty("tagline");
    expect(result).not.toHaveProperty("is_active");
    expect(result).not.toHaveProperty("activities");
    expect(result).not.toHaveProperty("insights");
    expect(result).not.toHaveProperty("locations");
  });

  it("non-object input projects to an all-null/empty shape (never throws)", () => {
    const result = slimCompany(null);
    expect(result["id"]).toBeNull();
    expect(result["employee_count"]).toBeNull();
    expect(result["employee_count_range"]).toBeNull();
    expect(result["headquarters"]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// slimJob (job get / recruiter job get — shared projection)
// ---------------------------------------------------------------------------

describe("slimJob", () => {
  // Core `job_posting` shape (GET /v1/{account_id}/jobs/{job_id}): the real
  // timestamp field is `created_at` — there is no `published_at` at all on
  // this shape. `company` is a nested object; there is no top-level
  // `company_id`. The applicant-count field is `applications_count`.
  const coreJob = {
    object: "job_posting",
    id: "4428113858",
    title: "Founders Associate",
    company: { id: "67756343", name: "LEAGUES", public_identifier: "leagues" },
    state: "LISTED",
    location: "Stuttgart, Baden-Württemberg, Germany",
    is_repost: false,
    is_application_limit_reached: false,
    created_at: "2026-06-12T10:07:09.000Z",
    applications_count: 75,
    description: "Über deine Rolle: build the founding team.",
    workplace_type: "HYBRID",
    employment_status: "FULL_TIME",
    hiring_team: [],
  };

  // Recruiter `recruiter_job_posting` shape (GET .../recruiter/jobs/{job_id}
  // and .../recruiter/projects/{project_id}/jobs/{job_id}): the opposite —
  // `published_at` IS real here (optional) and there is no `created_at` at
  // all. Still a nested `company` (no top-level `company_id`), still
  // `applications_count`.
  const recruiterJob = {
    object: "recruiter_job_posting",
    id: "4428113858",
    project_id: "proj_1",
    title: "Founders Associate",
    company: { id: "67756343", name: "LEAGUES" },
    state: "LISTED",
    location: "Stuttgart, Baden-Württemberg, Germany",
    applications_count: 75,
    published_at: "2026-06-12T10:08:03.000Z",
    description: "Über deine Rolle: build the founding team.",
    hiring_team: [],
  };

  it("returns exactly the 10 documented slim fields", () => {
    const result = slimJob(coreJob);
    expect(Object.keys(result).sort()).toEqual(
      [
        "applications_count",
        "company",
        "company_id",
        "description",
        "id",
        "location",
        "object",
        "published_at",
        "state",
        "title",
      ].sort(),
    );
  });

  it("keeps description non-empty (the point of the fetch)", () => {
    const result = slimJob(coreJob);
    expect(result["description"]).toBe(coreJob.description);
  });

  it("excludes hiring_team (verbose-only)", () => {
    const result = slimJob(coreJob);
    expect(result).not.toHaveProperty("hiring_team");
  });

  it("v1 legacy field (applicants_counter) is absent — the real key on both shapes is applications_count", () => {
    const result = slimJob(coreJob);
    expect(result).not.toHaveProperty("applicants_counter");
  });

  it("Core shape: passes id, title, company (nested, verbatim), location, state, description through; applications_count maps directly", () => {
    const result = slimJob(coreJob);
    expect(result["id"]).toBe("4428113858");
    expect(result["title"]).toBe("Founders Associate");
    expect(result["company"]).toEqual({ id: "67756343", name: "LEAGUES", public_identifier: "leagues" });
    expect(result["location"]).toBe(coreJob.location);
    expect(result["state"]).toBe("LISTED");
    expect(result["applications_count"]).toBe(75);
    expect(result["description"]).toBe(coreJob.description);
  });

  it("Core shape: company_id is synthesized from company.id (no top-level company_id exists on the real wire)", () => {
    const result = slimJob(coreJob);
    expect(result["company_id"]).toBe("67756343");
  });

  it("company_id ignores a stray flat company_id key — company.id is always the source of truth", () => {
    const result = slimJob({ ...coreJob, company_id: "DECOY_SHOULD_BE_IGNORED" });
    expect(result["company_id"]).toBe("67756343");
  });

  it("Core shape: published_at falls back to created_at (the Core wire has no published_at field at all)", () => {
    const result = slimJob(coreJob);
    expect(result["published_at"]).toBe("2026-06-12T10:07:09.000Z");
  });

  it("Recruiter shape: published_at is real and used directly", () => {
    const result = slimJob(recruiterJob);
    expect(result["published_at"]).toBe("2026-06-12T10:08:03.000Z");
  });

  it("Recruiter shape: company_id and applications_count resolve the same way as Core", () => {
    const result = slimJob(recruiterJob);
    expect(result["company_id"]).toBe("67756343");
    expect(result["applications_count"]).toBe(75);
  });

  it("nullable fields project to null when absent", () => {
    const result = slimJob({ object: "job_posting", id: "1" });
    expect(result["location"]).toBeNull();
    expect(result["published_at"]).toBeNull();
    expect(result["applications_count"]).toBeNull();
    expect(result["company_id"]).toBeNull();
    expect(result["company"]).toBeNull();
  });

  it("non-object input projects to an all-null shape (never throws)", () => {
    const result = slimJob(null);
    expect(result["id"]).toBeNull();
    expect(result["object"]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// slimInviteSentItem / slimInviteSent (v2 shape — GET /v1/{account_id}/invites/sent)
// ---------------------------------------------------------------------------

describe("slimInviteSentItem", () => {
  const fullSentItem = {
    object: "invitation_sent",
    id: "SENT_7419644944484753408",
    created_at: "2026-01-21T10:00:00.000Z",
    message: "Let's connect",
    user: {
      id: "ACoAAAfEwrwBqTunca",
      type: "individual",
      display_name: "Korhan Tunca",
      first_name: "Korhan",
      last_name: "Tunca",
      public_picture_url: "https://media.licdn.com/korhan.jpg",
    },
  };

  it("projects id, created_at, message, and a trimmed user sub-object", () => {
    const result = slimInviteSentItem(fullSentItem);
    expect(result).toEqual({
      id: "SENT_7419644944484753408",
      created_at: "2026-01-21T10:00:00.000Z",
      message: "Let's connect",
      user: {
        id: "ACoAAAfEwrwBqTunca",
        display_name: "Korhan Tunca",
        first_name: "Korhan",
        last_name: "Tunca",
      },
    });
  });

  it("drops user.type and user.public_picture_url (verbose-only) and the per-item object discriminator", () => {
    const result = slimInviteSentItem(fullSentItem);
    const user = result["user"] as Record<string, unknown>;
    expect(user).not.toHaveProperty("type");
    expect(user).not.toHaveProperty("public_picture_url");
    expect(result).not.toHaveProperty("object");
  });

  it("optional top-level fields (created_at, message) project to null when absent — never undefined", () => {
    const result = slimInviteSentItem({
      object: "invitation_sent",
      id: "SENT_x",
      user: { id: "ACoAA1" },
    });
    expect(result["created_at"]).toBeNull();
    expect(result["message"]).toBeNull();
  });

  it("user sub-object projects to null when the source has no user (never crashes)", () => {
    const result = slimInviteSentItem({ object: "invitation_sent", id: "SENT_x" });
    expect(result["user"]).toBeNull();
  });

  it("v1 legacy fields (invited_user_*, inviter, date, parsed_datetime, invitation_text, specifics) are absent — the v2 response never sends them", () => {
    const result = slimInviteSentItem(fullSentItem);
    expect(result).not.toHaveProperty("invited_user");
    expect(result).not.toHaveProperty("invited_user_id");
    expect(result).not.toHaveProperty("invited_user_public_id");
    expect(result).not.toHaveProperty("inviter");
    expect(result).not.toHaveProperty("date");
    expect(result).not.toHaveProperty("parsed_datetime");
    expect(result).not.toHaveProperty("invitation_text");
    expect(result).not.toHaveProperty("specifics");
  });
});

describe("slimInviteSent", () => {
  it("projects the envelope { object, items, cursor } with each item slimmed", () => {
    const result = slimInviteSent({
      object: "invitation_list",
      items: [
        {
          id: "SENT_1",
          created_at: "2026-01-01T00:00:00Z",
          user: { id: "ACoAA1", type: "individual", display_name: "A" },
        },
      ],
      cursor: "next-cursor",
    });
    expect(result["object"]).toBe("invitation_list");
    expect(result["cursor"]).toBe("next-cursor");
    const items = result["items"] as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty("type");
  });

  it("non-object / missing items input projects to an empty-list shape (never throws)", () => {
    expect(slimInviteSent(null)).toEqual({ object: null, items: [], cursor: null });
  });
});

// ---------------------------------------------------------------------------
// slimInviteReceivedItem / slimInviteReceived (v2 shape — GET /v1/{account_id}/invites/received)
// ---------------------------------------------------------------------------

describe("slimInviteReceivedItem", () => {
  const fullReceivedItem = {
    object: "invitation_received",
    id: "RECEIVED_9",
    created_at: "2026-07-10T00:00:00.000Z",
    user: {
      id: "ACoAADwav4UBConstantine",
      type: "individual",
      display_name: "Constantine Pinotsis",
      first_name: "Constantine",
      last_name: "Pinotsis",
      public_picture_url: "https://media.licdn.com/constantine.jpg",
      public_identifier: "constantine-pinotsis",
      profile_url: "https://www.linkedin.com/in/constantine-pinotsis",
      description: "Engineer",
    },
  };

  it("projects id, created_at, and a trimmed user sub-object including public_identifier", () => {
    const result = slimInviteReceivedItem(fullReceivedItem);
    expect(result).toEqual({
      id: "RECEIVED_9",
      created_at: "2026-07-10T00:00:00.000Z",
      user: {
        id: "ACoAADwav4UBConstantine",
        display_name: "Constantine Pinotsis",
        first_name: "Constantine",
        last_name: "Pinotsis",
        public_identifier: "constantine-pinotsis",
      },
    });
  });

  it("drops user.type/public_picture_url/profile_url/description (verbose-only) and the per-item object discriminator", () => {
    const result = slimInviteReceivedItem(fullReceivedItem);
    const user = result["user"] as Record<string, unknown>;
    expect(user).not.toHaveProperty("type");
    expect(user).not.toHaveProperty("public_picture_url");
    expect(user).not.toHaveProperty("profile_url");
    expect(user).not.toHaveProperty("description");
    expect(result).not.toHaveProperty("object");
  });

  it("public_identifier — the field that lets an agent safely pick which invite to accept — projects to null when the platform omits it, never undefined", () => {
    const result = slimInviteReceivedItem({
      object: "invitation_received",
      id: "RECEIVED_x",
      user: { id: "ACoAA1" },
    });
    const user = result["user"] as Record<string, unknown>;
    expect(user["public_identifier"]).toBeNull();
  });

  it("v1 legacy fields (invited_user_*, inviter, date, parsed_datetime, invitation_text, specifics.shared_secret) are absent — the v2 response never sends them", () => {
    const result = slimInviteReceivedItem(fullReceivedItem);
    expect(result).not.toHaveProperty("invited_user");
    expect(result).not.toHaveProperty("inviter");
    expect(result).not.toHaveProperty("date");
    expect(result).not.toHaveProperty("parsed_datetime");
    expect(result).not.toHaveProperty("invitation_text");
    expect(result).not.toHaveProperty("specifics");
  });
});

describe("slimInviteReceived", () => {
  it("projects the envelope { object, items, cursor } with each item slimmed", () => {
    const result = slimInviteReceived({
      object: "invitation_list",
      items: [
        {
          id: "RECEIVED_1",
          created_at: "2026-01-01T00:00:00Z",
          user: { id: "ACoAA1", type: "individual", public_identifier: "a" },
        },
      ],
      cursor: null,
    });
    expect(result["object"]).toBe("invitation_list");
    expect(result["cursor"]).toBeNull();
    const items = result["items"] as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty("type");
  });

  it("non-object / missing items input projects to an empty-list shape (never throws)", () => {
    expect(slimInviteReceived(undefined)).toEqual({ object: null, items: [], cursor: null });
  });
});

// ---------------------------------------------------------------------------
// slimSearchPostsItem / slimSearchPosts — shared by `search posts` and
// `company posts` (D13): both endpoints' v2 responses use the identical item
// schema (GET /v1/{account_id}/companies/{identifier}/posts and
// POST /v1/{account_id}/search/posts). Neither ever sends `post_urn` or
// `posted_at` — `id` is the only identifier field, and it's required.
// ---------------------------------------------------------------------------

describe("slimSearchPostsItem", () => {
  const fullPostItem = {
    id: "urn_activity_7419644944484753408",
    share_url: "https://linkedin.com/posts/acme_1",
    text: "We are hiring!",
    author: {
      id: "urn_company_112013061",
      name: "Acme",
      is_company: true,
      public_identifier: "acme",
    },
    permissions: { can_react: true, can_share: true, can_post_comments: true },
    is_repost: false,
    attachments: [{ type: "image" }],
    reactions: [{ type: "like", count: 10 }],
    reaction_count: 10,
    comment_count: 2,
    repost_count: 1,
  };

  it("projects id, author.name, text, reaction_count, comment_count", () => {
    const result = slimSearchPostsItem(fullPostItem);
    expect(result).toEqual({
      id: "urn_activity_7419644944484753408",
      author: { name: "Acme" },
      text: "We are hiring!",
      reaction_count: 10,
      comment_count: 2,
    });
  });

  it("drops share_url, repost_count, is_repost, attachments, reactions, permissions, and author sub-fields beyond name (verbose-only)", () => {
    const result = slimSearchPostsItem(fullPostItem);
    expect(result).not.toHaveProperty("share_url");
    expect(result).not.toHaveProperty("repost_count");
    expect(result).not.toHaveProperty("is_repost");
    expect(result).not.toHaveProperty("attachments");
    expect(result).not.toHaveProperty("reactions");
    expect(result).not.toHaveProperty("permissions");
    const author = result["author"] as Record<string, unknown>;
    expect(author).not.toHaveProperty("id");
    expect(author).not.toHaveProperty("is_company");
    expect(author).not.toHaveProperty("public_identifier");
  });

  it("v1 legacy fields (post_urn, posted_at) are absent — neither v2 endpoint's response ever sends them", () => {
    const result = slimSearchPostsItem(fullPostItem);
    expect(result).not.toHaveProperty("post_urn");
    expect(result).not.toHaveProperty("posted_at");
  });

  it("text >200 chars truncated to 200; <=200 chars passed through; null preserved", () => {
    const long = slimSearchPostsItem({ ...fullPostItem, text: "A".repeat(300) });
    expect((long["text"] as string).length).toBe(200);
    expect(long["text"]).toBe("A".repeat(200));

    const short = slimSearchPostsItem({ ...fullPostItem, text: "Short post" });
    expect(short["text"]).toBe("Short post");

    const nullText = slimSearchPostsItem({ ...fullPostItem, text: null });
    expect(nullText["text"]).toBeNull();
  });

  it("author projects to null when the source has no author (never crashes)", () => {
    const withoutAuthor = { ...fullPostItem };
    delete (withoutAuthor as { author?: unknown }).author;
    const result = slimSearchPostsItem(withoutAuthor);
    expect(result["author"]).toBeNull();
  });

  it("id projects to null when absent — defensive, even though the v2 schema marks it required (never undefined)", () => {
    const result = slimSearchPostsItem({ text: "no id here", reaction_count: 0, comment_count: 0 });
    expect(result["id"]).toBeNull();
  });
});

describe("slimSearchPosts", () => {
  it("projects the envelope's items array with each item slimmed; cursor passes through", () => {
    const result = slimSearchPosts({
      object: "company_post_list",
      items: [
        { id: "p1", author: { name: "Acme" }, text: "Hi", reaction_count: 1, comment_count: 0 },
      ],
      cursor: "cur_1",
      paging: { total_count: 1 },
    });
    const items = result["items"] as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      id: "p1",
      author: { name: "Acme" },
      text: "Hi",
      reaction_count: 1,
      comment_count: 0,
    });
    expect(result["cursor"]).toBe("cur_1");
  });

  it("non-object / missing items input projects to an empty-list-safe shape (never throws)", () => {
    expect(() => slimSearchPosts(undefined)).not.toThrow();
    const result = slimSearchPosts(undefined) as Record<string, unknown>;
    expect(result["items"]).toEqual([]);
  });
});
