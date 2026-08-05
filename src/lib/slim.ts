/**
 * Slim-default projection functions for the CLI.
 *
 * These functions extract the fields agents and humans most commonly need
 * from the full SDK response, keeping default `--json` output compact.
 * Pass `--verbose` to bypass slim projection and receive the raw SDK response.
 *
 * Conventions:
 *   - Fields absent from the source are projected as `null` (never `undefined`),
 *     so the output shape is stable regardless of which sections were fetched.
 *   - Sub-object projections strip every key not explicitly listed here.
 *   - Array projections that synthesize a scalar (`current_position`,
 *     `headquarters`) set the value to `null` when the source is empty or absent.
 *
 * Real substrate `specifics.experience[]` item shape (v2 UserProfile — the
 * array itself is nested under `specifics`, not a top-level `work_experience`
 * field; see slimProfile/slimProfileMe):
 *   { id, company, position, location, status, company_picture_url, skills, start, end }
 * Mapping into CurrentPosition:
 *   title        ← position
 *   company_name ← company
 *   company_id   ← null (ALWAYS — entry.id is the experience-entry id, not a company id)
 *   is_current   ← (end == null)
 */

// ---------------------------------------------------------------------------
// Exported synthesis helpers (used by slim projectors and testable standalone)
// ---------------------------------------------------------------------------

export type CurrentPosition = {
  title: string | null;
  company_name: string | null;
  company_id: null;
  is_current: boolean;
};

/**
 * Synthesize a `current_position` scalar from an experience-entries array
 * (the real wire's `specifics.experience` — callers extract that nested
 * array before calling this; see slimProfile/slimProfileMe).
 *
 * Uses the first entry in the array (index 0).
 * Input item shape (real substrate): `{ id, company, position, end, ... }`
 *   - title        ← position
 *   - company_name ← company
 *   - company_id   ← null (ALWAYS — never read from the entry)
 *   - is_current   ← (end == null)
 *
 * Returns null when the array is empty or not provided.
 */
export function synthesizeCurrentPosition(
  workExperience: unknown[],
): CurrentPosition | null {
  if (!Array.isArray(workExperience) || workExperience.length === 0) {
    return null;
  }
  const entry = workExperience[0] as Record<string, unknown>;
  return {
    title: (entry["position"] as string | null | undefined) ?? null,
    company_name: (entry["company"] as string | null | undefined) ?? null,
    company_id: null,
    is_current: entry["end"] == null,
  };
}

/**
 * Synthesize a `headquarters` object from the `locations` array.
 *
 * Finds the entry with `is_headquarter: true` and extracts
 * `{city, country_code, postal_code, area}` — the real v2 CompanyProfile
 * `locations[]` item shape. `country_code`/`postal_code` are the real fields
 * (there is no `country` key — that v1-shaped name was fictitious and always
 * projected null). `area` (region/state, e.g. "Washington") IS real and
 * frequently populated — verified live against staging (`company microsoft
 * --verbose`: ~29% of its 45 locations carry `area`, including its own HQ
 * entry) — even though the SDK's generated `.d.ts` for this endpoint doesn't
 * declare it; the type under-documents the wire here. `area` was already
 * part of the pre-fix output, so it stays (only `country`→`country_code`
 * needed fixing on that front); `street` is also real on the wire but was
 * never part of this projection and stays verbose-only.
 * Returns null when no headquarters entry is present.
 */
export function synthesizeHeadquarters(
  locations: unknown[],
): { city: string | null; country_code: string | null; postal_code: string | null; area: string | null } | null {
  if (!Array.isArray(locations)) return null;
  const hq = locations.find(
    (l) => (l as Record<string, unknown>)["is_headquarter"] === true,
  ) as Record<string, unknown> | undefined;
  if (!hq) return null;
  return {
    city: (hq["city"] as string | null | undefined) ?? null,
    country_code: (hq["country_code"] as string | null | undefined) ?? null,
    postal_code: (hq["postal_code"] as string | null | undefined) ?? null,
    area: (hq["area"] as string | null | undefined) ?? null,
  };
}

// ---------------------------------------------------------------------------
// shared: real v2 UserProfile `specifics` sub-object access
// (`profile me` and `profile <id>` are both backed by the identical
// `GET /v1/{account_id}/users/{user_id}` response — see slimProfileMe/
// slimProfile below.)
// ---------------------------------------------------------------------------

