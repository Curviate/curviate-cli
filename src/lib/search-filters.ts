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
import { readFile } from "node:fs/promises";

/** Reader injection point — file + stdin sources for --filters. */
export type FilterReaders = {
  readFile: (path: string) => Promise<string>;
  readStdin: () => Promise<string>;
};

/** Read all of stdin as a UTF-8 string. Used for `--filters -`. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const DEFAULT_FILTER_READERS: FilterReaders = {
  readFile: (path) => readFile(path, "utf8"),
  readStdin,
};

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

  // --filters-file wins over --filters - when both are given.
  if (flags["filters-file"] !== undefined) {
    source = `--filters-file ${flags["filters-file"]}`;
    try {
      raw = await readers.readFile(flags["filters-file"]);
    } catch {
      return { error: `cannot read ${source}` };
    }
  } else if (isStdinToken(flags.filters)) {
    source = "--filters - (stdin)";
    raw = await readers.readStdin();
  } else if (flags.filters !== undefined) {
    source = "--filters";
    raw = flags.filters;
  }

  if (raw === undefined) return { body: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: `${source} is not valid JSON` };
  }
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

/**
 * Split a comma-separated flag value into a number array, dropping any segment
 * that is not a finite number (e.g. network_distance accepts `1,2,3`).
 */
export function splitCsvNumbers(value: string): number[] {
  return splitCsv(value)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
}
