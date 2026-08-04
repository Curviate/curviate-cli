// SDK-client factory.
//
// Turns the resolved effective config (API key, base URL, timeout) into a
// Curviate instance. This is the single construction point — every command
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

export interface ClientConfig {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
}

/**
 * Construct a Curviate client from the resolved effective config.
 * The apiKey is passed verbatim — no prefix validation, no trimming beyond
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