/**
 * Narrow the real v2 UserProfile response's `specifics` sub-object — the
 * home of `network_distance`, `is_premium`, and the `linkedin_sections`-gated
 * arrays (`experience`, `education`, etc.). Returns null when absent/not an
 * object (defensive — `specifics` is technically required on the real
 * schema, but never trust the wire blindly).
 */
function getSpecifics(d: Record<string, unknown>): Record<string, unknown> | null {
  return d["specifics"] !== null && d["specifics"] !== undefined && typeof d["specifics"] === "object"
    ? (d["specifics"] as Record<string, unknown>)
    : null;
}

/**
 * Extract the `specifics.experience` array (present only when
 * `linkedin_sections=linkedin_experience` was requested). There is no
 * top-level `work_experience` field on the real wire — it lives nested here.
 */
function extractExperience(specifics: Record<string, unknown> | null): unknown[] {
  return Array.isArray(specifics?.["experience"]) ? (specifics!["experience"] as unknown[]) : [];
}

/**
 * Project the sections the caller actually asked for out of `specifics`.
 *
 * `--sections linkedin_experience,linkedin_skills` makes the server return the
 * recruiter-grade arrays nested under `specifics.<base>`. The slim projection is
 * a rebuild rather than a filter, so before this those arrays were fetched and
 * then thrown away: `--sections` on the default output looked like a no-op, and
 * a user had no way to tell it had worked. Now the requested sections ride the
 * slim output under a `sections` key, so asking for data returns data.
 *
 * Only what was REQUESTED is included, so the default (no `--sections`) output
 * is byte-for-byte unchanged. `linkedin_*` means "every section present".
 * `linkedin_<base>_preview` reads from the same `<base>` key the server nests
 * the preview payload under.
 *
 * Returns null when nothing was requested or nothing came back, so the caller
 * can omit the key entirely rather than emit an empty object.
 */
