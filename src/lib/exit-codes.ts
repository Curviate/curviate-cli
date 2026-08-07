/**
 * The complete `CurviateError.code` -> process exit code table.
 *
 * This is the single source of truth for the error->exit mapping. It is
 * data-driven and exhaustiveness-tested: a test imports the SDK ErrorCode
 * list and asserts every member has an entry here. Adding a new SDK error code
 * without mapping it fails the exhaustiveness test.
 *
 * Exit code semantics:
 *   0: success (no error)
 *   1: internal / uncaught (also: unmapped/unknown)
 *   2: invalid input / usage (also used for CLI-side usage errors)
 *   3: auth
 *   4: not found
 *   5: tier / entitlement
 *   6: rate-limited
 *   7: transient platform (retry-likely)
 *   8: account / connection state
 *   9: checkpoint flow
 *  10: messaging window / recipient
 *  11: billing
 *  12: auth action needed (a pending checkpoint; not an error)
 */

import type { ErrorCode } from "@curviate/sdk";

/**
 * The authoritative error->exit mapping.
 *
 * Every member of the SDK ErrorCode union must appear here. The exhaustiveness
 * test in test/lib/exit-codes.test.ts enforces this.
 *
 * Note: `PLATFORM_NOT_IMPLEMENTED` -> 1 (internal). A substrate operation the
 * platform has not wired yet is, from the caller's view, an internal "not
 * available", not a user-fixable input error.
 *
 * Note: `SUBSCRIPTION_BUSY` -> 11 (billing). It is a billing-lock contention,
 * not a platform outage, even though it is retry-likely. The JSON error
 * envelope's `retryLikelyToSucceed` carries that signal.
 *
 * Note: `RESOURCE_ACCESS_RESTRICTED` -> 8 (account / connection state), grouped
 * with `ACCOUNT_RESTRICTED` rather than a new bucket. Both describe the
 * acting account's own standing relative to a LinkedIn-side permission check
 * (e.g. not a page administrator of the target company), a resource-scoped
 * variant of the same "this account can't do that" condition.
 *
 * Note: `ACCOUNT_ALREADY_LINKED` -> 8 (account / connection state). A duplicate
 * connect attempt, reconnect or adopt the existing account instead of
 * retrying; not a transient failure. Grouped with `CONNECTION_IN_PROGRESS`
 * (both describe the connect flow hitting an existing-account conflict).
 *
 * Note: `LINKEDIN_OPERATION_NOT_SUPPORTED` -> 8 (account / connection state).
 * A permanent LinkedIn platform limitation for the attempted operation (e.g.
 * listing a non-self user's following list), not the acting account's own
 * restricted standing, but the same "this account can't do that against
 * LinkedIn" shape as `RESOURCE_ACCESS_RESTRICTED`; not retryable.
 *
 * Note: `CONNECTION_REQUEST_CONFLICT` -> 8 (account / connection state). The
 * documented contract for "already invited or already connected", a
 * `connect` retry against a pair that's already mid-flow or already linked.
 * Grouped with `ACCOUNT_ALREADY_LINKED` / `CONNECTION_IN_PROGRESS` (same
 * "this pair is already in that state" shape); not retryable by resending,
 * the caller should check current status instead.
 *
 * Note: `RATE_LIMITED` -> 6 (rate-limited), alongside `RATE_LIMIT_ACCOUNT`,
 * `RATE_LIMIT_TENANT`, `PLATFORM_RATE_LIMIT`, and `LINKEDIN_RATE_LIMITED`.
 * A general/unscoped rate-limit signal distinct from the account-, tenant-,
 * and platform-scoped variants above, but the same "back off and retry"
 * contract, same exit bucket.
 *
 * Note: `PREMIUM_CONFLICT` -> 8 (account / connection state). A seat resolving
 * to both individual-Premium tiers at once (LinkedIn permits only one per
 * profile), the same "this account/seat is in a state that blocks the
 * request" shape as `ACCOUNT_RESTRICTED`; user_fixable, not retryable.
 *
 * Note: `REAUTH_REQUIRED` -> 8 (account / connection state). A scope-changing
 * reconnect attempted with a cookie instead of credentials, grouped with
 * `CONNECTION_IN_PROGRESS` / `ACCOUNT_ALREADY_LINKED` (the connect/reconnect
 * flow hitting a state it cannot resolve without a different input);
 * user_fixable (retry with `auth_method: "credentials"`), not retryable as-is.
 */
