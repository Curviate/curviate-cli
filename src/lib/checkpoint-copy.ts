/**
 * Challenge-type display copy and the checkpoint-resend hint for the guided
 * checkpoint follow-through on `account link` / `account reconnect` (and
 * shared with the checkpoint poll wait loop).
 *
 * Keep in sync with the dashboard's ConnectAccountModal challengeTitle /
 * challengeDescription helpers (component name only, not a path or a spec
 * reference, neither is published in this package). Two deliberate
 * deviations from that dashboard copy:
 *   1. the dashboard's otp / two_factor_sms descriptions end with a
 *      UI-deictic "Enter it below." clause: dropped here, since a CLI
 *      prompt follows immediately and there is no "below" to point at.
 *   2. the dashboard has no mobile_app_approval description case yet, so
 *      this file supplies its own body for that type.
 */

export type ChallengeType =
  | "otp"
  | "two_factor_sms"
  | "two_factor_app"
  | "two_factor_whatsapp"
  | "mobile_app_approval"
  | "otp_or_mobile_app_approval"
  | "checking"
  | "phone_register"
  | "contract_selection"
  | "challenge_selection";

/** Where LinkedIn sent a code; `null` or absent means the API does not know, and the copy then names none. */
export type Channel = "email" | "sms" | "whatsapp" | null | undefined;

export interface CopyOut {
  stderr: { write: (s: string) => void };
}

/** Resendable challenge types, two_factor_app (an authenticator TOTP code) has nothing to resend. */
const RESENDABLE_CHALLENGE_TYPES: ReadonlySet<string> = new Set([
  "otp",
  "two_factor_sms",
  "two_factor_whatsapp",
  "mobile_app_approval",
  "otp_or_mobile_app_approval",
]);

/** Types that can ask LinkedIn for another method: every code or approval, authenticator included; no choice, phone or wait step. */
const ANOTHER_WAY_TYPES: ReadonlySet<string> = new Set([...RESENDABLE_CHALLENGE_TYPES, "two_factor_app"]);

const VIA: Record<"email" | "sms" | "whatsapp", string> = { email: "by email", sms: "by text message", whatsapp: "on WhatsApp" };

export function challengeTitle(type: ChallengeType, channel?: Channel): string {
  switch (type) {
    case "otp":
      return channel === "email" ? "Check your email" : channel === "sms" ? "Check your text messages" : channel === "whatsapp" ? "Check WhatsApp" : "Enter the verification code";
    case "two_factor_sms": return "Enter SMS code";
    case "two_factor_whatsapp": return "Check WhatsApp";
    case "two_factor_app": return "Enter authenticator code";
    case "mobile_app_approval": return "Approve in LinkedIn app";
    case "otp_or_mobile_app_approval": return "Enter the code or approve in the LinkedIn app";
    case "checking": return "LinkedIn is checking this sign-in";
    case "phone_register": return "Add your mobile number";
    case "contract_selection": return "Choose a contract";
    case "challenge_selection": return "Choose how LinkedIn verifies this sign-in";
  }
}

export function challengeDescription(type: ChallengeType, channel?: Channel): string {
  switch (type) {
    case "otp":
      return channel === "email"
        ? "LinkedIn sent a one-time code to your registered email address."
        : channel === "sms"
          ? "LinkedIn texted a verification code to your registered phone number."
          : channel === "whatsapp"
            ? "LinkedIn sent a verification code to you on WhatsApp."
            : "LinkedIn sent you a verification code.";
    case "two_factor_sms":
      return "LinkedIn sent a verification code to your registered phone number.";
    case "two_factor_whatsapp":
      return "LinkedIn sent a verification code to you on WhatsApp.";
    case "two_factor_app":
      return "Enter the current code from your authenticator app.";
    case "mobile_app_approval":
      return "Open your LinkedIn mobile app and approve this sign-in. This will continue automatically once you tap approve.";
    case "otp_or_mobile_app_approval":
      return `LinkedIn sent you a code${channel ? ` ${VIA[channel]}` : ""}. Enter it, or approve this sign-in in the LinkedIn app.`;
    case "checking":
      return "Nothing to do yet. This continues automatically.";
    case "phone_register":
      return "LinkedIn asks for a mobile number before it signs in, then sends a code to it. Enter it as (+CC)number, for example (+49)1701234567.";
    case "contract_selection":
      return "This account has several contracts; pick the one to send from.";
    case "challenge_selection":
      return "LinkedIn offers more than one way to verify this sign-in.";
  }
}

/** Print the title + description for a checkpoint stage to stderr (progress/human chrome, not data). */
export function printChallengeCopy(type: ChallengeType, out: CopyOut, channel?: Channel): void {
  out.stderr.write(`${challengeTitle(type, channel)}\n${challengeDescription(type, channel)}\n`);
}

/**
 * Print the checkpoint-resend hint (stderr, one line) for resendable
 * challenge types; a no-op for the rest (e.g. two_factor_app). Shared
 * between the link/reconnect guided loop and the checkpoint poll wait loop
 * so the copy and the resendable-type gating live in exactly one place.
 * The referenced resend command does not need to exist yet for this hint
 * text to be correct; it is only ever a printed string.
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

/** The other footer line: ask LinkedIn for a different method (sends no attempt). A no-op where LinkedIn offers none. */
export function printAnotherWayHintIfApplicable(type: ChallengeType, accountId: string, out: CopyOut): void {
  if (!ANOTHER_WAY_TYPES.has(type)) return;
  out.stderr.write(`Can't use this method? Ask LinkedIn for another: curviate account checkpoint solve ${accountId} --code TRY_ANOTHER_WAY\n`);
}
