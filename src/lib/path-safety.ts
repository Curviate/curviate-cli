/**
 * The rule for what may be used as an `--account` selector.
 *
 * ## Scope: this is about `--account`, not about every argument
 *
 * An earlier revision applied this rule to every leading string argument of
 * every SDK call. That was unsound in both directions (see `client.ts`), and it
 * is gone: which argument becomes a path segment is the SDK's knowledge, and
 * percent-encoding path parameters is the SDK's job.
 *
 * What is left is the one value the CLI genuinely understands. `--account`
 * names a live LinkedIn persona, and the CLI resolves it: it is either an
 * `acc_`-shaped id used as-is, or a connected account's name looked up against
 * the account list. Neither of those carries a slash, a question mark or a
 * percent sign, so a value that does is a caller mistake worth naming before
 * anything is sent, and the resolved id is checked once more on the way out.
 *
 * ## Why the rule is shaped the way it is
 *
 * The account id is interpolated into the path of every account-scoped request,
 * so an unresolved `--account` reaching a URL is not a cosmetic problem. The
 * URL parser is not a passive consumer of that string. Given
 * `/v1/<value>/chats/chat_1`, it will happily rewrite the request:
 *
 *   value = 'x/../../../v1/accounts'  ->  /v1/accounts/chats/chat_1
 *   value = 'a?x=1'                   ->  /v1/a?x=1/chats/chat_1  (query injected)
 *   value = 'a#x'                     ->  /v1/a  (the rest becomes a fragment)
 *   value = '%2e%2e'                  ->  /chats/chat_1  (the /v1 prefix popped)
 *
 * The last one is the trap. It contains no slash and no literal dot: the URL
 * Standard percent-decodes when it decides whether a segment is a "double-dot
 * path segment", so `%2e%2e`, `.%2e` and `%2E%2e` all traverse. A guard that
 * only banned `/` and `..` would pass it.
 *
 * That matters most on the CLI's write surface. A read sent to the wrong path
 * wastes a round trip. A write sent to the wrong path acts, with the caller's
 * bearer token, on a resource the caller never named, and this CLI is wired
 * into agent loops where `--account` is plausibly filled from model or user
 * text.
 *
 * ## Why reject rather than encode
 *
 * Percent-encoding the value here would also close the hole, but it would
 * silently change the bytes of every id already in flight (URNs carry `:`,
 * `(`, `)`, `,`; chat ids carry `=`), turning a published CLI's wire format
 * into a guess. Rejecting is the honest option: a value that cannot be a path
 * segment is a caller mistake, and the caller is told so before anything is
 * sent.
 *
 * ## Deny, not allow
 *
 * The rule is a denylist of the characters that are structurally significant
 * in a URL, not an allowlist of "id-shaped" characters. An account id is the
 * platform's to shape, and a person's display name is theirs, so an allowlist
 * would reject a legitimate selector the day either changes. A denylist can
 * only ever reject a value that was already going to produce a wrong URL.
 *
 * ## Two strengths, because a selector is not a segment
 *
 * The module exports the rule at two strengths, and the difference is exactly
 * the plain space:
 *
 *   - `redirectingViolation` rejects everything that can move a request to a
 *     different endpoint, and tolerates a space. It is what guards a value the
 *     caller may have typed as a human-meaningful *selector* (an account name
 *     such as "Ralf Fischer"), which is resolved to an id and never reaches a
 *     URL itself.
 *   - `pathSegmentViolation` additionally rejects the space. It is what guards
 *     any value that is about to be interpolated into a path, including the id
 *     a selector resolved to.
 *
 * A space cannot redirect a request (the URL parser percent-encodes it), so
 * banning it from selectors would buy no safety and would make every real
 * two-word LinkedIn name unusable.
 */

