/**
 * Challenge-type display copy and the checkpoint-resend hint for the guided
 * checkpoint follow-through on `account link` / `account reconnect` (and
 * shared with the checkpoint poll wait loop).
 *
 * Keep in sync with the dashboard's ConnectAccountModal challengeTitle /
 * challengeDescription helpers (component name only, not a path or a spec
 * reference — neither is published in this package). Two deliberate
 * deviations from that dashboard copy:
 *   1. the dashboard's otp / two_factor_sms descriptions end with a
 *      UI-deictic "Enter it below." clause — dropped here, since a CLI
 *      prompt follows immediately and there is no "below" to point at.
 *   2. the dashboard has no mobile_app_approval description case yet, so
 *      this file supplies its own body for that type.
 */

export type ChallengeType = "otp" | "two_factor_sms" | "two_factor_app" | "mobile_app_approval";

export interface CopyOut {
  stderr: { write: (s: string) => void };
}

/** Resendable challenge types — two_factor_app (an authenticator TOTP code) has nothing to resend. */
const RESENDABLE_CHALLENGE_TYPES: ReadonlySet<string> = new Set([
  "otp",
  "two_factor_sms",
  "mobile_app_approval",
]);

export function challengeTitle(type: ChallengeType): string {
  switch (type) {
    case "otp": return "Check your email";
    case "two_factor_sms": return "Enter SMS code";
    case "two_factor_app": return "Enter authenticator code";
    case "mobile_app_approval": return "Approve in LinkedIn app";
  }
}

export function challengeDescription(type: ChallengeType): string {
  switch (type) {
    case "otp":
      return "LinkedIn sent a one-time code to your registered email address.";
    case "two_factor_sms":
      return "LinkedIn sent a verification code to your registered phone number.";
    case "two_factor_app":
      return "Enter the current code from your authenticator app.";
    case "mobile_app_approval":
      return "Open your LinkedIn mobile app and approve this sign-in. This will continue automatically once you tap approve.";
  }
}

/** Print the title + description for a checkpoint stage to stderr (progress/human chrome, not data). */
export function printChallengeCopy(type: ChallengeType, out: CopyOut): void {
  out.stderr.write(`${challengeTitle(type)}\n${challengeDescription(type)}\n`);
}

/**
 * Print the checkpoint-resend hint (stderr, one line) for resendable
 * challenge types; a no-op for the rest (e.g. two_factor_app). Shared
 * between the link/reconnect guided loop and the checkpoint poll wait loop
 * so the copy and the resendable-type gating live in exactly one place.
 * The referenced resend command does not need to exist yet for this hint
 * text to be correct — it is only ever a printed string.
 */
export function printResendHintIfApplicable(
  type: ChallengeType,
  accountId: string,
  out: CopyOut,
): void {
  if (!RESENDABLE_CHALLENGE_TYPES.has(type)) return;
  out.stderr.write(
    `No code/notification? Re-send it: curviate account checkpoint request ${accountId}\n`,
  );
}
