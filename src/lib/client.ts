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
import { pathSegmentErrorMessage, pathSegmentViolation } from "./path-safety.js";

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
 * Methods whose leading string argument is NOT about to become a path segment.
 *
 * Exactly one: `client.account(accountId)` is a namespace factory, not a
 * request, and its argument is already the most closely guarded value in the
 * CLI. `requireAccount` returns only an `acc_`-shaped id (path-safe by its own
 * pattern), an id it has explicitly run `pathSegmentViolation` over, or, under
 * `--preview`, a selector it will never send. Validating it a second time here
 * would reject that last case and break `--preview` on a name, which is the one
 * shape deliberately allowed to carry a space.
 */
const NOT_A_PATH_CALL = new Set(["account"]);

/**
 * Apply the path-segment rule to every call the CLI makes into the SDK.
 *
 * ## Why here and not in the commands
 *
 * Almost every id the CLI forwards lands in a URL path segment, and the SDK
 * interpolates path segments verbatim, so each one is an injection point:
 * `inbox mark-read 'x/../../../v1/accounts'` sent `PATCH /v1/v1/accounts`,
 * a write redirected onto a path the caller never named, with the caller's
 * bearer token, exit 0.
 *
 * Fixing that argument by argument means maintaining a list of "the values that
 * are path segments". That list is exactly the kind that loses a member: the
 * SDK has 69 distinct interpolating path templates today and gains more, and an
 * argument added next month would be unguarded while looking identical from the
 * outside to a guarded one. So the rule is applied once, at the boundary every
 * request must cross, and derived from the SDK's own calling convention rather
 * than from an enumeration.
 *
 * ## The convention this relies on
 *
 * Path parameters are the leading string arguments; bodies and query objects
 * follow. That holds across all 86 SDK methods that take a string
 * (`markChatRead(chatId, body)`, `getMessage(chatId, messageId)`,
 * `browseAccountList(listId, body, query)`), and it is what lets the rule stop
 * at the first non-string argument instead of guessing which strings matter.
 * A free-text value is never passed positionally, so no message body, keyword or
 * note is ever subject to this.
 *
 * Exits 2 before the call, so nothing is sent, and names the method and
 * argument position rather than a generic failure.
 */
function guardPathSegments<T extends object>(target: T, prefix: string): T {
  return new Proxy(target, {
    get(t, prop) {
      // `this` is bound to the raw target below, so getters and private state
      // behave exactly as they would without the proxy.
      const value = Reflect.get(t, prop) as unknown;
      if (typeof prop === "symbol") return value;
      const label = prefix === "" ? prop : `${prefix}.${prop}`;

      if (typeof value === "function") {
        const fn = value as (...a: unknown[]) => unknown;
        const exempt = NOT_A_PATH_CALL.has(label);
        return (...args: unknown[]): unknown => {
          if (!exempt) {
            for (let i = 0; i < args.length; i++) {
              const arg = args[i];
              // The first non-string argument is the body or query; every path
              // parameter has been seen by then.
              if (typeof arg !== "string") break;
              const reason = pathSegmentViolation(arg);
              if (reason !== null) {
                process.stderr.write(
                  pathSegmentErrorMessage(`${label} argument ${i + 1}`, arg, reason),
                );
                process.exit(2);
              }
            }
          }
          const result = fn.apply(t, args);
          // A namespace factory hands back an object rather than a promise;
          // keep guarding the methods underneath it.
          if (
            result !== null &&
            typeof result === "object" &&
            typeof (result as { then?: unknown }).then !== "function"
          ) {
            // The account factory is dropped from the label so a diagnostic
            // names the method the way `--preview` already prints it
            // ("messaging.markChatRead"), rather than the internal call chain.
            return guardPathSegments(result as object, exempt ? prefix : label);
          }
          return result;
        };
      }

      if (value !== null && typeof value === "object") {
        return guardPathSegments(value as object, label);
      }
      return value;
    },
  });
}

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
  const client = new Curviate({
    apiKey: config.apiKey.trim(),
    fetch: guardedFetch,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
  });
  return guardPathSegments(client, "");
}
