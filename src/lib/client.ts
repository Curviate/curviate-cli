// SDK-client factory.
//
// Turns the resolved effective config (API key, base URL, timeout) into a
// Curviate instance. This is the single construction point, every command
// that calls the API goes through here; commands that do not call the API
// (--help, --version, login, config, webhook verify) never invoke it.
//
// Dev fills in the full config-resolution logic (profile, env, flags) in a
// follow-up pass; this module provides the factory signature for wiring.

import { Curviate } from "@curviate/sdk";
import { assertNoStdinPlaceholder } from "./stdin.js";

/** Every header name and value in a `RequestInit`, whatever shape it came in. */
function headerStrings(headers: RequestInit["headers"]): string[] {
  if (!headers) return [];
  if (headers instanceof Headers) {
    const out: string[] = [];
    headers.forEach((value, key) => out.push(key, value));
    return out;
  }
  if (Array.isArray(headers)) return headers.flat().map(String);
  return Object.entries(headers).flat().map(String);
}

/**
 * The transport every API call goes through, with the stdin-placeholder
 * backstop in front of it.
 *
 * The dispatcher already restores a literal dash for any argument that did not
 * opt into reading stdin, so in a correct build nothing here ever fires. That
 * is the point: this catches the value that arrived by a route the argument
 * layer never sees (an environment variable, a config file, a code path written
 * next year), which is precisely the class of leak that reached the wire as a
 * LinkedIn password. Non-string bodies (streams, binary uploads) are not
 * scanned; the placeholder only ever originates as an argument value.
 */
const guardedFetch: typeof fetch = (input, init) => {
  assertNoStdinPlaceholder("the request about to be sent", [
    String(input instanceof Request ? input.url : input),
    ...headerStrings(init?.headers),
    typeof init?.body === "string" ? init.body : undefined,
  ]);
  return fetch(input, init);
};

/**
 * ## Why there is no path-segment guard here
 *
 * A previous revision wrapped the client in a proxy that walked each call's
 * leading string arguments and refused any that could not be a path segment,
 * on the premise that path parameters are always the leading strings. Both
 * halves of that premise are false, and the guard was wrong in both
 * directions:
 *
 *   - It MISSED calls whose path parameter arrives inside an object.
 *     `salesNavigator.saveLead({ list_id, user_id })` destructures `list_id`
 *     out of `args[0]`, so the walk saw a non-string and stopped before
 *     validating anything.
 *   - It WRONGLY REJECTED calls whose leading string is a BODY field.
 *     `posts.save(postId)` sends `{ post_id }` to `/v1/{account_id}/saved-posts`
 *     and `auth.solveCheckpoint(accountId, body)` sends `{ account_id, ... }`
 *     to `/v1/auth/checkpoint/solve`; neither value ever enters a path. So
 *     `post save <share URL>` went from exit 0 to a usage error whose stated
 *     reason ("would redirect the request to a different endpoint") was
 *     factually false for the value it was refusing.
 *
 * The general lesson is the reason this comment exists rather than a smaller
 * guard: **the CLI cannot soundly know which argument becomes a path segment.**
 * That knowledge lives in the SDK, which owns the path templates, and any
 * CLI-side rule is a proxy for it that drifts the moment a signature changes.
 * A guard that is wrong in both directions is worse than no guard when the
 * layer beneath is correct, so path-parameter encoding is the SDK's
 * responsibility and is discharged there (every path parameter is
 * percent-encoded through a tagged template, with a round-trip matrix over the
 * id shapes this API mints).
 *
 * What stays here is the stdin-placeholder egress backstop above, which is
 * about a value that must never be transmitted at all, and is therefore a
 * property of the request rather than of any argument position.
 *
 * `--account` is guarded separately in `account-arg.ts`, and that guard is
 * sound for a reason this one was not: the CLI genuinely knows what `--account`
 * means (it selects a live LinkedIn persona), so it can say that a value
 * carrying a slash is neither an account id nor anybody's name, without
 * guessing at a call signature.
 */

export interface ClientConfig {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
}

/**
 * Construct a Curviate client from the resolved effective config.
 * The apiKey is passed verbatim, no prefix validation, no trimming beyond
 * surrounding whitespace. The SDK is the validator of last resort.
 */
export function createClient(config: ClientConfig): Curviate {
  return new Curviate({
    apiKey: config.apiKey.trim(),
    fetch: guardedFetch,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
  });
}
