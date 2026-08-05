import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import {
  streamAll,
  PaginateError,
  ndjsonModeNotice,
  pageDelayFrom,
  DEFAULT_PAGE_DELAY_MS,
} from "../../src/lib/paginate.js";

function makeOut() {
  return { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
}

// A no-op sleep so pagination-logic tests never incur a real inter-page delay.
const noSleep = async (): Promise<void> => {};

// A minimal paginatable method stub factory.
function makePaginatedMethod(pages: Array<{ items: string[]; cursor: string | null }>) {
  let callIndex = 0;
  return vi.fn(async () => {
    const page = pages[callIndex++];
    if (!page) throw new Error("no more pages");
    return page;
  });
}

describe("lib/paginate — streamAll", () => {
  it("yields all items across pages", async () => {
    const method = makePaginatedMethod([
      { items: ["a", "b"], cursor: "next" },
      { items: ["c"], cursor: null },
    ]);
    const collected: string[] = [];
    for await (const item of streamAll(method as never, {}, { maxPages: 100, sleep: noSleep })) {
      collected.push(item as string);
    }
    expect(collected).toEqual(["a", "b", "c"]);
    expect(method).toHaveBeenCalledTimes(2);
  });

  it("stops after maxPages and calls onTruncated with (pagesFetched, hasMore)", async () => {
    const method = makePaginatedMethod([
      { items: ["a"], cursor: "next" },
      { items: ["b"], cursor: "next2" },
      { items: ["c"], cursor: null },
    ]);

    const truncations: Array<{ pagesFetched: number; hasMore: boolean }> = [];
    const collected: string[] = [];
    for await (const item of streamAll(
      method as never,
      {},
      { maxPages: 2, sleep: noSleep, onTruncated: (pagesFetched: number, hasMore: boolean) => truncations.push({ pagesFetched, hasMore }) },
    )) {
      collected.push(item as string);
    }
    expect(collected).toEqual(["a", "b"]);
    expect(truncations).toHaveLength(1);
    expect(truncations[0]!.pagesFetched).toBe(2);
    expect(truncations[0]!.hasMore).toBe(true);
  });

  it("exits 0 after truncation (no error thrown)", async () => {
    const method = makePaginatedMethod([
      { items: ["a"], cursor: "next" },
      { items: ["b"], cursor: "more" },
    ]);

    // Should NOT throw — just stop
    const collected: string[] = [];
    await expect(
      (async () => {
        for await (const item of streamAll(method as never, {}, { maxPages: 1 })) {
          collected.push(item as string);
        }
      })(),
    ).resolves.not.toThrow();
    expect(collected).toEqual(["a"]);
  });

  it("passes initial params to first page", async () => {
    const method = vi.fn(async (params: Record<string, unknown>) => ({
      items: [],
      cursor: null,
      _params: params,
    }));
    // Consume the async iterable.
    for await (const item of streamAll(method as never, { limit: 10, filter: "test" }, { maxPages: 10 })) {
      void item; // consumed
    }
    expect(method).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10, filter: "test" }),
    );
  });

  it("injects cursor from previous page into next call", async () => {
    const calls: Record<string, unknown>[] = [];
    const method = vi.fn(async (params: Record<string, unknown>) => {
      calls.push(params);
      if (params["cursor"] === undefined) {
        return { items: ["a"], cursor: "page2cursor" };
      }
      return { items: ["b"], cursor: null };
    });

    const items: unknown[] = [];
    for await (const item of streamAll(method as never, {}, { maxPages: 10, sleep: noSleep })) {
      items.push(item);
    }
    expect(items).toEqual(["a", "b"]);
    expect(calls[1]).toMatchObject({ cursor: "page2cursor" });
  });

  it("handles response with data[] array instead of items[]", async () => {
    const method = vi.fn(async () => ({
      data: ["x", "y"],
      cursor: null,
    }));
    const items: unknown[] = [];
    for await (const item of streamAll(method as never, {}, { maxPages: 10 })) {
      items.push(item);
    }
    expect(items).toEqual(["x", "y"]);
  });

  it("throws PaginateError (exitCode 2) when used on a non-paginated response", async () => {
    // A method that returns a response with neither items nor data
    const method = vi.fn(async () => ({ id: "not-a-list" }));
    await expect(
      (async () => {
        for await (const item of streamAll(method as never, {}, { maxPages: 10 })) {
          void item; // should throw before yielding
        }
      })(),
    ).rejects.toBeInstanceOf(PaginateError);
  });

  // ---------------------------------------------------------------------------
  // The `out` option is the single source of truth for the --all truncation
  // contract: BOTH the machine-readable JSON sentinel on stdout AND the
  // human-readable prose note on stderr, on every
  // command, with no per-call-site divergence.
  // ---------------------------------------------------------------------------

  it("with `out`: truncation writes the stream_truncated JSON sentinel to stdout AND a prose note to stderr", async () => {
    const method = makePaginatedMethod([
      { items: ["a"], cursor: "next" },
      { items: ["b"], cursor: "next2" },
      { items: ["c"], cursor: null },
    ]);
    const out = makeOut();

    const collected: string[] = [];
    for await (const item of streamAll(method as never, {}, { maxPages: 2, out, sleep: noSleep })) {
      collected.push(item as string);
    }
    expect(collected).toEqual(["a", "b"]);

    // Exactly one stdout write for the sentinel; it is the last thing written
    // and it is a bare, valid JSON line — never mixed into the item stream.
    const stdoutLines = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string);
    expect(stdoutLines).toHaveLength(1);
    const sentinel = JSON.parse(stdoutLines[0]!.trim()) as Record<string, unknown>;
    expect(sentinel).toEqual({ object: "stream_truncated", pages_fetched: 2, has_more: true });
    expect(Object.keys(sentinel).sort()).toEqual(["has_more", "object", "pages_fetched"]);
    expect(typeof sentinel["object"]).toBe("string");
    expect(Number.isInteger(sentinel["pages_fetched"])).toBe(true);
    expect(typeof sentinel["has_more"]).toBe("boolean");

    // Complementary, not exclusive: stderr also gets a human-readable note.
    const stderrText = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    expect(stderrText).toMatch(/truncat/i);
  });

  it("with `out`: natural exhaustion (cursor null) writes no stdout sentinel and no TRUNCATION note (the NDJSON-mode notice is separate)", async () => {
    const method = makePaginatedMethod([
      { items: ["a"], cursor: "next" },
      { items: ["b"], cursor: null },
    ]);
    const out = makeOut();

    const collected: string[] = [];
    for await (const item of streamAll(method as never, {}, { maxPages: 100, out, sleep: noSleep })) {
      collected.push(item as string);
    }
    expect(collected).toEqual(["a", "b"]);
    // No stdout sentinel (the item stream itself is written by the call site, not here).
    expect(out.stdout.write).not.toHaveBeenCalled();
    // stderr carries the once-per-invocation NDJSON-mode notice, but NOT a truncation note.
    const stderrText = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    expect(stderrText).toContain(ndjsonModeNotice().trim());
    expect(stderrText).not.toMatch(/truncat/i);
  });

  it("with `out`: pages_fetched in the sentinel reflects the actual truncation point (3-page stub, maxPages 2)", async () => {
    const method = makePaginatedMethod([
      { items: ["a"], cursor: "next" },
      { items: ["b"], cursor: "next2" },
      { items: ["c"], cursor: null },
    ]);
    const out = makeOut();

    for await (const item of streamAll(method as never, {}, { maxPages: 2, out, sleep: noSleep })) {
      void item;
    }
    const sentinel = JSON.parse(
      (out.stdout.write as Mock).mock.calls[0]![0] as string,
    ) as Record<string, unknown>;
    expect(sentinel["pages_fetched"]).toBe(2);
  });

  it("`onTruncated` still fires alongside `out` (back-compat escape hatch, e.g. for telemetry/tests)", async () => {
    const method = makePaginatedMethod([
      { items: ["a"], cursor: "next" },
      { items: ["b"], cursor: "next2" },
    ]);
    const out = makeOut();
    const onTruncated = vi.fn();

    for await (const item of streamAll(method as never, {}, { maxPages: 1, out, sleep: noSleep, onTruncated })) {
      void item;
    }
    expect(onTruncated).toHaveBeenCalledWith(1, true);
  });
});