/**
 * Characters that cannot appear in a value destined for a path segment.
 *
 *   - U+0000 to U+0020 and U+007F: C0 controls, space, DEL. Tab, LF and CR are
 *     *deleted* by the URL parser rather than encoded, which lets a value
 *     smuggle a shape past a human reading it back.
 *   - `/` and `\`: segment separators (the parser normalizes `\` to `/`).
 *   - `?` and `#`: start of the query and of the fragment.
 *   - `%`: the escape hatch for every character above, and the reason
 *     `%2e%2e` traverses without a literal dot.
 */
const UNSAFE_CHARS = /[\u0000-\u0020\u007F/\\?#%]/;

/**
 * Non-ASCII whitespace: NBSP, Ogham space mark, the en-quad family, line and
 * paragraph separators, narrow/medium mathematical spaces, ideographic space,
 * and the byte-order mark.
 */
const UNICODE_WHITESPACE = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/;

/** A human-readable name for the character at `index`, for the error message. */
function describeChar(value: string, index: number): string {
  const ch = value[index] ?? "";
  const named: Record<string, string> = {
    "/": "a slash",
    "\\": "a backslash",
    "?": "a question mark",
    "#": "a hash",
    "%": "a percent sign",
    " ": "a space",
    "\t": "a tab",
    "\n": "a newline",
    "\r": "a carriage return",
  };
  return (
    named[ch] ??
    `the character U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`
  );
}

/**
 * Index of the first character that could redirect the request, or -1.
 *
 * The plain space is skipped: a space in a path segment is percent-encoded by
 * the URL parser, not acted on, so it cannot move the request anywhere. Every
 * other member of the unsafe set can.
 */
function firstRedirectingIndex(value: string): number {
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === " ") continue;
    if (UNSAFE_CHARS.test(ch) || UNICODE_WHITESPACE.test(ch)) return i;
  }
  return -1;
}

/**
 * Why `value` could redirect a request, or `null` when it could not.
 *
 * This is the *hard* half of the rule: a value failing it is rejected outright,
 * before anything is sent, because there is no reading of it that is not an
 * attempt to reach a different endpoint. It tolerates the plain space, so a
 * human-meaningful selector ("Ralf Fischer") can be checked with it and then
 * resolved to an id, which is checked with the stricter
 * `pathSegmentViolation` before it reaches a URL.
 */
export function redirectingViolation(value: string): string | null {
  if (value.length === 0) return "it is empty";

  const i = firstRedirectingIndex(value);
  if (i >= 0) return `it contains ${describeChar(value, i)}`;

  // Reached only for values with no `%` left (banned above), so a literal `..`
  // is the sole remaining spelling of a dot segment.
  if (value.includes("..")) return 'it contains ".."';
  if (value === ".") return 'it is "."';

  return null;
}

/**
 * Why `value` cannot be used as a path segment, or `null` when it can.
 *
 * Strictly stronger than `redirectingViolation`: it additionally rejects the
 * plain space. A space cannot redirect anything, but no account id this API
 * mints contains one, so a space in a value that is about to become a path
 * segment means the caller passed something that is not an id, and saying so
 * beats sending `%20` and round-tripping a 404.
 *
 * Pure and synchronous: no I/O, no exit, no output. Callers own how the reason
 * is surfaced.
 */
export function pathSegmentViolation(value: string): string | null {
  const redirecting = redirectingViolation(value);
  if (redirecting !== null) return redirecting;
  if (value.includes(" ")) return "it contains a space";
  return null;
}

/**
 * The usage-error message for a rejected path-segment value.
 *
 * `label` is what the caller typed, spelled the way they typed it, so the
 * message points at the right argument: `--account`, `<chat_id>`, `--list-id`.
 */
export function pathSegmentErrorMessage(
  label: string,
  value: string,
  reason: string,
): string {
  return (
    `error: [INVALID_PATH_SEGMENT] ${label}: ${reason}, so it cannot be part of a request path. ` +
    `A value carrying a slash, backslash, question mark, hash, percent sign, whitespace, or ".." ` +
    `would redirect the request to a different endpoint. ` +
    `Received: ${JSON.stringify(value)}.\n`
  );
}
