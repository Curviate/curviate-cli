/**
 * `--mode` / `--max-age`, the retrieval ladder on store-served reads.
 *
 * The API owns every rule here; this module mirrors them so a malformed
 * invocation costs a usage error instead of a round trip, which is the
 * exit-2 contract's "misuse pre-check before any network call".
 *
 * ## Mirroring a server rule is a liability, so only these three are mirrored
 *
 * A client-side copy is a second place for a rule to drift. What is copied
 * here is only what the server states as a fixed constant — the four-value
 * enum, the `0..31_536_000` integer bound, and the refusal of `cache_only`
 * with `max_age`. Everything policy-shaped (which threshold `auto` resolves
 * to, whether a row is fresh, whether anything is stored at all) is NOT
 * mirrored and cannot be: it lives in the freshness table and the store, and a
 * CLI guess at it would be wrong the first time the table changed.
 *
 * ## Where these flags may NOT be offered
 *
 * Only three served endpoints declare the pair, and the API REFUSES it — 400,
 * not ignore — on every endpoint that does not: a read that accepted
 * mode=cache_only and then called LinkedIn anyway would break the one
 * guarantee that parameter makes. So a command may expose these flags only
 * when its call maps to one of:
 *
 *   GET /v1/{account_id}/users/{user_id}                  → profile me, profile <id>
 *   GET /v1/{account_id}/chats/{chat_id}/messages         → inbox messages
 *   GET /v1/{account_id}/chats/{chat_id}                  → inbox get (SDK gap, see README)
 *
 * The entity reads that carry the response envelope but do NOT accept the
 * parameters (company, post, job, group) must not offer the flags: the request
 * would 400 rather than degrade.
 */

/** The four modes, in the server's decreasing-willingness-to-fetch order. */
export const RETRIEVAL_MODES = ["live", "auto", "refill", "cache_only"] as const;
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];

/**
 * The largest `max_age` the server accepts: one year, inclusive.
 * Mirrors the ceiling the API enforces on this parameter.
 */
export const MAX_AGE_CEILING_SECONDS = 31_536_000;

/** The two flags, ready to spread into a command's citty `args`. */
export const RETRIEVAL_FLAGS = {
  mode: {
    type: "string" as const,
    description:
      "How willing this read is to reach LinkedIn: auto (default, a stored copy while it is fresh), " +
      "live (always fetch), refill (a stored copy at any age, fetch only when nothing is stored), " +
      "cache_only (never fetch; a store miss is refused rather than fetched). " +
      "Not combinable with --max-age under cache_only.",
  },
  "max-age": {
    type: "string" as const,
    description:
      `Maximum age in seconds of a stored copy this read will accept (integer, 0-${MAX_AGE_CEILING_SECONDS}). ` +
      "Overrides the auto/live/refill presets in both directions; 0 is the same as --mode live.",
  },
};

/** The flag surface this module reads, as citty hands it over. */
export type RetrievalFlags = {
  mode?: string | undefined;
  "max-age"?: string | undefined;
};

/** The query parameters to hand the SDK, in the server's wire spelling. */
export type RetrievalQuery = { mode?: RetrievalMode; max_age?: number };

/**
 * A decimal, non-negative integer and nothing else.
 *
 * Deliberately stricter than `Number()`, which accepts `" 60"`, `"1e3"`,
 * `"0x10"` and `""` (as 0). Each of those would reach the wire as a number the
 * caller did not type, and `""` as 0 is the worst of them: it silently means
 * `mode=live`, the one value that always spends a platform call.
 */
const NON_NEGATIVE_INTEGER = /^\d+$/;

/** Did the caller name either flag? Presence, not truthiness: `--max-age 0` counts. */
export function hasRetrievalFlags(flags: RetrievalFlags): boolean {
  return flags.mode !== undefined || flags["max-age"] !== undefined;
}

export type RetrievalParse =
  | { ok: true; query: RetrievalQuery }
  | { ok: false; error: string };

/**
 * Validate the two flags and build the query, or return the usage error to
 * print before exiting 2. Result-shaped rather than throwing, matching
 * `parseSectionsFlag`, the CLI's existing convention for a flag validator.
 */
export function parseRetrievalFlags(flags: RetrievalFlags): RetrievalParse {
  const query: RetrievalQuery = {};

  const rawMode = flags.mode;
  if (rawMode !== undefined) {
    if (!(RETRIEVAL_MODES as readonly string[]).includes(rawMode)) {
      return {
        ok: false,
        error:
          `error: --mode must be one of: ${RETRIEVAL_MODES.join(", ")}.` +
          (rawMode === "" ? " Omit the flag to use the default (auto).\n" : ` Received "${rawMode}".\n`),
      };
    }
    query.mode = rawMode as RetrievalMode;
  }

  const rawMaxAge = flags["max-age"];
  if (rawMaxAge !== undefined) {
    // The refusal comes BEFORE the number is parsed: `cache_only` never reaches
    // LinkedIn at any age, so a freshness threshold cannot change its answer,
    // and the API refuses the pair rather than ignoring one of the two.
    // Checked on PRESENCE, so `--max-age 0` — the value a truthiness test
    // misses — is refused with the rest.
    if (query.mode === "cache_only") {
      return {
        ok: false,
        error:
          'error: --mode cache_only cannot be combined with --max-age. cache_only never reaches ' +
          'LinkedIn at any age, so a freshness threshold cannot change its answer. Drop --max-age, ' +
          'or use --mode refill (stored at any age, fetch only when nothing is stored).\n',
      };
    }
    if (!NON_NEGATIVE_INTEGER.test(rawMaxAge)) {
      return {
        ok: false,
        error:
          `error: --max-age must be a whole number of seconds (0-${MAX_AGE_CEILING_SECONDS}).` +
          ` Received "${rawMaxAge}".\n`,
      };
    }
    const seconds = Number(rawMaxAge);
    if (seconds > MAX_AGE_CEILING_SECONDS) {
      return {
        ok: false,
        error:
          `error: --max-age must be at most ${MAX_AGE_CEILING_SECONDS} seconds (one year).` +
          ` Received "${rawMaxAge}".\n`,
      };
    }
    query.max_age = seconds;
  }

  return { ok: true, query };
}
