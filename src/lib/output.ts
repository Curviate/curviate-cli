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

  // `field` is a value from the user-typed `--fields` flag. `result` must
  // have no prototype: a genuine response field named `__proto__` (JSON.parse
  // creates it as a real own property) would otherwise hit the inherited
  // accessor on write instead of creating an own key, silently dropping the
  // projected value and reassigning result's own prototype.
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const parts = field.split(".");
    let value: unknown = obj;
    for (const part of parts) {
      // Same user-typed-key hazard on read: an Object.prototype member name
      // (constructor, toString, ...) as `part` must never resolve to the
      // inherited member as if it were a real field.
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.prototype.hasOwnProperty.call(value, part)
      ) {
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

/** A plain object: the only shape either preservation pass can reattach onto. */
const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Carry a response's top-level `notices[]` across projection.
 *
 * A notice is not a data field. It is the reason the data looks the way it
 * does, so it must reach the caller whatever projection was asked for, and a
 * projection that removed it would restore exactly the unexplained empty
 * result the notices channel exists to abolish.
 *
 * It has to be reattached rather than merely left alone, because two layers
 * upstream of the renderer drop it. Eight of the shipped slim projectors
 * rebuild their envelope from a fixed allowlist instead of spreading it, and
 * `--fields` on a single object is a strict allowlist by definition. Doing it
 * here, at the one point every command's output passes through, means a
 * projector cannot forget and a new one inherits the guarantee for free; the
 * alternative was the same rule hand-written in a dozen places, which is what
 * produced the ones that were wrong.
 *
 * Absent, empty, or malformed `notices` reattaches nothing, so a response
 * without one renders byte-identically to how it always has.
 */
function withPreservedNotices(original: unknown, rendered: unknown): unknown {
  if (!isPlain(original) || !isPlain(rendered)) return rendered;
  let out = rendered;
  const notices = original["notices"];
  if (Array.isArray(notices) && notices.length > 0 && rendered["notices"] !== notices) {
    out = { ...out, notices };
  }
  return withPreservedProvenance(original, out);
}

/**
 * The keys of the retrieval envelope, in the order a reader wants them.
 *
 * `withdrawn` is in the list even though it is a plain boolean: the API
 * always sends it, and it must never be inferred from a field's absence, so
 * a projection that dropped it would turn "this resource is still live" into
 * "this API does not say", which are different facts.
 */
const PROVENANCE_KEYS = ["source", "observed_at", "withdrawn", "withdrawn_at"] as const;

/**
 * Carry the retrieval envelope across projection, for the same reason
 * `notices` is carried: it is not a data field, it is the provenance OF the
 * data, and it is dropped by both projection layers (the slim projectors
 * rebuild from a fixed allowlist; `--fields` is a strict allowlist).
 *
 * Reattached here, at the one point every command's output passes through, so
 * a projector cannot forget and a new one inherits it for free. A response
 * without `source` reattaches nothing and renders exactly as it always has.
 */
function withPreservedProvenance(original: unknown, rendered: unknown): unknown {
  if (!isPlain(original) || !isPlain(rendered)) return rendered;
  // `source` is the anchor: the envelope is present as a unit or not at all,
  // and keying off it stops a response that merely happens to carry an
  // `observed_at` from acquiring a half-envelope.
  if (!isRetrievalSource(original["source"])) return rendered;
  const carried: Record<string, unknown> = { ...rendered };
  for (const key of PROVENANCE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(original, key)) carried[key] = original[key];
  }
  return carried;
}

/** `source` is a two-value enum; anything else is not an envelope. */
function isRetrievalSource(v: unknown): v is "store" | "live" {
  return v === "store" || v === "live";
}

/**
 * The one-line provenance note for human mode, or null when the response
 * carries no envelope.
 *
 * Human mode only. In `--json` the same facts are on the payload, where a
 * caller parses them; repeating them on stderr there would be noise on the
 * channel scripts read for real diagnostics.
 *
 * `withdrawn` is mentioned only when true. A timestamp for a thing that never
 * happened has no value to report, and a note that says "withdrawn=false" on
 * every read trains the reader to stop reading it.
 */
export function renderProvenanceNote(data: unknown): string | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const source = d["source"];
  if (!isRetrievalSource(source)) return null;

  let line = `provenance: source=${source}`;
  const observedAt = d["observed_at"];
  if (typeof observedAt === "string" && observedAt !== "") line += ` observed_at=${observedAt}`;
  if (d["withdrawn"] === true) {
    const withdrawnAt = d["withdrawn_at"];
    line +=
      typeof withdrawnAt === "string" && withdrawnAt !== ""
        ? ` withdrawn=true withdrawn_at=${withdrawnAt}`
        : " withdrawn=true";
  }
  // `store` is the case a caller acts on: a stored copy can be missing content
  // a live read would carry, because message bodies and contact fields are
  // stripped before anything is stored, so it names the way out.
  if (source === "store") line += " (re-read with --mode live to fetch)";
  return line + "\n";
}

