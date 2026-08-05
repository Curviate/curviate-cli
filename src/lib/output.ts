/**
 * Output, projection, and error rendering for the CLI.
 *
 * Stream discipline:
 *   stdout = data only (success results, --preview render, JSON error envelope)
 *   stderr = diagnostics, progress, human chrome, one-line error summaries
 *
 * JSON mode is active when `--json` is passed OR stdout is not a TTY
 * (agent-first: default JSON on pipe).
 *
 * `--fields` projection: dot-path projection over response objects. For
 * arrays, projection is applied per-item. Missing paths are omitted (not null).
 *
 * Error output:
 *   JSON mode: `{ "error": <CurviateError.toJSON()> }` to stdout; one-liner to stderr.
 *   Human mode: readable error to stderr; stdout stays empty.
 */

import type { CurviateError, CurviateErrorJSON } from "@curviate/sdk";

export interface OutputOptions {
  json: boolean;
  isTTY: boolean;
  fields?: string;
  /** When true, bypass slim projection and return the raw SDK response. */
  verbose?: boolean;
  /** Command-specific slim projector. Applied before --fields unless --verbose. */
  slim?: (data: unknown) => unknown;
}

export interface OutputStreams {
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
}

/** Determine whether the current invocation should use JSON mode. */
export function isJsonMode(opts: { json: boolean; isTTY: boolean }): boolean {
  return opts.json || !opts.isTTY;
}

/**
 * Apply dot-path field projection to a single object.
 * Missing paths are omitted (not set to null).
 */
export function projectFields(
  obj: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  if (fields.length === 0) return obj;

  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const parts = field.split(".");
    let value: unknown = obj;
    for (const part of parts) {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        value = (value as Record<string, unknown>)[part];
      } else {
        value = undefined;
        break;
      }
    }
    if (value !== undefined) {
      // For dot-path fields, use the full path as the key in output
      result[field] = value;
    }
  }
  return result;
}

/** Apply projection to a value (handles arrays with per-item projection). */
function applyProjection(
  data: unknown,
  fields: string[],
): unknown {
  if (fields.length === 0) return data;

  if (Array.isArray(data)) {
    return data.map((item) =>
      typeof item === "object" && item !== null
        ? projectFields(item as Record<string, unknown>, fields)
        : item,
    );
  }

  // For objects with an `items` array, project each item
  if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj["items"])) {
      return {
        ...obj,
        items: (obj["items"] as unknown[]).map((item) =>
          typeof item === "object" && item !== null
            ? projectFields(item as Record<string, unknown>, fields)
            : item,
        ),
      };
    }
    // Single object: project it directly
    return projectFields(obj, fields);
  }

  return data;
}

/**
 * The single object a `--fields` projection is applied against (for key
 * discovery), or null when there is no concrete object to inspect (empty list,
 * primitive, or an empty array). Mirrors `applyProjection`'s target selection:
 * a bare array → its first element; an `{ items: [...] }` envelope → the first
 * item; a single object → itself.
 */
function firstProjectableItem(data: unknown): Record<string, unknown> | null {
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

  if (Array.isArray(data)) {
    return data.length > 0 && isPlainObject(data[0]) ? data[0] : null;
  }
  if (isPlainObject(data)) {
    const items = data["items"];
    if (Array.isArray(items)) {
      return items.length > 0 && isPlainObject(items[0]) ? items[0] : null;
    }
    return data;
  }
  return null;
}

/**
 * Which requested `--fields` match nothing on the response, plus the keys that
 * ARE available. A field is "unknown" when its top-level path segment is absent
 * from the first projectable item. Returns null when there is nothing to check
 * (no concrete item) or every field matches — i.e. no warning is warranted.
 */
export function detectUnknownFields(
  data: unknown,
  fields: string[],
): { unknown: string[]; available: string[] } | null {
  if (fields.length === 0) return null;
  const first = firstProjectableItem(data);
  if (first === null) return null;
  const available = Object.keys(first);
  const unknown = fields.filter((f) => {
    const topKey = f.split(".")[0]!;
    return !Object.prototype.hasOwnProperty.call(first, topKey);
  });
  return unknown.length > 0 ? { unknown, available } : null;
}

/**
 * Render a successful command response to the output streams.
 *
 * JSON mode: prints `JSON.stringify(data)` (verbatim SDK response) to stdout.
 * Human mode: renders a readable form to stdout (tables/key-value).
 *
 * Slim projection (when `opts.slim` is provided and `opts.verbose` is falsy):
 *   applied first, then `--fields` projection is applied on top. This keeps
 *   the default output compact while still allowing callers to select a subset
 *   of the slim fields via `--fields`.
 *
 * When `opts.verbose` is true, slim is bypassed and the raw SDK response is used.
 * Existing calls without `slim` or `verbose` are backward-compatible.
 */
export function renderSuccess(
  data: unknown,
  opts: OutputOptions,
  out: OutputStreams,
): void {
  const json = isJsonMode(opts);
  const fields = opts.fields
    ? opts.fields.split(",").map((f) => f.trim()).filter(Boolean)
    : [];

  // Apply slim projection first (before --fields), unless --verbose
  const slimmed = (!opts.verbose && opts.slim) ? opts.slim(data) : data;

  // Warn (diagnostics channel) when a requested field matches nothing on the
  // response the projection actually runs over (the slim output, if any).
  // Output is unaffected — the known fields still project; this only saves an
  // agent from silently receiving {} and guessing why.
  const unknownFields = detectUnknownFields(slimmed, fields);
  if (unknownFields) {
    out.stderr.write(
      `warning: --fields not present on the response: ${unknownFields.unknown.join(", ")}. ` +
        `Available keys: ${unknownFields.available.join(", ")}.\n`,
    );
  }

  const projected = applyProjection(slimmed, fields);

  if (json) {
    out.stdout.write(JSON.stringify(projected) + "\n");
  } else {
    // Human-readable output: best-effort, not a stability contract.
    out.stdout.write(renderHuman(projected) + "\n");
  }
}

