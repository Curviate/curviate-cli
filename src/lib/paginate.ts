/**
 * `--all` pagination streaming for the CLI.
 *
 * Wraps the SDK's `curviate.paginate()` pattern with a `--max-pages` guard
 * to prevent infinite loops. On truncation, the command exits 0 (not an
 * error).
 *
 * Only commands that stream declare `--all`; elsewhere it is an unknown flag
 * (exit 2). A response that is not a page exits 7 (`readablePage`).
 *
 * **Truncation output contract.** When `--max-pages` truncates a stream that
 * still has pages remaining, EVERY `--all` command must emit the identical
 * two-channel sentinel:
 *   - stdout (data channel, last NDJSON line): a machine-readable JSON object
 *     `{"object":"stream_truncated","pages_fetched":<n>,"has_more":true}`.
 *   - stderr (diagnostics channel): a human-readable prose note.
 * A command that exhausts naturally (cursor null) writes neither line.
 *
 * This is enforced HERE, not at each call site: pass `out` (the command's
 * stdout/stderr pair) via `StreamAllOptions` and `streamAll` writes both
 * lines itself on truncation. Call sites must not hand-roll either write,
 * that per-call-site duplication is exactly what previously let most `--all`
 * commands drop the stdout sentinel while the search commands independently
 * dropped the stderr note. `onTruncated` remains as an optional additional
 * hook (fires alongside `out`, or standalone if `out` is omitted) for
 * callers/tests that need to observe truncation beyond the standard output
 * contract.
 *
 * **Page-scoped `notices[]`.** A page envelope may carry a top-level
 * `notices` array alongside `items`/`cursor` (e.g. a page whose results are
 * anonymised upstream, or a filter value that could not be verified).
 * `--all` streams items only, so the envelope itself is never written to
 * stdout; without this, that would silently drop the per-page signal on the
 * highest-volume read path. `streamAll` renders any such notices to stderr
 * (diagnostics channel; stdout stays one-NDJSON-object-per-item, unchanged)
 * using the same formatter `lib/output.ts`'s human-mode renderer uses, so
 * there is exactly one notice-rendering implementation for both output
 * modes.
 */

import { CurviateError } from "@curviate/sdk";
import { isPlainObject } from "./config.js";
import { renderNotices, renderProvenanceNote } from "./output.js";

/**
 * A list call's 2xx must be a page: an object with an `items` array (the
 * Recruiter lists, and the SDK's own paginator, carry it as `data`). `null`,
 * `{}`, a non-array `items`, an array, a scalar, or an empty body (which
 * arrives as bytes) is no API answer: a platform fault, exit 7, never a crash
 * on `.items` and never an empty page read as real. Every path that reads a
 * list (`--all` streams, name resolvers, credential checks) goes through here.
 */
export function readablePage<T>(page: T): T & { items: unknown[] } {
  const list = isPlainObject(page) ? (page["items"] === undefined ? page["data"] : page["items"]) : undefined;
  if (!Array.isArray(list)) throw unreadable("list page");
  return { ...(page as T), items: list };
}

/**
 * The id a slug or name lookup resolved to. An answer that is not an object
 * with a non-empty `id` is a platform fault (exit 7), never `undefined` or
 * `null` spliced into the next request's path.
 */
export function readableId(entity: unknown): string {
  const id = isPlainObject(entity) ? entity["id"] : undefined;
  if ((typeof id !== "string" || id === "") && !(typeof id === "number" && Number.isFinite(id))) throw unreadable("id");
  return String(id);
}

/**
 * A single-object read's 2xx must be a readable object: `null`, a scalar
 * (string/number/boolean), `undefined`, or a bare array is no API answer for
 * a single-resource read — a platform fault, exit 7, the same family as
 * `readablePage`/`readableId` (per the exit-code spec's As-built note). An object with an `items`
 * array (a page envelope) still passes: this checks only that there is a
 * concrete object to render, not its internal shape.
 *
 * Threaded per read call site, right before `renderSuccess`, never inside
 * `renderSuccess` itself: it is shared with writes that legitimately render a
 * `null` 204 body, and a write must keep exiting 0 on one.
 */
export function readableObject<T>(data: T): T {
  if (!isPlainObject(data)) throw unreadable("object");
  return data;
}

/**
 * Refuse `--max-pages`/`--page-delay` on a streaming command when `--all` is
 * not also given. Both only mean anything as part of an `--all` page walk;
 * without it they were silently accepted and did nothing, which an agent has
 * no way to detect. Usage error, exit 2, checked before any request (call it
 * before the command resolves an account or an identifier).
 */
export function rejectPaginationModifiersWithoutAll(
  flags: { all?: boolean; "max-pages"?: string; "page-delay"?: string },
  out: StreamWriters,
): void {
  if (flags.all) return;
  const offender = flags["max-pages"] !== undefined ? "--max-pages" : flags["page-delay"] !== undefined ? "--page-delay" : null;
  if (!offender) return;
  out.stderr.write(`error: ${offender} requires --all; without it, streaming never engages so the flag does nothing.\n`);
  process.exit(2);
}

