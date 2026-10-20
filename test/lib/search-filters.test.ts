/**
 * Tests for the shared search-filters escape-hatch helper.
 *
 * The rich search bodies (35-40 filters, many nested) are reachable through a
 * --filters <json> / --filters-file <path> / --filters - (stdin) escape hatch
 * that merges arbitrary JSON into the request body. This file asserts the
 * parse / merge / error contract that every search command depends on.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleFilters, splitCsv } from "../../src/lib/search-filters.js";
import { exitCode } from "../helpers/exit-code.js";

const dir = mkdtempSync(join(tmpdir(), "curviate-filters-"));
const fileWith = (content: string) => {
  const p = join(dir, `f${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, content);
  return p;
};

function makeReaders(opts: { stdin?: string } = {}) {
  return { readStdin: vi.fn(async () => opts.stdin ?? "") };
}

describe("assembleFilters — JSON escape hatch", () => {
  it("no --filters source → empty base body", async () => {
    const r = await assembleFilters({}, makeReaders());
    expect(r).toEqual({ body: {} });
  });

  it("--filters '<json>' inline → merges parsed object into the body", async () => {
    const r = await assembleFilters(
      { filters: '{"industry":["96"],"network_distance":[1,2]}' },
      makeReaders(),
    );
    expect(r).toEqual({ body: { industry: ["96"], network_distance: [1, 2] } });
  });

  it("--filters-file <path> and --filters-file - (stdin) read the document", async () => {
    expect(await assembleFilters({ "filters-file": fileWith('{"location":["103644278"]}') }, makeReaders())).toEqual({ body: { location: ["103644278"] } });
    const readers = makeReaders({ stdin: '{"company":["1441"]}' });
    expect(await assembleFilters({ "filters-file": "-" }, readers)).toEqual({ body: { company: ["1441"] } });
    expect(readers.readStdin).toHaveBeenCalledTimes(1);
  });

  it("--filters - → reads JSON from stdin and merges", async () => {
    const readers = makeReaders({ stdin: '{"company":["1441"]}' });
    const r = await assembleFilters({ filters: "-" }, readers);
    expect(readers.readStdin).toHaveBeenCalled();
    expect(r).toEqual({ body: { company: ["1441"] } });
  });

  it("invalid JSON → returns an error (no body)", async () => {
    const r = await assembleFilters({ filters: "{ not valid json " }, makeReaders());
    expect(r).toHaveProperty("error");
    expect("error" in r && r.error).toMatch(/valid JSON/i);
  });

  it("non-object JSON (array) → returns an error (no body)", async () => {
    const r = await assembleFilters({ filters: "[1,2,3]" }, makeReaders());
    expect(r).toHaveProperty("error");
    expect("error" in r && r.error).toMatch(/object/i);
  });

  it("non-object JSON (scalar) → returns an error", async () => {
    const r = await assembleFilters({ filters: "42" }, makeReaders());
    expect(r).toHaveProperty("error");
  });

  it("a missing --filters-file, and --filters-file - with --filters -, exit 2 without reading stdin", async () => {
    const readers = makeReaders({ stdin: "{}" });
    expect(await exitCode(() => assembleFilters({ "filters-file": join(dir, "missing.json") }, readers))).toBe(2);
    expect(await exitCode(() => assembleFilters({ "filters-file": "-", filters: "-" }, readers))).toBe(2);
    expect(readers.readStdin).not.toHaveBeenCalled();
  });

  it("--filters-file wins when both --filters-file and --filters - are given", async () => {
    const readers = makeReaders({ stdin: '{"from":"stdin"}' });
    const r = await assembleFilters({ "filters-file": fileWith('{"from":"file"}'), filters: "-" }, readers);
    expect(r).toEqual({ body: { from: "file" } });
    expect(readers.readStdin).not.toHaveBeenCalled();
  });
});

describe("splitCsv — comma-separated array flags", () => {
  it("splits on commas and trims", () => {
    expect(splitCsv("a, b ,c")).toEqual(["a", "b", "c"]);
  });

  it("single value → single-element array", () => {
    expect(splitCsv("solo")).toEqual(["solo"]);
  });

  it("drops empty segments from trailing/double commas", () => {
    expect(splitCsv("a,,b,")).toEqual(["a", "b"]);
  });
});
