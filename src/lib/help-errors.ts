/**
 * ERRORS entries the `core` commands share, beyond the shared set
 * (UNAUTHORIZED, INVALID_REQUEST, rate limits, PLATFORM_ERROR). Command meta
 * spreads the ones that apply and adds its own; the exit numbers render from
 * EXIT_CODE_MAP (lib/examples.ts).
 */

/** Every call acts as one connected LinkedIn Account. */
export const AS_ACCOUNT = {
  ACCOUNT_NOT_FOUND: "the Account is not in your Team.",
  LINKEDIN_AUTH_FAILED: "LinkedIn no longer accepts the Account's sign-in: reconnect it.",
  ACCOUNT_RESTRICTED: "LinkedIn restricts the Account from this action.",
};

/** The command counts against a budget row. */
export const BUDGET = {
  BUDGET_EXHAUSTED: "the Account's limit for this action is used up; nothing reached LinkedIn. `curviate account get <account_id>` shows when it resets.",
};

/** The command names a thing on LinkedIn. */
export const TARGET = {
  RESOURCE_NOT_FOUND: "the target does not exist, or the Account cannot see it.",
};