/**
 * Format one response notice (`{code, message, field?, value?}`, api/008 §F/§G)
 * as a single readable line. Defensive against a malformed entry (missing
 * `code`/`message`) so a bad server payload degrades to a plain line rather
 * than throwing or printing "undefined".
 *
 * `field`/`value` are optional detail: §F's filter notices carry both, §G's
 * page-scoped notices (e.g. an anonymised-results page) carry neither. Both
 * shapes render as one clean line either way.
 */
function formatNotice(notice: unknown): string | null {
  if (typeof notice !== "object" || notice === null) return null;
  const n = notice as Record<string, unknown>;
  const code = typeof n["code"] === "string" ? n["code"] : "NOTICE";
  const message = typeof n["message"] === "string" ? n["message"] : "";
  let line = `notice [${code}]${message ? ` ${message}` : ""}`;

  const details: string[] = [];
  if (typeof n["field"] === "string") details.push(`field: ${n["field"]}`);
  if (typeof n["value"] === "string") details.push(`value: ${n["value"]}`);
  if (details.length > 0) line += ` (${details.join(", ")})`;

  return line;
}

/**
 * Render a response's top-level `notices[]` (api/008 §F/§G) as readable lines,
 * or null when there is nothing to show. `null` (not `""`) lets callers skip
 * appending a blank line entirely, which is what keeps a notice-free response
 * byte-identical to its pre-notices rendering.
 *
 * Exported (not just used internally by `renderHuman`) so `lib/paginate.ts`'s
 * `--all` NDJSON stream can surface the identical per-page notices to stderr
 * without a second formatting implementation — one mechanism, two output
 * modes.
 */
export function renderNotices(notices: unknown): string | null {
  if (!Array.isArray(notices) || notices.length === 0) return null;
  const lines = notices
    .map(formatNotice)
    .filter((line): line is string => line !== null);
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Render a human-readable representation of data (best-effort).
 *
 * `notices[]` (api/008 §F/§G) is surfaced first, above the results it
 * qualifies, so a degraded or partly-unactionable page is never mistaken for
 * a clean one. A response with no `notices` key renders byte-identically to
 * how it rendered before this array existed (F-AC-004 / the "absent when
 * empty" contract).
 */
function renderHuman(data: unknown): string {
  if (data === null || data === undefined) return "(empty)";

  if (typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    const notices = renderNotices(obj["notices"]);

    // List response with items
    if (Array.isArray(obj["items"])) {
      const items = obj["items"] as unknown[];
      const body = items.length === 0 ? "(no items)" : items.map(renderHuman).join("\n");
      return notices ? `${notices}\n${body}` : body;
    }

    // Single object: key=value pairs (notices is rendered above, not as a raw key)
    const kv = Object.entries(obj)
      .filter(([k]) => k !== "notices")
      .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
      .join("\n");
    if (!notices) return kv;
    return kv ? `${notices}\n${kv}` : notices;
  }

  if (Array.isArray(data)) {
    return data.map(renderHuman).join("\n");
  }

  return String(data);
}

export interface ErrorOutputOptions {
  json: boolean;
  isTTY: boolean;
}

/**
 * Render a CurviateError to the output streams.
 *
 * JSON mode: `{ "error": <error.toJSON()> }` to stdout; one-liner to stderr.
 * Human mode: readable error to stderr; stdout stays empty.
 *
 * The API key is never included (the SDK's toJSON() is credential-safe).
 */
export function renderError(
  err: CurviateError,
  opts: ErrorOutputOptions,
  out: OutputStreams,
): void {
  const json = isJsonMode(opts);
  const errJson: CurviateErrorJSON = err.toJSON();

  if (json) {
    // Structured error envelope to stdout (agent-first: agents read stdout).
    out.stdout.write(JSON.stringify({ error: errJson }) + "\n");
    // Brief one-liner to stderr for human monitoring.
    out.stderr.write(
      `error [${errJson.code}] ${errJson.message}\n`,
    );
  } else {
    // Human mode: stderr only; stdout stays empty.
    let msg = `Error: [${errJson.code}] ${errJson.message}`;
    if (errJson.requiredTier) {
      msg += `\nRequired tier: ${errJson.requiredTier}`;
    }
    if (errJson.retryAfterMs) {
      msg += `\nRetry after: ${errJson.retryAfterMs}ms`;
    }
    if (errJson.retryHint && errJson.retryHint.kind !== "never") {
      msg += `\nHint: ${errJson.retryHint.kind}`;
    }
    out.stderr.write(msg + "\n");
  }
}

/**
 * Render a non-CurviateError (unexpected/internal) to stderr.
 */
export function renderUnexpectedError(
  err: unknown,
  out: OutputStreams,
): void {
  const message =
    err instanceof Error ? err.message : "An unexpected error occurred.";
  out.stderr.write(`Internal error: ${message}\n`);
}
