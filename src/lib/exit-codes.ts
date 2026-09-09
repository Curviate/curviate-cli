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
 *   5: entitlement (no seat, no LinkedIn subscription, or no beta consent)
 *   6: rate-limited
 *   7: transient platform (retry-likely)
 *   8: account / connection state
 *   9: checkpoint flow
 *  10: messaging window / recipient
 *  11: billing
 *  12: auth action needed (a pending checkpoint; not an error)
 *  13: account-safety budget (Curviate's own ceiling refused the action)
 *  14: nothing stored (a `--mode cache_only` read the store cannot answer)
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
 * Note: EXIT 5 CARRIES THREE CODES, and they are fixed in three different
 * systems. `NO_ACTIVE_SEAT` is Curviate-side (buy or attach a seat),
 * `LINKEDIN_FEATURE_NOT_SUBSCRIBED` is LinkedIn-side (the account needs its
 * own Sales Navigator or Recruiter subscription), and `BETA_NOT_ENABLED` is
 * consent-side (a human enables beta in Settings, or pass --beta for this
 * call). They share exit 5 because the remedy is the same SHAPE, a human
 * changes something and retries, and a scripted caller branching on the exit
 * code alone wants one bucket for that. It does NOT mean they are
 * interchangeable: read the `code` in the `--json` envelope to know which
 * system to go to. Reusing 5 for the beta refusal rather than minting a new
 * number is deliberate, because an exit code is a public contract and a new
 * one is a breaking change for every caller's case statement.
 *
 * Note: `BUDGET_EXHAUSTED` -> 13, A NEW BUCKET, deliberately not 6.
 * Exit 6 means "back off and retry later", and that is the wrong action here:
 * this is Curviate's OWN account-safety ceiling, on a number the caller set.
 * Nothing reached LinkedIn and nothing was spent, the reset can be a month
 * out, and a caller may lift it immediately by raising the limit the error's
 * hint names, or by waiting for its reset instant. An agent branching on 6
 * would sleep and re-fire against a wall that does not move on that timescale.
 * It is not 8 either: nothing is wrong with the account or its connection.
 * The error body carries `budgetRow`, `resetAt`, `safetyHint`, `safetyReason`
 * and `blocked` for the caller that wants the specifics.
 *
 * Note: `LINKEDIN_SESSION_EVICTED` -> 8, not 3 (auth) and not 1 (the unmapped
 * default). LinkedIn allows only one session at a time for some accounts, and
 * a person signing in elsewhere breaks the connected one. It is the account's
 * connection state, not the CLI's own credentials, and the remedy is closing
 * the other session, so it belongs with `LINKEDIN_AUTH_FAILED` and
 * `LINKEDIN_COOKIE_INVALID`. Left unmapped it fell to 1, which reads as an
 * internal failure and tells a scripted caller nothing.
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
  // 2, found by the SDK-pin gate at the bottom of test/lib/exit-codes.test.ts
  // on its first run. It has been in the SDK's taxonomy and absent from this
  // table, so it fell to the unmapped 1 and read as an internal failure. It is
  // a 422 saying a plain-string search filter matched several LinkedIn
  // taxonomy options: `unresolved[]` names the fields and their candidate ids,
  // it is user_fixable, and it is never retryable AS SENT. Re-send with a
  // chosen id, which is the exit-2 contract exactly.
  FILTER_CANDIDATES_REQUIRED: 2,

  // Not found (4)
  RESOURCE_NOT_FOUND: 4,
  ACCOUNT_NOT_FOUND: 4,
  SUBSCRIPTION_NOT_FOUND: 4,
  SEAT_NOT_FOUND: 4,

  // Entitlement (5), three independent refusals, see the note above
  NO_ACTIVE_SEAT: 5,
  LINKEDIN_FEATURE_NOT_SUBSCRIBED: 5,
  BETA_NOT_ENABLED: 5,
  // DEPRECATED, and mapped anyway. `TIER_NOT_ACTIVE` is what a deployment
  // predating the seat-based entitlement rollout answers instead of
  // `NO_ACTIVE_SEAT`, and this CLI is pointed at whichever deployment the
  // caller configured. Unmapped it would fall to exit 1 and read as "the tool
  // broke" for a plain billing refusal, on exactly the deployments most likely
  // to send it. Same bucket as its replacement, because the caller's remedy is
  // identical. Removed once every deployment carries the new contract.
  TIER_NOT_ACTIVE: 5,

  // Rate-limited (6)
  RATE_LIMIT_ACCOUNT: 6,
  RATE_LIMIT_TENANT: 6,
  PLATFORM_RATE_LIMIT: 6,
  LINKEDIN_RATE_LIMITED: 6,

  // Transient platform (7)
  PLATFORM_ERROR: 7,
  LINKEDIN_SERVICE_UNAVAILABLE: 7,

  // Account / connection state (8)
  ACCOUNT_RESTRICTED: 8,
  RESOURCE_ACCESS_RESTRICTED: 8,
  LINKEDIN_AUTH_FAILED: 8,
  LINKEDIN_SESSION_EVICTED: 8,
  LINKEDIN_COOKIE_INVALID: 8,
  CONNECTION_IN_PROGRESS: 8,
  ACCOUNT_ALREADY_LINKED: 8,
  LINKEDIN_OPERATION_NOT_SUPPORTED: 8,
  CONNECTION_REQUEST_CONFLICT: 8,
  REAUTH_REQUIRED: 8,
  // DEPRECATED, mapped for the same reason as `TIER_NOT_ACTIVE` above: the
  // connect rework made it unreachable on current deployments, and an older one
  // can still send it. A seat resolving to both individual-Premium products at
  // once, which is the same "this account/seat is in a state that blocks the
  // request" shape as `ACCOUNT_RESTRICTED`.
  PREMIUM_CONFLICT: 8,

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

  // Account-safety budget (13), see the note above for why this is not 6
  BUDGET_EXHAUSTED: 13,

  // Nothing stored (14), A NEW BUCKET, and deliberately not 4.
  // `NOT_STORED` is a 422 answering a `--mode cache_only` read: the resource
  // may exist perfectly well on LinkedIn, and this API simply holds no copy of
  // it, so it is NOT "not found" and re-checking the id is the wrong move. It
  // is not 1 either: nothing failed. It is user_fixable and not retryable AS
  // SENT — the fix is another mode (`refill` fetches it once, `auto` fetches
  // now), which is the same shape as exit 2 but reached without a malformed
  // request, so it earns its own number rather than muddying either.
  // A 502 under cache_only stays 7: "we could not look" and "we hold nothing"
  // are different answers and only one of them is worth retrying.
  NOT_STORED: 14,

  // ── Codes that used to fall through to 1 ─────────────────────────────────
  //
  // Each of these is returned by a `/v1` route, the `/v1` catch-all, or a
  // shared handler one of them calls, and each was absent from the SDK's
  // exported union until 0.30.0 — so it decoded to `INTERNAL` and landed here
  // on exit 1, which reads as "the tool broke" for a refusal that is usually
  // the caller's to fix. They are bucketed by what the caller does next, taken
  // from each code's own HTTP status and retry contract rather than by name.

  // Not found (4). `NOT_FOUND` is the catch-all's answer to a path this API
  // does not serve, which is also what a MISTYPED path returns, so check the
  // URL shape before the ids. `REACTION_NOT_FOUND` is a 422 rather than a 404,
  // and is still a not-found in the only sense that matters to a caller: the
  // reaction you asked to remove is not on that post.
  NOT_FOUND: 4,
  REACTION_NOT_FOUND: 4,

  // Transient platform (7). All four are a dependency failing, not the request
  // being wrong: 502 from the connect path and from Stripe checkout, 503 from
  // the substrate capacity ceiling and the billing portal. Backing off and
  // retrying is the right move, which is what 7 means.
  SUBSTRATE_LINK_FAILED: 7,
  SUBSTRATE_CAP_REACHED: 7,
  BILLING_CHECKOUT_FAILED: 7,
  BILLING_PORTAL_UNAVAILABLE: 7,

  // Invalid input / usage (2). Both are the REQUEST being inapplicable rather
  // than a state to wait out: `ADMIN_BYPASS` is a 400 saying an admin
  // workspace has no Stripe billing, so the billing operations do not apply to
  // it at all; `INVALID_CANCELLATION_SOURCE` is a rejected field VALUE. Note
  // the neighbours below are also 400s and are NOT 2, because they describe a
  // state the caller has to resolve, not an argument to correct.
  ADMIN_BYPASS: 2,
  INVALID_CANCELLATION_SOURCE: 2,

  // Billing (11). Tenant standing, seat and subscription state, and the
  // free-trial limits. Every one is user_fixable and none clears on an
  // identical retry: the fix is in billing, in the dashboard, or in choosing a
  // different target. Grouped with `PAYMENT_REQUIRED` / `SEAT_CANCELLED`
  // above, which are the same shape.
  ACCOUNT_DISPUTED: 11,
  ACCOUNT_LINKING_DISABLED: 11,
  PERIOD_LOCKED: 11,
  SEAT_NOT_EMPTY: 11,
  SEAT_PROVISIONAL: 11,
  SUBSCRIPTION_ALREADY_EXISTS: 11,
  ALREADY_CANCELLED: 11,
  CANCELLATION_ALREADY_EFFECTIVE: 11,
  TRIAL_EXPIRED: 11,
  TRIAL_SEAT_LIMIT: 11,
  TRIAL_ACTIVE_SEAT_LIMIT: 11,
  TRIAL_IDENTITY_ALREADY_USED: 11,
  TRIAL_IDENTITY_UNRESOLVED: 11,

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