/**
 * The single object a `--fields` projection is applied against (for key
 * discovery), or null when there is no concrete object to inspect (empty list,
 * primitive, or an empty array). Mirrors `applyProjection`'s target selection:
 * a bare array -> its first element; an `{ items: [...] }` envelope -> the first
 * item; a single object -> itself.
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
 * (no concrete item) or every field matches, i.e. no warning is warranted.
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
  // Output is unaffected, the known fields still project; this only saves an
  // agent from silently receiving {} and guessing why.
  const unknownFields = detectUnknownFields(slimmed, fields);
  if (unknownFields) {
    out.stderr.write(
      `warning: --fields not present on the response: ${unknownFields.unknown.join(", ")}. ` +
        `Available keys: ${unknownFields.available.join(", ")}.\n`,
    );
  }

  const projected = withPreservedNotices(data, applyProjection(slimmed, fields));

  if (json) {
    out.stdout.write(JSON.stringify(projected) + "\n");
  } else {
    // The retrieval envelope goes to the DIAGNOSTICS channel in human mode, so
    // a caller can tell a served copy from a fetch without the two keys
    // cluttering the rendered body. In --json it rides the payload instead.
    const provenance = renderProvenanceNote(data);
    if (provenance) out.stderr.write(provenance);
    // Human-readable output: best-effort, not a stability contract.
    out.stdout.write(renderHuman(projected) + "\n");
  }
}

/**
 * Format one response notice (`{code, message, field?, value?}`) as a single
 * readable line. Defensive against a malformed entry (missing `code`/
 * `message`) so a bad server payload degrades to a plain line rather than
 * throwing or printing "undefined".
 *
 * `field`/`value` are optional detail: some notices are about a specific
 * request field (an unresolved filter value), others are page-scoped and
 * name none (e.g. a page whose results are anonymised upstream). Both shapes
 * render as one clean line either way.
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
 * Render a response's top-level `notices[]` as readable lines, or null when
 * there is nothing to show. `null` (not `""`) lets callers skip appending a
 * blank line entirely, which is what keeps a notice-free response
 * byte-identical to its pre-notices rendering.
 *
 * Exported (not just used internally by `renderHuman`) so `lib/paginate.ts`'s
 * `--all` NDJSON stream can surface the identical per-page notices to stderr
 * without a second formatting implementation: one mechanism, two output
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
 * The response envelope's top-level `notices[]` array, when present, is
 * surfaced first, above the results it qualifies, so a degraded or
 * partly-unactionable page is never mistaken for a clean one. A response
 * with no `notices` key renders byte-identically to how it rendered before
 * this array existed: absent means nothing to report, never an empty array.
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
    // Two different 429s name an account-safety budget row, and the right
    // action differs, so the human line has to say WHICH.
    //
    const safety = errJson;
    if (safety.budgetRow) {
      // The wire code is the authority on which of the two conditions this is;
      // the payload alone cannot say.
      if (errJson.code === "BUDGET_EXHAUSTED") {
        // Curviate's own ceiling. Nothing reached LinkedIn, nothing was spent,
        // and backing off is the wrong move: name the instant it frees and the
        // parameter that lifts it now.
        const why =
          safety.safetyReason === "activity_window"
            ? "outside its activity window"
            : "at its ceiling";
        msg += `\nSafety budget: ${safety.budgetRow} is ${why}`;
        // `resetAt` is null-bearing, and null has TWO causes, not one: the
        // invitation backlog and an InMail credit exhaustion. Saying "the
        // backlog clears" on a spent credit pool sends the operator to look at
        // invitations, which is the wrong place entirely. Both are "no clock
        // frees this", which is the sentence they share and the one that is
        // never wrong.
        if (safety.resetAt === null) {
          const frees =
            safety.budgetRow === "inmail"
              ? "when LinkedIn regrants credits"
              : safety.budgetRow === "pending_invites"
                ? "when the backlog clears"
                : "on its own";
          msg += `\nNo reset instant: this frees ${frees}, not on a schedule`;
        } else if (safety.resetAt) {
          msg += `\nResets at: ${safety.resetAt}`;
        }
        if (safety.safetyHint?.parameter) {
          msg += `\nChange: ${safety.safetyHint.parameter}`;
        }
        if (safety.safetyHint?.message) {
          msg += `\n${safety.safetyHint.message}`;
        }
      } else {
        // A row LinkedIn paused. Every other row on the account still works, so
        // the recovery is to switch work rather than back off across the board.
        // Truthiness, not an undefined check: a zero-second pause is not one.
        const wait = safety.retryAfterSeconds ? ` for ${safety.retryAfterSeconds}s` : "";
        msg += `\nPaused budget row: ${safety.budgetRow}${wait} (other rows on this account still work)`;
      }
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