// ---------------------------------------------------------------------------
// NDJSON-mode discoverability notice (once per invocation).
// ---------------------------------------------------------------------------

describe("lib/paginate — NDJSON-mode notice", () => {
  it("emits the notice to stderr exactly once when streaming engages, before any item logic", async () => {
    const method = makePaginatedMethod([
      { items: ["a"], cursor: "next" },
      { items: ["b"], cursor: "next2" },
      { items: ["c"], cursor: null },
    ]);
    const out = makeOut();

    for await (const item of streamAll(method as never, {}, { maxPages: 100, out, sleep: noSleep })) {
      void item;
    }
    const noticeWrites = (out.stderr.write as Mock).mock.calls
      .map((c) => c[0] as string)
      .filter((s) => s.includes("NDJSON"));
    expect(noticeWrites).toHaveLength(1);
    expect(noticeWrites[0]).toBe(ndjsonModeNotice());
  });

  it("does NOT emit the notice when the response is non-paginatable (PaginateError first)", async () => {
    const method = vi.fn(async () => ({ id: "not-a-list" }));
    const out = makeOut();
    await expect(
      (async () => {
        for await (const item of streamAll(method as never, {}, { maxPages: 10, out, sleep: noSleep })) {
          void item;
        }
      })(),
    ).rejects.toBeInstanceOf(PaginateError);
    const stderrText = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    expect(stderrText).not.toContain("NDJSON");
  });

  it("does NOT touch stderr at all when `out` is omitted", async () => {
    const method = makePaginatedMethod([{ items: ["a"], cursor: null }]);
    // No `out` — pure-logic consumer. Must not throw trying to write a notice.
    const collected: string[] = [];
    for await (const item of streamAll(method as never, {}, { maxPages: 10, sleep: noSleep })) {
      collected.push(item as string);
    }
    expect(collected).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------

/**
 * #749 — a page envelope's `notices[]` (api/008 §F/§G) must not be silently
 * dropped on the `--all` NDJSON path. stdout carries data only (one item per
 * line); notices go to stderr via the same formatter `lib/output.ts`'s
 * human-mode renderer uses.
 */
describe("lib/paginate — streamAll surfaces page notices[] (#749)", () => {
  const filterNotice = {
    code: "FILTER_VALUE_UNCHECKED",
    message: "The value was treated as an id and was not looked up.",
    field: "industry",
    value: "42",
  };
  const pageNotice = {
    code: "ALL_RESULTS_HIDDEN",
    message: "Every result on this page is hidden from the connected account.",
  };

  it("writes a §F-shaped page notice (field + value) to stderr, not stdout", async () => {
    const method = makePaginatedMethod([
      { items: [], cursor: null, notices: [filterNotice] } as never,
    ]);
    const out = makeOut();

    const collected: unknown[] = [];
    for await (const item of streamAll(method as never, {}, { maxPages: 10, out, sleep: noSleep })) {
      collected.push(item);
    }

    expect(collected).toEqual([]);
    const stderrText = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    expect(stderrText).toContain("FILTER_VALUE_UNCHECKED");
    expect(stderrText).toContain("field: industry");
    expect(stderrText).toContain("value: 42");
    // stdout stays pure NDJSON data — no notice text leaks into the item stream.
    const stdoutText = (out.stdout.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    expect(stdoutText).not.toContain("FILTER_VALUE_UNCHECKED");
  });

  it("writes a §G-shaped page notice (no field/value) to stderr on an all-hidden page", async () => {
    const method = makePaginatedMethod([
      { items: [{ id: "p_1", visibility: "hidden" }], cursor: null, notices: [pageNotice] } as never,
    ]);
    const out = makeOut();

    for await (const item of streamAll(method as never, {}, { maxPages: 10, out, sleep: noSleep })) {
      void item;
    }

    const stderrText = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    expect(stderrText).toContain("ALL_RESULTS_HIDDEN");
    expect(stderrText).toContain("Every result on this page is hidden from the connected account.");
  });

  it("emits per-page notices independently across multiple pages", async () => {
    const method = makePaginatedMethod([
      { items: ["a"], cursor: "next", notices: [filterNotice] } as never,
      { items: ["b"], cursor: null, notices: [pageNotice] } as never,
    ]);
    const out = makeOut();

    const collected: unknown[] = [];
    for await (const item of streamAll(method as never, {}, { maxPages: 10, out, sleep: noSleep })) {
      collected.push(item);
    }

    expect(collected).toEqual(["a", "b"]);
    const stderrText = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string).join("");
    expect(stderrText).toContain("FILTER_VALUE_UNCHECKED");
    expect(stderrText).toContain("ALL_RESULTS_HIDDEN");
  });

  it("REGRESSION: a page with no notices key writes nothing extra to stderr beyond the existing NDJSON-mode notice", async () => {
    const method = makePaginatedMethod([{ items: ["a"], cursor: null }]);
    const out = makeOut();

    for await (const item of streamAll(method as never, {}, { maxPages: 10, out, sleep: noSleep })) {
      void item;
    }

    const stderrWrites = (out.stderr.write as Mock).mock.calls.map((c) => c[0] as string);
    // Only the one existing NDJSON-mode announcement — nothing added by this fix.
    expect(stderrWrites).toEqual([ndjsonModeNotice()]);
  });

  it("REGRESSION: does not throw when `out` is omitted, even when the page carries notices", async () => {
    const method = makePaginatedMethod([
      { items: ["a"], cursor: null, notices: [pageNotice] } as never,
    ]);
    const collected: unknown[] = [];
    for await (const item of streamAll(method as never, {}, { maxPages: 10, sleep: noSleep })) {
      collected.push(item);
    }
    expect(collected).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------
// --all inter-page pacing.
// ---------------------------------------------------------------------------

describe("lib/paginate — inter-page pacing", () => {
  it("sleeps between pages by the default delay, but not before the first fetch nor after the last page", async () => {
    const method = makePaginatedMethod([
      { items: ["a"], cursor: "next" },
      { items: ["b"], cursor: "next2" },
      { items: ["c"], cursor: null },
    ]);
    const sleep = vi.fn(async () => {});

    for await (const item of streamAll(method as never, {}, { maxPages: 100, sleep })) {
      void item;
    }
    // 3 pages, cursor null on the last → exactly 2 inter-page gaps.
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(DEFAULT_PAGE_DELAY_MS);
    expect(DEFAULT_PAGE_DELAY_MS).toBeGreaterThanOrEqual(300);
    expect(DEFAULT_PAGE_DELAY_MS).toBeLessThanOrEqual(500);
  });

  it("honors an explicit pageDelayMs override", async () => {
    const method = makePaginatedMethod([
      { items: ["a"], cursor: "next" },
      { items: ["b"], cursor: null },
    ]);
    const sleep = vi.fn(async () => {});
    for await (const item of streamAll(method as never, {}, { maxPages: 100, pageDelayMs: 50, sleep })) {
      void item;
    }
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(50);
  });

  it("pageDelayMs: 0 disables the delay entirely (no sleep call)", async () => {
    const method = makePaginatedMethod([
      { items: ["a"], cursor: "next" },
      { items: ["b"], cursor: null },
    ]);
    const sleep = vi.fn(async () => {});
    for await (const item of streamAll(method as never, {}, { maxPages: 100, pageDelayMs: 0, sleep })) {
      void item;
    }
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not sleep after truncation (the truncated page is the last fetch)", async () => {
    const method = makePaginatedMethod([
      { items: ["a"], cursor: "next" },
      { items: ["b"], cursor: "next2" },
      { items: ["c"], cursor: null },
    ]);
    const sleep = vi.fn(async () => {});
    for await (const item of streamAll(method as never, {}, { maxPages: 2, sleep })) {
      void item;
    }
    // page1 → sleep → page2 → truncate (no sleep after). Exactly 1 gap.
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});

describe("lib/paginate — pageDelayFrom (flag parsing)", () => {
  it("undefined stays undefined (caller falls back to the default)", () => {
    expect(pageDelayFrom(undefined)).toBeUndefined();
  });
  it("parses a non-negative integer, including 0", () => {
    expect(pageDelayFrom("0")).toBe(0);
    expect(pageDelayFrom("250")).toBe(250);
  });
  it("rejects a negative or non-numeric value (returns undefined → default applies)", () => {
    expect(pageDelayFrom("-5")).toBeUndefined();
    expect(pageDelayFrom("abc")).toBeUndefined();
    expect(pageDelayFrom("")).toBeUndefined();
  });
});