/** The page budget a `--all` walk uses when `--max-pages` is not given. */
export const DEFAULT_MAX_PAGES = 100;

/**
 * Read `--cursor` off a command's parsed flags.
 *
 * An EMPTY or blank `--cursor` is a value, not an omission. Every paginated
 * command used to guard it with `if (flags.cursor)`, so `--cursor "$NEXT"`
 * with `NEXT` unset read as "no cursor given" and silently re-fetched page
 * one — a paging loop that lost its variable then runs forever at exit 0,
 * which is the one failure an agent cannot see. A lost cursor never silently
 * restarts: usage error, exit 2, naming the flag. Same ruling as
 * `account link --seat-id ""`, and the API itself now answers 400 on an
 * empty cursor.
 *
 * Omitted stays "no cursor". Decided HERE, once, so a call site cannot pick
 * its own answer: this is the only place `flags.cursor` is read.
 */
export function readCursorFlag(flags: { cursor?: string }, out: StreamWriters): string | undefined {
  const raw = flags.cursor;
  if (raw === undefined) return undefined;
  if (raw.trim() === "") {
    out.stderr.write(
      "error: --cursor was given an empty value. Pass the cursor from the previous response, " +
        "or omit the flag entirely to start at the first page.\n",
    );
    process.exit(2);
  }
  return raw;
}

/**
 * Read `--max-pages` off a command's parsed flags as a page budget.
 *
 * `parseInt("abc", 10)` is `NaN`, and `pageCount >= NaN` is false forever, so
 * a bare parse turned a request to STOP after n pages into an unbounded walk
 * — the opposite of what was typed. `0` and a negative are no budget either.
 * Positive integer or exit 2, naming the flag; omitted means
 * DEFAULT_MAX_PAGES.
 *
 * Digits-only rather than `Number`: `Number` accepts `" 5 "`, `"5.0"` and
 * `"0x10"`, none of which a caller meant to type as a page count.
 */
export function readMaxPagesFlag(flags: { "max-pages"?: string }, out: StreamWriters): number {
  const raw = flags["max-pages"];
  if (raw === undefined) return DEFAULT_MAX_PAGES;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    out.stderr.write(
      `error: --max-pages must be a positive integer (got ${JSON.stringify(raw)}); it is the number of pages --all may fetch.\n`,
    );
    process.exit(2);
  }
  return Number(raw);
}

function unreadable(what: string): CurviateError {
  return new CurviateError({
    code: "PLATFORM_ERROR",
    message: `The API answered without a readable ${what}.`,
    // The status the client gives every synthesized unreadable-2xx fault.
    httpStatus: 502,
    userFixable: false,
    retryLikelyToSucceed: true,
  });
}

type PageResponse = {
  items?: unknown[];
  cursor?: string | null;
  notices?: unknown;
};

type PaginatableMethod<P extends Record<string, unknown>> = (
  params: P,
) => Promise<PageResponse>;

/**
 * Minimal writable-stream pair, structurally compatible with every
 * command's local `OutputStreams` type (and `lib/output.ts`'s exported one).
 */
export interface StreamWriters {
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
}

/** The canonical --all truncation prose note, shared so no call site re-authors its own wording. */
export function truncationProseNote(pagesFetched: number): string {
  return `Streaming truncated at ${pagesFetched} page(s). Use --all --max-pages or --cursor for manual paging.\n`;
}

/**
 * The once-per-invocation NDJSON-mode notice, written to stderr when `--all`
 * streaming engages. Agents pattern-match the plain-mode `{items,cursor}`
 * envelope and mis-parse the stream (observed twice in practice); this line
 * makes the format switch explicit. Diagnostic only, the data channel
 * (stdout) is unchanged.
 */
export function ndjsonModeNotice(): string {
  return "--all streams NDJSON: one object per line; the {items,cursor} envelope is not used\n";
}

/**
 * The default inter-page delay for `--all` streaming (milliseconds). A modest
 * pause between page fetches keeps a well-behaved agent under the platform rate
 * gate on a long stream. Overridable per-invocation with `--page-delay <ms>`
 * (including 0 to disable).
 */
export const DEFAULT_PAGE_DELAY_MS = 400;

/**
 * Parse the `--page-delay <ms>` flag value into a delay in milliseconds.
 * Returns `undefined` when unset or invalid (caller falls back to
 * DEFAULT_PAGE_DELAY_MS); a valid non-negative integer (including 0) is
 * returned as-is.
 */
export function pageDelayFrom(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return undefined;
  return n;
}

/**
 * Convenience over `pageDelayFrom` for the `--all` call sites: reads the
 * `--page-delay` flag straight off a command's parsed flags. The structural
 * param type means a call site passes its own `*Flags` object without that
 * type needing to declare `page-delay`; the flag is a GLOBAL_FLAGS entry so
 * it is present on the runtime object for every paginated command.
 */