export const EXIT_CODE_MAP: Partial<Record<ErrorCode, number>> & {
  // Make the shape explicit so TypeScript catches literal errors in the values
  // while still allowing the test to probe for absent keys.
  [K in ErrorCode]?: number;
} = {
  // Auth (3)
  UNAUTHORIZED: 3,

  // Invalid input / usage (2)
  INVALID_REQUEST: 2,
  UNSUPPORTED_MEDIA_TYPE: 2,
  PAYLOAD_TOO_LARGE: 2,

  // Not found (4)
  RESOURCE_NOT_FOUND: 4,
  ACCOUNT_NOT_FOUND: 4,
  SUBSCRIPTION_NOT_FOUND: 4,
  SEAT_NOT_FOUND: 4,

  // Tier / entitlement (5)
  TIER_NOT_ACTIVE: 5,
  LINKEDIN_FEATURE_NOT_SUBSCRIBED: 5,

  // Rate-limited (6)
  RATE_LIMIT_ACCOUNT: 6,
  RATE_LIMIT_TENANT: 6,
  PLATFORM_RATE_LIMIT: 6,
  LINKEDIN_RATE_LIMITED: 6,
  RATE_LIMITED: 6,

  // Transient platform (7)
  PLATFORM_ERROR: 7,
  LINKEDIN_SERVICE_UNAVAILABLE: 7,

  // Account / connection state (8)
  ACCOUNT_RESTRICTED: 8,
  RESOURCE_ACCESS_RESTRICTED: 8,
  LINKEDIN_AUTH_FAILED: 8,
  LINKEDIN_COOKIE_INVALID: 8,
  CONNECTION_IN_PROGRESS: 8,
  ACCOUNT_ALREADY_LINKED: 8,
  LINKEDIN_OPERATION_NOT_SUPPORTED: 8,
  CONNECTION_REQUEST_CONFLICT: 8,
  PREMIUM_CONFLICT: 8,
  REAUTH_REQUIRED: 8,

  // Checkpoint flow (9)
  CHECKPOINT_NOT_FOUND: 9,
  CHECKPOINT_EXPIRED: 9,
  CHECKPOINT_INVALID_CODE: 9,
  CHECKPOINT_MAX_ATTEMPTS: 9,
  CHECKPOINT_ALREADY_RESOLVED: 9,
  CHECKPOINT_UNSUPPORTED: 9,

  // Messaging window / recipient (10)
  MESSAGE_WINDOW_EXPIRED: 10,
  RECIPIENT_UNREACHABLE: 10,

  // Billing (11)
  PAYMENT_REQUIRED: 11,
  PAYMENT_FAILED: 11,
  SUBSCRIPTION_BUSY: 11,
  SEAT_CANCELLED: 11,

  // Internal / uncaught (1), last resort bucket
  INTERNAL: 1,
  PLATFORM_NOT_IMPLEMENTED: 1,
};

/**
 * Return the process exit code for a given ErrorCode.
 * Returns `1` for any unmapped or unknown code (safe default).
 */
export function getExitCode(code: ErrorCode): number {
  return EXIT_CODE_MAP[code] ?? 1;
}

/**
 * 12, auth action needed: a checkpoint is pending and the command did its
 * part; an out-of-band human step (submit a code, approve on the phone, or
 * resend) is still needed to finish auth. This is NOT derived from an
 * ErrorCode (a 202 checkpoint-required response is a success, not an error);
 * it is a named constant the checkpoint code paths call directly via
 * `process.exit(AUTH_NEEDED)`, deliberately absent from `EXIT_CODE_MAP`.
 * Distinct from 9 (checkpoint failure: expired / invalid / max-attempts,
 * "this checkpoint is dead"); 12 means "still resolvable, needs a human step."
 */
export const AUTH_NEEDED = 12;
