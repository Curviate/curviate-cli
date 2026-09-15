// SDK-client factory.
//
// Turns the resolved effective config (API key, base URL, timeout) into a
// Curviate instance. This is the single construction point, every command
// that calls the API goes through here; commands that do not call the API
// (--help, --version, login, config, webhook verify) never invoke it.
//
// Dev fills in the full config-resolution logic (profile, env, flags) in a
// follow-up pass; this module provides the factory signature for wiring.

import { AsyncLocalStorage } from "node:async_hooks";
import { Curviate, CurviateError } from "@curviate/sdk";
import { assertNoStdinPlaceholder } from "./stdin.js";
import { betaOverrideHeader } from "./beta.js";

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
const guardedFetch: typeof fetch = async (input, init) => {
  // `--beta` rides here rather than through the SDK's config, because the SDK
  // exposes no custom-header option and this is the seam the CLI already owns.
  // Merged as ADDITIONAL headers only: the SDK's own `authorization` and
  // `content-type` are copied through untouched, so this can never drop the
  // credential or break a multipart boundary.
  // `new Headers(init?.headers)` does the shape normalisation: the SDK builds a
  // plain object today, and this keeps working unchanged if it ever hands over
  // a Headers or an array of pairs. Everything already set, `authorization`
  // included, is carried across, so this can never drop the credential.
  const beta = betaOverrideHeader();
  let merged = init;
  if (Object.keys(beta).length > 0) {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(beta)) headers.set(name, value);
    merged = { ...init, headers };
  }

  assertNoStdinPlaceholder("the request about to be sent", [
    String(input instanceof Request ? input.url : input),
    ...headerStrings(merged?.headers),
    typeof merged?.body === "string" ? merged.body : undefined,
  ]);
  const res = await fetch(input, merged);
  return downloading.getStore() && res.ok ? asOpaqueBytes(res) : platformFaultIfUnreadable(res);
};

const downloading = new AsyncLocalStorage<true>();

/**
 * Run a binary download. Inside it a 2xx body is the file, saved verbatim
 * whatever its content type: the server passes the stored file's own type
 * through, so an HTML page or a JSON document is still the file, never a
 * platform fault. A non-2xx keeps the usual classification.
 */
export function downloadBinary<T>(call: () => Promise<T>): Promise<T> {
  return downloading.run(true, call);
}

/** Relabel so the SDK hands back the raw bytes instead of decoding JSON. */
function asOpaqueBytes(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("content-type", "application/octet-stream");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * A response that is no API answer came back over a working connection from
 * something that failed, so it is a platform fault: exit 7, retry with
 * backoff. Two shapes: a 5xx whose body is not an error envelope (a proxy's
 * HTML page, an empty body), which the SDK would decode as `INTERNAL` (exit
 * 1); and a 2xx with a non-empty body that is not JSON, whatever its content
 * type, which the SDK would crash on (exit 1) or hand over as bytes that print
 * as `{}` (exit 0). A 5xx that DOES carry an envelope keeps its declared code.
 * An empty 2xx is a bodyless success, handed on without a content type so the
 * SDK reads it the way it reads a 204. A 2xx inside `downloadBinary` never
 * reaches here.
 */
async function platformFaultIfUnreadable(res: Response): Promise<Response> {
  const text = res.status === 204 ? "" : await res.clone().text();
  let parsed = true;
  let env: { code?: unknown } | null = null;
  try {
    env = JSON.parse(text) as { code?: unknown } | null;
  } catch {
    parsed = false;
  }
  if (res.status >= 500) {
    if (typeof env?.code === "string") return res;
  } else if (!res.ok || parsed) {
    return res;
  } else if (text === "") {
    const headers = new Headers(res.headers);
    headers.delete("content-type");
    return new Response(null, { status: res.status, statusText: res.statusText, headers });
  }
  const headers = new Headers(res.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(
    JSON.stringify({
      code: "PLATFORM_ERROR",
      message: `The API answered ${res.status} without a readable body.`,
      user_fixable: false,
      retry_likely_to_succeed: true,
    }),
    // A 2xx has to become an error status for the SDK to decode it as one.
    { status: res.status >= 500 ? res.status : 502, statusText: res.statusText, headers },
  );
}

/** A refusal before any request: `INVALID_REQUEST`, exit 2. */
function usage(message: string): CurviateError {
  return new CurviateError({ code: "INVALID_REQUEST", message, userFixable: true, retryLikelyToSucceed: false });
}

/**
 * Why `baseUrl` cannot be sent to, or null when it can. A base URL the
 * transport cannot use is a usage error: nothing reaches the network, so it
 * is exit 2, never 1 (an uncaught `Invalid URL`) or 7 (a scheme `fetch`
 * refuses, misread as a network fault). Exported so `login` and
 * `config set-base-url` refuse it before saving.
 */
export function baseUrlProblem(baseUrl: string): string | null {
  let protocol: string | undefined;
  try {
    protocol = new URL(baseUrl).protocol;
  } catch {
    protocol = undefined;
  }
  return protocol === "http:" || protocol === "https:"
    ? null
    : "Invalid base URL: expected an absolute http:// or https:// URL. Check --base-url, CURVIATE_BASE_URL, or the profile's baseUrl.";
}

const MAX_TIMEOUT_MS = 2_147_483_647; // the largest delay a Node timer honours

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
  const badUrl = config.baseUrl === undefined ? null : baseUrlProblem(config.baseUrl);
  if (badUrl) throw usage(badUrl);
  const t = config.timeout;
  if (t !== undefined && !(Number.isInteger(t) && t > 0 && t <= MAX_TIMEOUT_MS)) {
    throw usage(
      `Invalid timeout: expected a whole number of milliseconds from 1 to ${MAX_TIMEOUT_MS}. Check --timeout or the profile's timeout.`,
    );
  }
  return new Curviate({
    apiKey: config.apiKey.trim(),
    fetch: guardedFetch,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
  });
}