export function pageDelayFromFlags(flags: { "page-delay"?: string }): number | undefined {
  return pageDelayFrom(flags["page-delay"]);
}

/** Real timer sleep, the default injected into `streamAll`. */
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The canonical --all truncation JSON sentinel line, including the trailing newline. */
export function truncationSentinelLine(pagesFetched: number, hasMore: boolean): string {
  return JSON.stringify({ object: "stream_truncated", pages_fetched: pagesFetched, has_more: hasMore }) + "\n";
}

export interface StreamAllOptions {
  /** Maximum pages to fetch. Default 100. */
  maxPages?: number;
  /**
   * The command's output streams. When provided, `streamAll` writes the
   * truncation contract itself on truncation: the JSON sentinel to
   * `out.stdout` followed by the prose note to `out.stderr`. This is the
   * single source of truth: do not also write these at the call site.
   */
  out?: StreamWriters;
  /**
   * Optional hook invoked on truncation with (pagesFetched, hasMore), in
   * addition to (or, if `out` is omitted, instead of) the standard output
   * contract above. Escape hatch for callers/tests that need to observe
   * truncation directly.
   */
  onTruncated?: (pagesFetched: number, hasMore: boolean) => void;
  /**
   * Inter-page delay in milliseconds. Defaults to DEFAULT_PAGE_DELAY_MS. Set 0
   * to disable. Applied only BETWEEN page fetches, never before the first
   * page nor after the last (or a truncated) page.
   */
  pageDelayMs?: number;
  /**
   * Injectable sleep (defaults to a real timer). Tests pass a fake to assert
   * the pacing calls without incurring real delays.
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Stream all items from a paginated SDK method as an async iterable.
 *
 * Fetches pages, injecting the cursor from each response into the next call.
 * Yields individual items. Stops when cursor is null or maxPages is reached.
 *
 * @throws {CurviateError} `PLATFORM_ERROR` (exit 7) when a response is not a page.
 */
export async function* streamAll<P extends Record<string, unknown>>(
  fn: PaginatableMethod<P>,
  params: P,
  opts: StreamAllOptions = {},
): AsyncGenerator<unknown> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const pageDelayMs = opts.pageDelayMs ?? DEFAULT_PAGE_DELAY_MS;
  const sleep = opts.sleep ?? realSleep;
  let cursor: string | undefined | null = undefined;
  let pageCount = 0;
  let firstPage = true;

  while (true) {
    const pageParams: P =
      cursor !== undefined && cursor !== null
        ? ({ ...params, cursor } as P)
        : params;

    const page = readablePage(await fn(pageParams));
    pageCount++;

    const items = page.items;
    if (firstPage) {
      // Streaming has engaged and the shape is valid, announce the NDJSON
      // format switch once, before any item is emitted.
      if (opts.out) opts.out.stderr.write(ndjsonModeNotice());
      firstPage = false;
    }

    // Surface this page's notices[] before its items, on the diagnostics
    // channel; stdout stays pure NDJSON data. A page with no notices writes
    // nothing (renderNotices returns null), so a stream with no notices
    // anywhere is byte-identical to today's stderr output.
    if (opts.out) {
      const pageNotices = renderNotices(page.notices);
      if (pageNotices) opts.out.stderr.write(pageNotices + "\n");
      // A page's warn-posture safety_warning: raw NDJSON items cannot carry it.
      const pageWarning = (page as { safety_warning?: unknown }).safety_warning;
      if (typeof pageWarning === "object" && pageWarning !== null && !Array.isArray(pageWarning)) {
        opts.out.stderr.write(`safety_warning: ${JSON.stringify(pageWarning)}\n`);
      }
      // Same argument, same channel: the retrieval envelope sits on the PAGE,
      // beside `items`, so raw NDJSON items carry no trace of whether the page
      // was served from the stored copy or fetched. `renderSuccess` puts that
      // on stderr for a single read; a stream has to do it per page or the
      // highest-volume read path is the one that cannot answer the question.
      const pageProvenance = renderProvenanceNote(page);
      if (pageProvenance) opts.out.stderr.write(pageProvenance);
    }

    if (Array.isArray(items)) {
      for (const item of items) {
        yield item;
      }
    }

    // Advance cursor.
    cursor = page.cursor;

    // Stop conditions.
    if (!cursor) break;

    if (pageCount >= maxPages) {
      const hasMore = cursor !== null && cursor !== undefined;
      if (opts.out) {
        opts.out.stdout.write(truncationSentinelLine(pageCount, hasMore));
        opts.out.stderr.write(truncationProseNote(pageCount));
      }
      if (opts.onTruncated) {
        opts.onTruncated(pageCount, hasMore);
      }
      break;
    }

    // Pace the NEXT fetch: a modest pause between pages keeps a long stream
    // under the platform rate gate. Only reached when another page will be
    // fetched (cursor present, not truncating), never after the last page.
    if (pageDelayMs > 0) await sleep(pageDelayMs);
  }
}
