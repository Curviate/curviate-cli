/**
 * `--sections` value normalization for `profile me` / `profile <id>`.
 *
 * The server's `linkedin_sections` query vocabulary is prefixed,
 * `linkedin_skills`, `linkedin_experience`, ..., plus a `linkedin_*`
 * wildcard and each base value's `_preview` variant (per the served
 * OpenAPI snapshot's `linkedin_sections` parameter description). The
 * pre-D9 CLI forwarded a bare, unprefixed value verbatim (its own --help
 * example, `experience,education`, was one of the values that 400s).
 *
 * `parseSectionsFlag` auto-prefixes a bare value client-side (`skills` ->
 * `linkedin_skills`) and validates the resulting value against the served
 * vocabulary. An unknown section, a genuine typo, or a base name that was
 * never in the vocabulary, fails fast as a usage error naming the bad
 * value, instead of being forwarded to the API where it 400s with a
 * generic, unhelpful message.
 */

const SECTION_BASE_NAMES = [
  "experience",
  "education",
  "languages",
  "skills",
  "certifications",
  "volunteer_experience",
  "projects",
  "recommendations",
  "interests",
] as const;

/**
 * The full served vocabulary: the `linkedin_*` wildcard, every
 * `linkedin_<base>` value, and every value's `linkedin_<base>_preview`
 * variant.
 */
export const VALID_LINKEDIN_SECTIONS: ReadonlySet<string> = new Set<string>([
  "linkedin_*",
  ...SECTION_BASE_NAMES.flatMap((n) => [`linkedin_${n}`, `linkedin_${n}_preview`]),
]);

/** Canonical, human-readable values for `--help` text and error hints. */
export const CANONICAL_SECTION_VALUES: readonly string[] = [
  "linkedin_*",
  ...SECTION_BASE_NAMES.map((n) => `linkedin_${n}`),
];

export type SectionsParseResult = { ok: true; sections: string[] } | { ok: false; error: string };

/**
 * Parse a raw `--sections` flag value into the server's canonical
 * `linkedin_`-prefixed vocabulary.
 *
 * Splits on comma, trims each entry, drops empty entries (trailing/double
 * commas), and auto-prefixes any value that doesn't already start with
 * `linkedin_`. Every resulting value is validated against
 * `VALID_LINKEDIN_SECTIONS`; the first unknown value fails the whole call
 * (all-or-nothing) with an actionable `error` string naming the bad value
 * and pointing at `--sections`.
 *
 * Does not handle the empty-string case (`--sections ""`), that remains
 * the caller's separate, pre-existing usage-error check, since an empty
 * string never reaches this function's split/filter logic meaningfully.
 */
export function parseSectionsFlag(raw: string): SectionsParseResult {
  const values = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const sections: string[] = [];
  for (const value of values) {
    const canonical = value.startsWith("linkedin_") ? value : `linkedin_${value}`;
    if (!VALID_LINKEDIN_SECTIONS.has(canonical)) {
      return {
        ok: false,
        error:
          `error: --sections: unknown section "${value}". Valid values: ` +
          `${CANONICAL_SECTION_VALUES.join(", ")} (each also has a _preview variant).\n`,
      };
    }
    sections.push(canonical);
  }

  return { ok: true, sections };
}
