/**
 * `--mode` / `--max-age` parsing, the CLI half of the retrieval ladder.
 *
 * The API is the authority for every rule asserted here: the four-value enum,
 * the integer `0..31_536_000` bound, and the refusal of `cache_only` combined
 * with `max_age`. The CLI mirrors them client-side so a malformed invocation
 * costs a usage error rather than a round trip, which is the exit-2 contract
 * ("misuse pre-check before any network call").
 *
 * The mirroring is the risk this file exists for: a client-side copy of a
 * server rule is a second place for the rule to live, so each arm below states
 * the SERVER's value, not the CLI's, and the ceiling is asserted as the exact
 * number rather than "some large bound".
 */
import { describe, it, expect } from "vitest";
import {
  MAX_AGE_CEILING_SECONDS,
  RETRIEVAL_MODES,
  parseRetrievalFlags,
} from "../../src/lib/retrieval.js";

/** Unwrap a parse expected to succeed, failing loudly (not silently) if it did not. */
function ok(flags: Parameters<typeof parseRetrievalFlags>[0]) {
  const r = parseRetrievalFlags(flags);
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`);
  return r.query;
}

describe("lib/retrieval — the vocabulary matches the server", () => {
  it("carries exactly the four modes the server's RETRIEVAL_MODES declares", () => {
    expect([...RETRIEVAL_MODES].sort()).toEqual(["auto", "cache_only", "live", "refill"]);
  });

  it("carries the server's exact max_age ceiling (one year in seconds)", () => {
    expect(MAX_AGE_CEILING_SECONDS).toBe(31_536_000);
  });
});

describe("lib/retrieval — the happy paths", () => {
  it("omitting both flags sends neither parameter", () => {
    // Not `{mode: undefined}`: an absent flag must not become a query key at
    // all, or every read starts pinning a mode it never asked for.
    expect(ok({})).toEqual({});
  });

  it.each([...RETRIEVAL_MODES])("accepts --mode %s", (mode) => {
    expect(ok({ mode })).toEqual({ mode });
  });

  it("accepts --max-age on its own", () => {
    expect(ok({ "max-age": "300" })).toEqual({ max_age: 300 });
  });

  it("accepts --mode and --max-age together (the server lets max_age outrank the preset)", () => {
    expect(ok({ mode: "auto", "max-age": "60" })).toEqual({ mode: "auto", max_age: 60 });
  });

  // EDGE: 0 is meaningful (the server reads it as mode=live), and it is the
  // value a falsy check silently drops.
  it("keeps --max-age 0, which the server reads as mode=live", () => {
    expect(ok({ "max-age": "0" })).toEqual({ max_age: 0 });
  });

  // EDGE: the boundary itself is INSIDE the bound (the API's max is inclusive).
  it("accepts --max-age exactly at the ceiling", () => {
    expect(ok({ "max-age": String(MAX_AGE_CEILING_SECONDS) })).toEqual({
      max_age: MAX_AGE_CEILING_SECONDS,
    });
  });
});

describe("lib/retrieval — cache_only refuses max_age", () => {
  it("refuses the pair rather than resolving it either way", () => {
    const r = parseRetrievalFlags({ mode: "cache_only", "max-age": "60" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/cache_only/);
    expect(r.error).toMatch(/max-age/);
  });

  // EDGE: 0 is the one max_age a "did they pass it?" truthiness check misses,
  // and `cache_only` + `--max-age 0` is precisely the combination whose
  // silent acceptance would mean a platform call under the one mode that
  // guarantees none.
  it("refuses cache_only with --max-age 0 too", () => {
    expect(parseRetrievalFlags({ mode: "cache_only", "max-age": "0" }).ok).toBe(false);
  });

  // CONTROL: the refusal is about the PAIR, not about cache_only itself.
  it("control: cache_only alone is accepted", () => {
    expect(ok({ mode: "cache_only" })).toEqual({ mode: "cache_only" });
  });

  // CONTROL: and not about max-age itself.
  it("control: --max-age 60 under every other mode is accepted", () => {
    for (const mode of RETRIEVAL_MODES.filter((m) => m !== "cache_only")) {
      expect(ok({ mode, "max-age": "60" })).toEqual({ mode, max_age: 60 });
    }
  });
});

describe("lib/retrieval — rejects what the server would reject", () => {
  it("rejects an unknown mode and names the valid values", () => {
    const r = parseRetrievalFlags({ mode: "cached" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // The message has to be actionable: an agent that mistyped needs the set.
    for (const m of RETRIEVAL_MODES) expect(r.error).toContain(m);
  });

  it("rejects an empty --mode", () => {
    expect(parseRetrievalFlags({ mode: "" }).ok).toBe(false);
  });

  it("rejects an empty --max-age", () => {
    expect(parseRetrievalFlags({ "max-age": "" }).ok).toBe(false);
  });

  it.each([
    ["a non-number", "soon"],
    ["a negative", "-1"],
    ["a fraction", "1.5"],
    ["exponent notation", "1e3"],
    ["hex", "0x10"],
    ["leading whitespace", " 60"],
    ["a trailing unit", "60s"],
  ])("rejects --max-age with %s", (_label, value) => {
    expect(parseRetrievalFlags({ "max-age": value }).ok).toBe(false);
  });

  it("rejects --max-age one second past the ceiling, naming the bound", () => {
    const r = parseRetrievalFlags({ "max-age": String(MAX_AGE_CEILING_SECONDS + 1) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain(String(MAX_AGE_CEILING_SECONDS));
  });

  // The rejection must never be a silent coercion: NaN reaching the wire as
  // `max_age=NaN` is a 400 from the server instead of a usage error here.
  it("never returns a NaN max_age", () => {
    for (const bad of ["soon", "", "1.5", "-1"]) {
      const r = parseRetrievalFlags({ "max-age": bad });
      expect(r.ok).toBe(false);
    }
  });
});
