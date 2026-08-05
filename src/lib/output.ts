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
/** A non-null, non-array object: the only shape a slim/verbose merge is valid on. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function firstProjectableItem(data: unknown): Record<string, unknown> | null {
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

  // Apply slim projection first (before --fields).
  //
  // --verbose is a SUPERSET of the default, not a different view. It used to
  // swap the slim projection out for the raw response wholesale, which meant
  // asking for more data returned LESS in places: the slim-only fields are
  // renamed or synthesized (headline <- description, network_distance <-
  // specifics.network_distance, provider_id <- id, current_position built from
  // specifics.experience[0]), so none of them exist on the raw wire under those
  // names and all of them vanished under --verbose. A flag named verbose that
  // drops fields is a trap, so verbose now returns the raw response WITH the
  // derived fields merged in. Raw keys win on any name collision, so --verbose
  // never misrepresents a wire value.
  let slimmed: unknown = data;
  if (opts.slim) {
    const projection = opts.slim(data);
    if (!opts.verbose) {
      slimmed = projection;
    } else if (isPlainObject(projection) && isPlainObject(data)) {
      // Raw spread LAST so a wire value always wins over a derived one.
      slimmed = { ...projection, ...data };
    }
    // A non-object response under --verbose falls through as the raw data.
  }

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

/** Render a human-readable representation of data (best-effort). */
function renderHuman(data: unknown): string {
  if (data === null || data === undefined) return "(empty)";

  if (typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;

    // List response with items
    if (Array.isArray(obj["items"])) {
      const items = obj["items"] as unknown[];
      if (items.length === 0) return "(no items)";
      return items.map(renderHuman).join("\n");
    }

    // Single object: key=value pairs
    return Object.entries(obj)
      .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
      .join("\n");
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
