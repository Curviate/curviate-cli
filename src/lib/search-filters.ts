/**
 * Shared filter-body assembly for the search commands.
 *
 * The LinkedIn search request bodies are large (people: 35+ filters, Sales
 * Navigator people: 40, many of them nested objects). Enumerating an individual
 * flag for every field would be unwieldy and would make the help output and the
 * docs unreadable, so the full filter surface is reachable through a JSON
 * escape hatch:
 *
 *   --filters '<json>'        inline JSON object
 *   --filters-file <path>     JSON object read from a file
 *   --filters -               JSON object read from stdin
 *
 * The parsed object is the base request body. `--keywords`, `--url`, and the
 * curated named convenience flags (per command) merge OVER it, so a caller can
 * mix the two styles. Every documented filter is therefore reachable via
 * --filters even where no named flag exists.
 *
 * The reader functions are injected so the file / stdin paths can be exercised
 * in tests without real process.stdin / fs I/O.
 */

import { isStdinToken } from "./stdin.js";
import { parseDocument, readFileFlag, readStdinCapped } from "./document.js";

/** Reader injection point, the stdin source for --filters / --filters-file. */
export type FilterReaders = {
  readStdin: () => Promise<string>;
};

/** `--filters -`: capped and strictly UTF-8, like every document read. */
export const DEFAULT_FILTER_READERS: FilterReaders = { readStdin: () => readStdinCapped("filters") };

/** The subset of flags that supply the JSON filter source. */
export type FilterSourceFlags = {
  filters?: string;
  "filters-file"?: string;
};

/**
 * Assemble the filter base body from a JSON source (--filters '<json>',
 * --filters-file <path>, or --filters - for stdin).
 *
 * Returns `{ body }` with the parsed object (empty when no source is given), or
 * `{ error }` when the source is present but does not parse to a JSON object.
 * The caller surfaces the error and exits 2 without calling the API.
 */
export async function assembleFilters(
  flags: FilterSourceFlags,
  readers: FilterReaders = DEFAULT_FILTER_READERS,
): Promise<{ body: Record<string, unknown> } | { error: string }> {
  let raw: string | undefined;
  let source: string | undefined;

  // --filters-file <path|-> (a file flag accepts -) wins
  // over --filters when both are given; both reading stdin is refused.
  if (flags["filters-file"] !== undefined) {
    source = "--filters-file";
    raw = await readFileFlag("filters-file", flags["filters-file"], { readStdin: readers === DEFAULT_FILTER_READERS ? undefined : readers.readStdin, others: { filters: flags.filters } });
  } else if (isStdinToken(flags.filters)) {
    source = "--filters - (stdin)";
    raw = await readers.readStdin();
  } else if (flags.filters !== undefined) {
    source = "--filters";
    raw = flags.filters;
  }

  if (raw === undefined) return { body: {} };

  // Unparsable JSON exits 2 naming the line and column, like every --file.
  const parsed = parseDocument(source === "--filters-file" ? "filters-file" : "filters", raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: `${source} must be a JSON object` };
  }
  return { body: parsed as Record<string, unknown> };
}

/** Split a comma-separated flag value into a trimmed, non-empty string array. */
export function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