function projectSections(
  specifics: Record<string, unknown> | null,
  requested: readonly string[] | undefined,
): Record<string, unknown> | null {
  if (!specifics || !requested || requested.length === 0) return null;

  // Keys that are profile metadata, not `--sections` payload; never emitted
  // as a "section" even under the wildcard.
  const NON_SECTION_KEYS = new Set(["network_distance", "is_premium"]);

  const out: Record<string, unknown> = {};

  if (requested.includes("linkedin_*")) {
    for (const [key, value] of Object.entries(specifics)) {
      if (!NON_SECTION_KEYS.has(key) && value !== undefined) out[key] = value;
    }
  } else {
    for (const section of requested) {
      const base = section.replace(/^linkedin_/, "").replace(/_preview$/, "");
      if (NON_SECTION_KEYS.has(base)) continue;
      const value = specifics[base];
      if (value !== undefined) out[base] = value;
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// profile me
// ---------------------------------------------------------------------------

/**
 * Slim-default projection for `profile me`.
 *
 * Backed by the same real v2 `GET /v1/{account_id}/users/{user_id}` response
 * as `profile <id>` (`userId: "me"` for the caller's own account) — there is
 * no separate "me" response shape.
 *
 * Exact fields returned (9):
 *   provider_id, first_name, last_name, headline, public_identifier,
 *   location, emails (array), is_premium, current_position
 *
 * v1-drift fixes (verified against the SDK's generated types, the wire truth):
 *   - `provider_id` ← `id` (the real wire has no `provider_id` key at all —
 *     the profile's identifier is the top-level `id`).
 *   - `email` (singular, always null) → `emails`, the real key (`string[]`).
 *   - `is_premium` ← `specifics.is_premium` (nested — no top-level
 *     `is_premium` on the real wire).
 *   - `headline` ← `description`. On a v2 read, LinkedIn serves the profile
 *     headline in the `description` wire field, NOT a field literally named
 *     `headline` — a separate `bio` field carries the About-section
 *     paragraph. Confirmed by 3 independent live observations: a written
 *     headline read back via `description` byte-for-byte, the same result
 *     from the M3 matrix probe, and `--verbose` showing headline-shaped text
 *     in `description` (About-paragraph text in `bio`) across live profiles.
 *     Originally assumed to have no v2 source and dropped; restored once the
 *     real source was identified.
 *   - `occupation`, `organizations`: REMOVED — no v2 source. The real
 *     user-profile response has no occupation-summary field and no
 *     administered-organizations field of any kind.
 */
export function slimProfileMe(
  data: unknown,
  requestedSections?: readonly string[],
): Record<string, unknown> {
  const d = (data !== null && data !== undefined && typeof data === "object"
    ? data
    : {}) as Record<string, unknown>;

  const specifics = getSpecifics(d);

  // current_position parity with `profile <id>` slim: synthesized from
  // specifics.experience[0], present only when linkedin_sections triggers
  // the enrichment (null otherwise). Same helper, same contract.
  const currentPosition = synthesizeCurrentPosition(extractExperience(specifics));

  const sections = projectSections(specifics, requestedSections);

  return {
    ...(sections ? { sections } : {}),
    provider_id: d["id"] ?? null,
    first_name: d["first_name"] ?? null,
    last_name: d["last_name"] ?? null,
    // LinkedIn serves the profile headline in the `description` wire field
    // on reads, not a field named `headline` — see JSDoc above.
    headline: d["description"] ?? null,
    public_identifier: d["public_identifier"] ?? null,
    location: d["location"] ?? null,
    emails: Array.isArray(d["emails"]) ? d["emails"] : [],
    is_premium: (specifics?.["is_premium"] as boolean | null | undefined) ?? null,
    current_position: currentPosition,
  };
}

// ---------------------------------------------------------------------------
// profile <id>
// ---------------------------------------------------------------------------

/**
 * Slim-default projection for `profile <id>`.
 *
 * Same real v2 `GET /v1/{account_id}/users/{user_id}` response as
 * `profile me` (see slimProfileMe) — `user_id` addresses the target member
 * instead of "me".
 *
 * Exact fields returned (8):
 *   provider_id, first_name, last_name, headline, location,
 *   network_distance, public_identifier, current_position
 *
 * v1-drift fixes (verified against the SDK's generated types, the wire truth):
 *   - `provider_id` ← `id` (no top-level `provider_id` on the real wire).
 *   - `network_distance` ← `specifics.network_distance` (nested — no
 *     top-level `network_distance` on the real wire).
 *   - `headline` ← `description` (see slimProfileMe's JSDoc for the 3-way
 *     live-verified evidence) — same real wire, same mapping.
 *   - `occupation`: REMOVED — no v2 source (see slimProfileMe).
 *
 * `current_position` is synthesized from `specifics.experience[0]` via
 * `synthesizeCurrentPosition`. See that function for field mapping details.
 * Returns `null` when `specifics.experience` is empty or absent.
 */
export function slimProfile(
  data: unknown,
  requestedSections?: readonly string[],
): Record<string, unknown> {
  const d = (data !== null && data !== undefined && typeof data === "object"
    ? data
    : {}) as Record<string, unknown>;

  const specifics = getSpecifics(d);
  const currentPosition = synthesizeCurrentPosition(extractExperience(specifics));

  const sections = projectSections(specifics, requestedSections);

  return {
    ...(sections ? { sections } : {}),
    provider_id: d["id"] ?? null,
    first_name: d["first_name"] ?? null,
    last_name: d["last_name"] ?? null,
    // LinkedIn serves the profile headline in the `description` wire field
    // on reads, not a field named `headline` — see slimProfileMe's JSDoc.
    headline: d["description"] ?? null,
    location: d["location"] ?? null,
    network_distance: (specifics?.["network_distance"] as string | null | undefined) ?? null,
    public_identifier: d["public_identifier"] ?? null,
    current_position: currentPosition,
  };
}

// ---------------------------------------------------------------------------
// connect sent
// ---------------------------------------------------------------------------

/**
 * Project a single sent-invitation item to the slim field set.
 *
 * v2 shape (`GET /v1/{account_id}/invites/sent`, item `object: "invitation_sent"`):
 *   { object, id, created_at?, message?,
 *     user: { id, type?, display_name?, first_name?, last_name?, public_picture_url? } }
 *
 * Drops: the per-item `object` discriminator (redundant with the envelope's
 * own `object`); `user.type` and `user.public_picture_url` (verbose-only).
 * Keeps: id, created_at, message, and a trimmed `user` sub-object (id,
 * display_name, first_name, last_name) — the sent-variant's `user` carries
 * no `public_identifier`/`profile_url`/`description` (those are
 * received-only, per the served schema — see slimInviteReceivedItem).
 *
 * v1-parity note: this replaces the pre-v2 shape (`invited_user`,
 * `invited_user_id`, `invited_user_public_id`, `invited_user_description`,
 * `date`, `parsed_datetime`, `invitation_text`, `inviter`, `specifics`) that
 * the v2 response never sends — the prior projection nulled every field.
 */
export function slimInviteSentItem(item: Record<string, unknown>): Record<string, unknown> {
  const rawUser =
    item["user"] !== null && item["user"] !== undefined && typeof item["user"] === "object"
      ? (item["user"] as Record<string, unknown>)
      : null;

  const user =
    rawUser !== null
      ? {
          id: rawUser["id"] ?? null,
          display_name: rawUser["display_name"] ?? null,
          first_name: rawUser["first_name"] ?? null,
          last_name: rawUser["last_name"] ?? null,
        }
      : null;

  return {
    id: item["id"] ?? null,
    created_at: item["created_at"] ?? null,
    message: item["message"] ?? null,
    user,
  };
}

/**
 * Slim-default projection for `connect sent` list response.
 * Accepts the full list envelope { object, items, cursor } and projects each item.
 * Applied before --fields; bypassed by --verbose.
 */
export function slimInviteSent(data: unknown): Record<string, unknown> {
  const d = (data !== null && data !== undefined && typeof data === "object"
    ? data
    : {}) as Record<string, unknown>;

  const items = Array.isArray(d["items"])
    ? (d["items"] as Array<Record<string, unknown>>).map(slimInviteSentItem)
    : [];

  return {
    object: d["object"] ?? null,
    items,
    cursor: d["cursor"] ?? null,
  };
}

// ---------------------------------------------------------------------------
// connect received
// ---------------------------------------------------------------------------

/**
 * Project a single received-invitation item to the slim field set.
 *
 * v2 shape (`GET /v1/{account_id}/invites/received`, item `object: "invitation_received"`):
 *   { object, id, created_at?,
 *     user: { id, type?, display_name?, first_name?, last_name?, public_picture_url?,
 *             public_identifier?, profile_url?, description? } }
 *
 * Drops: the per-item `object` discriminator; `user.type`,
 * `user.public_picture_url`, `user.profile_url`, `user.description`
 * (verbose-only). Keeps: id, created_at, and a trimmed `user` sub-object
 * (id, display_name, first_name, last_name, public_identifier) —
 * `public_identifier` is the field that lets an agent safely identify which
 * invite belongs to which sender (D2: the v1-shape projection nulled it out).
 *
 * v1-parity note: the v2 response has no `invited_user*` (self-referential
 * on received, always null there anyway), no `date`/`parsed_datetime`/
 * `invitation_text`, no `inviter`, and no `specifics.shared_secret` — none
 * of those keys exist on this endpoint's schema; `created_at` is the actual
 * server timestamp (not the approximate, label-derived `parsed_datetime`).
 */
export function slimInviteReceivedItem(item: Record<string, unknown>): Record<string, unknown> {
  const rawUser =
    item["user"] !== null && item["user"] !== undefined && typeof item["user"] === "object"
      ? (item["user"] as Record<string, unknown>)
      : null;

  const user =
    rawUser !== null
      ? {
          id: rawUser["id"] ?? null,
          display_name: rawUser["display_name"] ?? null,
          first_name: rawUser["first_name"] ?? null,
          last_name: rawUser["last_name"] ?? null,
          public_identifier: rawUser["public_identifier"] ?? null,
        }
      : null;

  return {
    id: item["id"] ?? null,
    created_at: item["created_at"] ?? null,
    user,
  };
}

/**
 * Slim-default projection for `connect received` list response.
 * Accepts the full list envelope { object, items, cursor } and projects each item.
 * Applied before --fields; bypassed by --verbose.
 */
export function slimInviteReceived(data: unknown): Record<string, unknown> {
  const d = (data !== null && data !== undefined && typeof data === "object"
    ? data
    : {}) as Record<string, unknown>;

  const items = Array.isArray(d["items"])
    ? (d["items"] as Array<Record<string, unknown>>).map(slimInviteReceivedItem)
    : [];

  return {
    object: d["object"] ?? null,
    items,
    cursor: d["cursor"] ?? null,
  };
}

// ---------------------------------------------------------------------------
// search people
// ---------------------------------------------------------------------------

/**
 * Slim-default projection for a single `search people` item.
 *
 * Exact fields: id, public_identifier, full_name, headline, location,
 * network_distance. Verbose-only: avatar_url, linkedin_urn, is_premium,
 * is_open_profile.
 */
export function slimSearchPeopleItem(item: Record<string, unknown>): Record<string, unknown> {
  return {
    id: item["id"] ?? null,
    public_identifier: item["public_identifier"] ?? null,
    full_name: item["full_name"] ?? null,
    headline: item["headline"] ?? null,
    location: item["location"] ?? null,
    network_distance: item["network_distance"] ?? null,
  };
}

/**
 * Slim-default projection for the `search people` list envelope.
 * Projects each item via slimSearchPeopleItem; preserves envelope shape.
 */
export function slimSearchPeople(data: unknown): Record<string, unknown> {
  const d = (data !== null && data !== undefined && typeof data === "object"
    ? data
    : {}) as Record<string, unknown>;

  const items = Array.isArray(d["items"])
    ? (d["items"] as Array<Record<string, unknown>>).map(slimSearchPeopleItem)
    : [];

  return { ...d, items };
}

// ---------------------------------------------------------------------------
// search companies
// ---------------------------------------------------------------------------

/**
 * Slim-default projection for a single `search companies` item.
 *
 * Exact fields: id, name, location, followers_count, and `industry` when
 * present in the server response (key is omitted entirely when absent).
 * Verbose-only: summary, headcount, profile_url.
 */
export function slimSearchCompaniesItem(item: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {
    id: item["id"] ?? null,
    name: item["name"] ?? null,
    location: item["location"] ?? null,
    followers_count: item["followers_count"] ?? null,
  };
  // Omit `industry` key entirely when not present (not null — absent)
  if (Object.prototype.hasOwnProperty.call(item, "industry")) {
    result["industry"] = item["industry"];
  }
  return result;
}

/**
 * Slim-default projection for the `search companies` list envelope.
 */
export function slimSearchCompanies(data: unknown): Record<string, unknown> {
  const d = (data !== null && data !== undefined && typeof data === "object"
    ? data
    : {}) as Record<string, unknown>;

  const items = Array.isArray(d["items"])
    ? (d["items"] as Array<Record<string, unknown>>).map(slimSearchCompaniesItem)
    : [];

  return { ...d, items };
}

// ---------------------------------------------------------------------------
// search jobs
// ---------------------------------------------------------------------------

/**
 * Slim-default projection for a single `search jobs` item.
 *
 * Exact fields: job_urn, title, location, company_name, posted_at, easy_apply.
 * Verbose-only: company nested object, reference_id, url, reposted, promoted,
 * benefits.
 *
 * `company_name` is a CLI-side SYNTHESIZED field — there is no top-level
 * `company_name` on the raw response, only a nested `company.name` (some job
 * postings have `company: null` entirely, e.g. agency/confidential listings;
 * this resolves to `null` by construction, not a crash).
 */
export function slimSearchJobsItem(item: Record<string, unknown>): Record<string, unknown> {
  const company = item["company"] as Record<string, unknown> | null | undefined;
  return {
    job_urn: item["job_urn"] ?? null,
    title: item["title"] ?? null,
    location: item["location"] ?? null,
    company_name: company?.["name"] ?? null,
    posted_at: item["posted_at"] ?? null,
    easy_apply: item["easy_apply"] ?? null,
  };
}

/**
 * Slim-default projection for the `search jobs` list envelope.
 */
export function slimSearchJobs(data: unknown): Record<string, unknown> {
  const d = (data !== null && data !== undefined && typeof data === "object"
    ? data
    : {}) as Record<string, unknown>;

  const items = Array.isArray(d["items"])
    ? (d["items"] as Array<Record<string, unknown>>).map(slimSearchJobsItem)
    : [];

  return { ...d, items };
}

// ---------------------------------------------------------------------------
// search posts / company posts (shared item schema)
// ---------------------------------------------------------------------------

/**
 * Slim-default projection for a single post item — shared by `search posts`
 * (`POST /v1/{account_id}/search/posts`) and `company posts`
 * (`GET /v1/{account_id}/companies/{identifier}/posts`), which return the
 * identical item schema.
 *
 * v2 shape (both endpoints):
 *   { id, share_url?, text?, author?: {id?, name?, is_company?, public_identifier?},
 *     permissions?, is_repost?, attachments?, reactions?, reaction_count,
 *     comment_count, repost_count }
 *
 * Exact fields: id, author ({name} only), text (truncated to 200 chars; null
 * preserved), reaction_count, comment_count.
 * Verbose-only: share_url, repost_count, is_repost, attachments, reactions,
 * permissions, full author object.
 *
 * v1-parity note (D13): this replaces the pre-v2 shape (`post_urn`,
 * `posted_at`) that neither endpoint's response ever sends — `post_urn` was
 * never a real key (the wire's identifier field is `id`), and there is no
 * timestamp field on this resource at all, so `posted_at` has no v2
 * replacement and is dropped rather than kept as a permanently-null decoy.
 * The prior projection nulled both keys forever and never surfaced the
 * post's own `id` in slim output.
 */
export function slimSearchPostsItem(item: Record<string, unknown>): Record<string, unknown> {
  // Project author to {name} only
  const rawAuthor =
    item["author"] !== null && item["author"] !== undefined && typeof item["author"] === "object"
      ? (item["author"] as Record<string, unknown>)
      : null;
  const author = rawAuthor !== null ? { name: rawAuthor["name"] ?? null } : null;

  // Truncate text to 200 chars; preserve null
  const rawText = item["text"];
  let text: string | null;
  if (rawText === null || rawText === undefined) {
    text = null;
  } else {
    const s = String(rawText);
    text = s.length > 200 ? s.slice(0, 200) : s;
  }

  return {
    id: item["id"] ?? null,
    author,
    text,
    reaction_count: item["reaction_count"] ?? null,
    comment_count: item["comment_count"] ?? null,
  };
}

/**
 * Slim-default projection for the `search posts` / `company posts` list
 * envelope. Projects each item via slimSearchPostsItem; preserves envelope
 * shape (`object`, `paging`, `cursor` pass through — only `items` is mapped).
 */
export function slimSearchPosts(data: unknown): Record<string, unknown> {
  const d = (data !== null && data !== undefined && typeof data === "object"
    ? data
    : {}) as Record<string, unknown>;

  const items = Array.isArray(d["items"])
    ? (d["items"] as Array<Record<string, unknown>>).map(slimSearchPostsItem)
    : [];

  return { ...d, items };
}

// ---------------------------------------------------------------------------
// account list / account get
// ---------------------------------------------------------------------------

/**
 * Project a single `account list` item to the slim field set.
 *
 * Exact fields: account_id, status, auth_method, full_name, headline,
 * seat_id, connected_at. The six cached account-enrichment fields (username,
 * premium_id, public_identifier, substrate_created_at, signatures, groups)
 * are verbose-only — excluded here by construction (fresh object literal,
 * no spread of the source item).
 */
export function slimAccountListItem(item: Record<string, unknown>): Record<string, unknown> {
  return {
    account_id: item["account_id"] ?? null,
    status: item["status"] ?? null,
    auth_method: item["auth_method"] ?? null,
    full_name: item["full_name"] ?? null,
    headline: item["headline"] ?? null,
    seat_id: item["seat_id"] ?? null,
    connected_at: item["connected_at"] ?? null,
  };
}

/**
 * Slim-default projection for the `account list` list envelope.
 * Projects each item via slimAccountListItem; preserves envelope shape.
 */
export function slimAccountList(data: unknown): Record<string, unknown> {
  const d = (data !== null && data !== undefined && typeof data === "object"
    ? data
    : {}) as Record<string, unknown>;

  const items = Array.isArray(d["items"])
    ? (d["items"] as Array<Record<string, unknown>>).map(slimAccountListItem)
    : [];

  return { object: d["object"] ?? null, items, cursor: d["cursor"] ?? null };
}

/**
 * Slim-default projection for `account get` — the first slim/verbose split
 * on this command (previously slim and verbose were byte-identical).
 *
 * Exact fields: account_id, status, auth_method, full_name, headline,
 * seat_id, connected_at, last_checked_at, quotas. `seat_id` is a slim field
 * here (unlike the six enrichment fields) — core identity/troubleshooting
 * data, not part of the enrichment cache.
 */
export function slimAccountGet(data: unknown): Record<string, unknown> {
  const d = (data !== null && data !== undefined && typeof data === "object"
    ? data
    : {}) as Record<string, unknown>;

  return {
    account_id: d["account_id"] ?? null,
    status: d["status"] ?? null,
    auth_method: d["auth_method"] ?? null,
    full_name: d["full_name"] ?? null,
    headline: d["headline"] ?? null,
    seat_id: d["seat_id"] ?? null,
    connected_at: d["connected_at"] ?? null,
    last_checked_at: d["last_checked_at"] ?? null,
    quotas: d["quotas"] ?? [],
  };
}

// ---------------------------------------------------------------------------
// job get / recruiter job get (shared projection over two DIFFERENT v2
// shapes — Core job_posting vs. Recruiter recruiter_job_posting)
// ---------------------------------------------------------------------------

/**
 * Slim-default projection for `job get` and `recruiter job get` — two
 * commands sharing one projection even though the underlying v2 shapes
 * differ: Core `job_posting` (`GET /v1/{account_id}/jobs/{job_id}`) vs.
 * Recruiter `recruiter_job_posting`
 * (`GET /v1/{account_id}/recruiter/jobs/{job_id}`). (`recruiter
 * project-job get` — `.../recruiter/projects/{project_id}/jobs/{job_id}` —
 * is a separate command that does NOT use this projector; it renders the
 * raw SDK response with no slim/verbose split.)
 *
 * Exact fields returned (10):
 *   object, id, title, company, company_id, location, state,
 *   applications_count, published_at, description
 *
 * `description` stays in the slim projection — retrieving a job's full
 * description is the point of this command. Excludes `hiring_team` and
 * `cost` (verbose-only).
 *
 * v1-drift fixes (D13 sweep — neither shape ever sent these keys):
 *   - `company_id`: never a top-level key on either shape — `company` is
 *     always a nested object (`{id, name, ...}`). Synthesized from
 *     `company.id` instead of read from a flat key that doesn't exist.
 *   - `applicants_counter` → `applications_count` (renamed): the real key on
 *     both shapes is `applications_count`; `applicants_counter` was never
 *     real and always projected null.
 *   - `published_at`: real (optional) on the Recruiter shape, but the Core
 *     shape has no `published_at` at all — its equivalent is `created_at`.
 *     Falls back to `created_at` so `job get` (Core) surfaces a real
 *     timestamp instead of a permanent null; unaffected when the real
 *     `published_at` is present (Recruiter).
 */
export function slimJob(data: unknown): Record<string, unknown> {
  const d = (data !== null && data !== undefined && typeof data === "object"
    ? data
    : {}) as Record<string, unknown>;

  // company is a nested object on both shapes; there is no top-level
  // company_id on either — synthesize it from company.id.
  const rawCompany = (d["company"] !== null && d["company"] !== undefined && typeof d["company"] === "object")
    ? (d["company"] as Record<string, unknown>)
    : null;
  const companyId = (rawCompany?.["id"] as string | null | undefined) ?? null;

  return {
    object: d["object"] ?? null,
    id: d["id"] ?? null,
    title: d["title"] ?? null,
    company: d["company"] ?? null,
    company_id: companyId,
    location: d["location"] ?? null,
    state: d["state"] ?? null,
    applications_count: d["applications_count"] ?? null,
    published_at: d["published_at"] ?? d["created_at"] ?? null,
    description: d["description"] ?? null,
  };
}

// ---------------------------------------------------------------------------
// company <id>
// ---------------------------------------------------------------------------

/**
 * Slim-default projection for `company <id>`.
 *
 * Exact fields returned (11):
 *   id, name, public_identifier, profile_url, industry,
 *   employee_count, employee_count_range, website, establishment_year,
 *   headquarters ({city,country_code,postal_code,area}|null), follower_count
 *
 * v1-drift fixes (real v2 CompanyProfile shape — verified against the SDK's
 * generated types AND a live staging probe, since the type under-documents
 * `locations[]`; see synthesizeHeadquarters):
 *   - `employee_count` ← `insights.headcount` (was reading a nonexistent
 *     top-level `employee_count`, always null).
 *   - `employee_count_range` ← `insights.headcount_range`, projected to
 *     `{ from }` only — the real range has no upper bound at all (documented
 *     open-ended-high); no `to` is invented.
 *   - `foundation_date` (a fictitious key, always null) → renamed
 *     `establishment_year`, the real field — a bare year number (e.g. 2000),
 *     not a date string, so the old "date" name would have misdescribed the
 *     value even pointed at the right source.
 *   - `followers_count` → renamed `follower_count` — the real key is
 *     singular.
 *   - `messaging`: REMOVED — no `messaging` field exists anywhere on the
 *     real schema (was permanently `{is_enabled: false}`).
 *
 * `headquarters` is synthesized from `locations` via `synthesizeHeadquarters`.
 * Returns `null` when no headquarters location is present.
 */
export function slimCompany(data: unknown): Record<string, unknown> {
  const d = (data !== null && data !== undefined && typeof data === "object"
    ? data
    : {}) as Record<string, unknown>;

  const rawInsights =
    d["insights"] !== null && d["insights"] !== undefined && typeof d["insights"] === "object"
      ? (d["insights"] as Record<string, unknown>)
      : null;

  const rawHeadcountRange =
    rawInsights?.["headcount_range"] !== null &&
    rawInsights?.["headcount_range"] !== undefined &&
    typeof rawInsights?.["headcount_range"] === "object"
      ? (rawInsights["headcount_range"] as Record<string, unknown>)
      : null;

  const employeeCountRange =
    rawHeadcountRange !== null
      ? { from: (rawHeadcountRange["from"] as number | null | undefined) ?? null }
      : null;

  // Synthesize headquarters from locations
  const rawLocations = Array.isArray(d["locations"])
    ? (d["locations"] as unknown[])
    : [];
  const headquarters = synthesizeHeadquarters(rawLocations);

  return {
    id: d["id"] ?? null,
    name: d["name"] ?? null,
    public_identifier: d["public_identifier"] ?? null,
    profile_url: d["profile_url"] ?? null,
    industry: d["industry"] ?? null,
    employee_count: (rawInsights?.["headcount"] as number | null | undefined) ?? null,
    employee_count_range: employeeCountRange,
    website: d["website"] ?? null,
    establishment_year: d["establishment_year"] ?? null,
    headquarters,
    follower_count: d["follower_count"] ?? null,
  };
}

// ---------------------------------------------------------------------------
// company invitable-followers — invite_token JSON/terminal-safety
// ---------------------------------------------------------------------------

/**
 * Re-encode a wire `invite_token` value as base64.
 *
 * The real wire's `invite_token` (`GET .../invitable-followers`) is an
 * opaque per-suggestion correlation token that can carry raw binary bytes.
 * Embedding it verbatim into JSON output renders as mojibake in a terminal
 * and risks a broken copy/paste. Base64 is JSON-safe, terminal-safe,
 * ASCII-only, and a lossless encoding of exactly the string bytes the SDK
 * handed the CLI — it round-trips via
 * `Buffer.from(encoded, "base64").toString("utf8")` for a follow-invite
 * write (`companies.followInvite` needs only the `id` field, not this
 * token, but a caller may still want the original bytes).
 *
 * `null`/absent pass through unchanged — only a genuine non-empty string is
 * re-encoded, so "the read did not surface one" stays visibly `null` rather
 * than becoming a base64 encoding of the string `"null"`.
 */
export function encodeInviteToken(token: unknown): unknown {
  if (typeof token !== "string" || token.length === 0) return token;
  return Buffer.from(token, "utf8").toString("base64");
}

/**
 * Re-encode a single invitable-followers item's `invite_token`, leaving
 * every other field (`object`, `id`, `profile_urn`) untouched. A no-op when
 * the item carries no `invite_token` key at all.
 */
export function reencodeInviteTokenItem<T extends Record<string, unknown>>(item: T): T {
  if (!("invite_token" in item)) return item;
  return { ...item, invite_token: encodeInviteToken(item["invite_token"]) };
}

/**
 * Re-encode `invite_token` across an invitable-followers list envelope's
 * `items[]`. Applied unconditionally in `runCompanyInvitableFollowers`
 * BEFORE the --verbose slim-bypass check — the raw value is unsafe to
 * print in every output mode, so there is no verbose form that should ever
 * re-expose it unencoded.
 */
export function reencodeInvitableFollowers(data: unknown): Record<string, unknown> {
  const d = (data !== null && data !== undefined && typeof data === "object"
    ? data
    : {}) as Record<string, unknown>;

  const items = Array.isArray(d["items"])
    ? (d["items"] as Array<Record<string, unknown>>).map(reencodeInviteTokenItem)
    : [];

  return { ...d, items };
}

/**
 * Slim-default projection for a single invitable-followers item. The item
 * shape carries no name/headline (confirmed by the generated SDK types) —
 * hydrate a candidate via `profile <id>` before triaging who to invite.
 * Expects `invite_token` already base64-safe (via `reencodeInviteTokenItem`)
 * — this function does not re-encode.
 */
export function slimCompanyInvitableFollowerItem(item: Record<string, unknown>): Record<string, unknown> {
  return {
    object: item["object"] ?? null,
    id: item["id"] ?? null,
    profile_urn: item["profile_urn"] ?? null,
    invite_token: item["invite_token"] ?? null,
  };
}

/**
 * Slim-default projection for the `company invitable-followers` list
 * envelope. Projects each item via `slimCompanyInvitableFollowerItem`;
 * preserves the envelope shape (`object`, `items`, `cursor`).
 */
export function slimCompanyInvitableFollowers(data: unknown): Record<string, unknown> {
  const d = (data !== null && data !== undefined && typeof data === "object"
    ? data
    : {}) as Record<string, unknown>;

  const items = Array.isArray(d["items"])
    ? (d["items"] as Array<Record<string, unknown>>).map(slimCompanyInvitableFollowerItem)
    : [];

  return { ...d, items };
}
