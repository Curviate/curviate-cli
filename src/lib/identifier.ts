/**
 * Identifier resolution for member and company positionals.
 *
 * Commands that accept a member/company identifier (`profile <id>`,
 * `company <id>`, `connect <id>`, SN/Recruiter `profile <identifier>`)
 * pass the raw value through this function to normalize URLs and bare paths
 * into the form the API expects.
 *
 * Resolution matrix (in precedence order):
 *   1. LinkedIn member URL   -> public slug
 *   2. LinkedIn company URL  -> public slug
 *   3. Bare `/in/<slug>`     -> slug
 *   4. Bare `/company/<slug>`-> slug
 *   5. Bare slug (no scheme, no `/`) -> unchanged
 *   6. Native id / URN       -> unchanged (never fabricated)
 *   7. Anything ambiguous    -> unchanged (404 -> exit 4)
 *
 * This function is pure and synchronous. It has zero side effects and no
 * network calls.
 */

/** Matches a full LinkedIn member profile URL (www., locale/country subdomain, or bare). */
const MEMBER_URL_RE =
  /^https?:\/\/(?:[a-z0-9-]+\.)?linkedin\.com\/in\/([^/?#]+)/i;

/** Matches a full LinkedIn company URL (www., locale/country subdomain, or bare). */
const COMPANY_URL_RE =
  /^https?:\/\/(?:[a-z0-9-]+\.)?linkedin\.com\/company\/([^/?#]+)/i;

/** Matches a bare `/in/<slug>` path (may have trailing slash). */
const MEMBER_PATH_RE = /^\/in\/([^/?#/]+)\/?$/;

/** Matches a bare `/company/<slug>` path (may have trailing slash). */
const COMPANY_PATH_RE = /^\/company\/([^/?#/]+)\/?$/;

/**
 * Normalize a raw identifier positional into the form the API expects.
 *
 * The CLI never fabricates a URN from a slug: native ids and URNs are
 * passed through unchanged. Fabricated URNs 404 live.
 */
export function resolveIdentifier(raw: string): string {
  // 1. Full LinkedIn member URL
  const memberUrlMatch = MEMBER_URL_RE.exec(raw);
  if (memberUrlMatch?.[1]) {
    return stripTrailingSlash(memberUrlMatch[1]);
  }

  // 2. Full LinkedIn company URL
  const companyUrlMatch = COMPANY_URL_RE.exec(raw);
  if (companyUrlMatch?.[1]) {
    return stripTrailingSlash(companyUrlMatch[1]);
  }

  // 3. Bare `/in/<slug>` path
  const memberPathMatch = MEMBER_PATH_RE.exec(raw);
  if (memberPathMatch?.[1]) {
    return memberPathMatch[1];
  }

  // 4. Bare `/company/<slug>` path
  const companyPathMatch = COMPANY_PATH_RE.exec(raw);
  if (companyPathMatch?.[1]) {
    return companyPathMatch[1];
  }

  // 5-7. Bare slug, native id, URN, or anything ambiguous -> pass through.
  return raw;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * LinkedIn messaging thread URL pattern.
 * Matches paths like /messaging/thread/2-<base64> and captures the chat provider ID.
 */
const MESSAGING_THREAD_URL_RE = /messaging\/thread\/([^/?]+)/;

/**
 * Normalize a chat ID positional to a bare chat provider ID.
 *
 * A full LinkedIn messaging thread URL is stripped to the bare provider ID:
 *   https://www.linkedin.com/messaging/thread/2-AbCdEf/ -> 2-AbCdEf
 *
 * A bare provider ID (2-...) or an internal chat ID passes through verbatim.
 * Zero network calls, pure string normalization.
 */
export function normalizeChatId(raw: string): string {
  const match = MESSAGING_THREAD_URL_RE.exec(raw);
  if (match?.[1]) return match[1];
  return raw;
}

/**
 * LinkedIn job posting URL pattern.
 * Matches `.../jobs/view/<id>` (with or without a locale/country subdomain,
 * trailing slash, or query string) and captures the numeric job id.
 */
const JOB_URL_RE = /\/jobs\/view\/(\d+)/;

/**
 * Resolve a job identifier positional (`job get <url|id>`,
 * `recruiter job get <url|id>`) to a bare numeric job id.
 *
 * A full LinkedIn job URL is reduced to its numeric id:
 *   https://www.linkedin.com/jobs/view/4428113858 -> 4428113858
 *
 * A bare numeric id, or any value that does not match the job-URL pattern,
 * passes through unchanged. This function never fabricates or rejects a
 * value, the SDK's own job-id resolution (shared by `jobs.get()` and
 * `recruiter.getJob()`) is the fallback validator: it throws a synchronous
 * `INVALID_REQUEST` error when neither a numeric id nor its own URL pattern
 * matches.
 */
export function resolveJobIdentifier(raw: string): string {
  const match = JOB_URL_RE.exec(raw);
  if (match?.[1]) return match[1];
  return raw;
}
