/**
 * A notice must survive the whole render pipeline, not just the last step.
 *
 * ## What was still broken after the renderer learned about notices
 *
 * The renderer now surfaces a response's top-level `notices[]`. But it is not
 * the first thing to touch the response: `renderSuccess` runs the command's
 * slim projector, then `--fields`, and only then renders. Both of those can
 * delete the array before the renderer ever sees it.
 *
 *   - Nine of the shipped slim projectors preserve the envelope by spreading
 *     it (`{ ...d, items }`). Three rebuild it from a fixed allowlist
 *     (`{ object, items, cursor }`) and so drop `notices` outright: `connect
 *     sent`, `connect received`, and `account list`. Same rule, hand-written
 *     twelve times, wrong in three.
 *   - `--fields` preserves the envelope on a list response (it spreads too)
 *     but not on a single object, where the projection is a strict allowlist.
 *     So the renderer's own single-object notice branch was unreachable the
 *     moment a caller passed `--fields`.
 *
 * In every one of those cases the caller gets an empty or reduced result with
 * no explanation, which is the silent success the notices channel exists to
 * abolish, restored one layer upstream of where it was fixed.
 *
 * ## Why the projector cases are enumerated from the module, not listed
 *
 * A hand-written list of projectors would cover the three that are wrong
 * today and silently miss the fourth one somebody adds next month, which is
 * how this class survived its first fix. So the suite reflects over
 * `lib/slim.ts`'s exports and asserts the guarantee for every envelope-level
 * projector it finds. Adding a projector adds a case automatically.
 */

import { describe, it, expect } from "vitest";
import { renderSuccess, type OutputStreams } from "../../src/lib/output.js";
import * as slimModule from "../../src/lib/slim.js";

const NOTICE = {
  code: "ALL_RESULTS_HIDDEN",
  message: "none of the people on this page were disclosed to the connected account",
};

/** A list envelope carrying a page-scoped notice, as the wire delivers it. */
function envelopeWithNotice(): Record<string, unknown> {
  return {
    object: "some_list",
    items: [{ id: "item_1" }],
    cursor: null,
    notices: [NOTICE],
  };
}

interface Captured {
  stdout: string;
  stderr: string;
}

function capture(): OutputStreams & { captured: Captured } {
  const captured: Captured = { stdout: "", stderr: "" };
  return {
    captured,
    stdout: { write: (s: string) => void (captured.stdout += s) },
    stderr: { write: (s: string) => void (captured.stderr += s) },
  };
}

/**
 * Every envelope-level slim projector the CLI ships. Item-level projectors
 * (suffix `Item`) take a single item rather than a response, so they are not
 * part of this contract.
 */
const projectors: Array<[string, (data: unknown) => unknown]> = Object.entries(
  slimModule as unknown as Record<string, unknown>,
)
  .filter(
    ([name, value]) =>
      typeof value === "function" && name.startsWith("slim") && !name.endsWith("Item"),
  )
  .map(([name, value]) => [name, value as (data: unknown) => unknown]);

describe("notices survive slim projection", () => {
  it("the reflection found the projectors it is meant to cover", () => {
    // A guard on the guard: if the module is renamed or the filter stops
    // matching, every case below would vacuously pass.
    expect(projectors.length).toBeGreaterThanOrEqual(12);
    const names = projectors.map(([n]) => n);
    expect(names).toContain("slimAccountList");
    expect(names).toContain("slimInviteSent");
    expect(names).toContain("slimInviteReceived");
    expect(names).toContain("slimSearchPeople");
  });

  it.each(projectors)("%s: the notice reaches stdout in JSON mode", (_name, slim) => {
    const out = capture();
    renderSuccess(envelopeWithNotice(), { json: true, isTTY: false, slim }, out);
    const parsed = JSON.parse(out.captured.stdout) as { notices?: unknown };
    expect(parsed.notices).toEqual([NOTICE]);
  });

  it.each(projectors)("%s: the notice reaches stdout in human mode", (_name, slim) => {
    const out = capture();
    renderSuccess(envelopeWithNotice(), { json: false, isTTY: true, slim }, out);
    expect(out.captured.stdout).toContain("notice [ALL_RESULTS_HIDDEN]");
    expect(out.captured.stdout).toContain("none of the people on this page were disclosed");
  });

  it.each(projectors)(
    "%s: a response with no notices renders exactly as it did before",
    (_name, slim) => {
      const clean = { object: "some_list", items: [{ id: "item_1" }], cursor: null };
      const out = capture();
      renderSuccess(clean, { json: true, isTTY: false, slim }, out);
      expect(out.captured.stdout).not.toContain("notices");
      expect(out.captured.stdout).not.toContain("notice [");

      const human = capture();
      renderSuccess(clean, { json: false, isTTY: true, slim }, human);
      expect(human.captured.stdout).not.toContain("notice [");
      // No leading blank line where the notice block would have been.
      expect(human.captured.stdout.startsWith("\n")).toBe(false);
    },
  );
});

describe("notices survive --fields projection", () => {
  it("a single-object response keeps its notice under --fields", () => {
    const out = capture();
    renderSuccess(
      { id: "acc_1", status: "active", notices: [NOTICE] },
      { json: true, isTTY: false, fields: "id" },
      out,
    );
    const parsed = JSON.parse(out.captured.stdout) as Record<string, unknown>;
    expect(parsed["id"]).toBe("acc_1");
    // The projection still does its job: unrequested data fields are gone.
    expect(parsed["status"]).toBeUndefined();
    // But the honest-degradation signal is not a data field to be projected away.
    expect(parsed["notices"]).toEqual([NOTICE]);
  });

  it("a single-object response renders its notice under --fields in human mode", () => {
    const out = capture();
    renderSuccess(
      { id: "acc_1", status: "active", notices: [NOTICE] },
      { json: false, isTTY: true, fields: "id" },
      out,
    );
    expect(out.captured.stdout).toContain("notice [ALL_RESULTS_HIDDEN]");
    expect(out.captured.stdout).toContain("id: acc_1");
    // Rendered as chrome above the result, never as a data row.
    expect(out.captured.stdout).not.toContain("notices:");
    expect(out.captured.stdout.indexOf("notice [")).toBeLessThan(
      out.captured.stdout.indexOf("id: acc_1"),
    );
  });

  it("a list response keeps its notice under --fields (regression lock)", () => {
    const out = capture();
    renderSuccess(
      { object: "some_list", items: [{ id: "a", extra: 1 }], notices: [NOTICE] },
      { json: true, isTTY: false, fields: "id" },
      out,
    );
    const parsed = JSON.parse(out.captured.stdout) as Record<string, unknown>;
    expect(parsed["notices"]).toEqual([NOTICE]);
    expect(parsed["items"]).toEqual([{ id: "a" }]);
  });

  it("slim and --fields together still surface the notice", () => {
    const out = capture();
    renderSuccess(
      envelopeWithNotice(),
      { json: true, isTTY: false, fields: "id", slim: slimModule.slimAccountList },
      out,
    );
    const parsed = JSON.parse(out.captured.stdout) as Record<string, unknown>;
    expect(parsed["notices"]).toEqual([NOTICE]);
  });

  it("--verbose (slim bypassed) still surfaces the notice", () => {
    const out = capture();
    renderSuccess(
      envelopeWithNotice(),
      { json: true, isTTY: false, verbose: true, slim: slimModule.slimAccountList },
      out,
    );
    const parsed = JSON.parse(out.captured.stdout) as Record<string, unknown>;
    expect(parsed["notices"]).toEqual([NOTICE]);
  });

  it("an explicit --fields notices does not duplicate or wrap the array", () => {
    const out = capture();
    renderSuccess(
      { id: "acc_1", notices: [NOTICE] },
      { json: true, isTTY: false, fields: "notices" },
      out,
    );
    const parsed = JSON.parse(out.captured.stdout) as Record<string, unknown>;
    expect(parsed["notices"]).toEqual([NOTICE]);
    expect(Object.keys(parsed)).toEqual(["notices"]);
  });
});

describe("notices preservation does not invent an array", () => {
  const degenerate: Array<[string, unknown]> = [
    ["notices absent", { id: "a" }],
    ["notices empty", { id: "a", notices: [] }],
    ["notices not an array", { id: "a", notices: "oops" }],
    ["notices null", { id: "a", notices: null }],
  ];

  it.each(degenerate)("%s: no notice chrome is emitted in human mode", (_label, data) => {
    const out = capture();
    renderSuccess(data, { json: false, isTTY: true, fields: "id" }, out);
    expect(out.captured.stdout).not.toContain("notice [");
  });

  // Human mode alone cannot see this: renderHuman filters `notices` out of its
  // key/value body, so a reattached empty or malformed array is invisible
  // there while it is plainly present in the JSON an agent parses. The
  // response shape is a contract, and `notices` is documented as omitted
  // entirely when there is nothing to report, so echoing `"notices":[]` is a
  // shape change even though it renders as nothing.
  it.each(degenerate)("%s: JSON output carries no notices key at all", (_label, data) => {
    const out = capture();
    renderSuccess(data, { json: true, isTTY: false, fields: "id" }, out);
    const parsed = JSON.parse(out.captured.stdout) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsed, "notices")).toBe(false);
    expect(out.captured.stdout).not.toContain("notices");
  });

  it.each(degenerate)("%s: JSON output carries no notices key without --fields", (_label, data) => {
    const out = capture();
    renderSuccess(data, { json: true, isTTY: false, slim: slimModule.slimAccountGet }, out);
    expect(out.captured.stdout).not.toContain("notices");
  });

  it("a bare array response is passed through untouched", () => {
    const out = capture();
    renderSuccess([{ id: "a" }, { id: "b" }], { json: true, isTTY: false }, out);
    expect(JSON.parse(out.captured.stdout)).toEqual([{ id: "a" }, { id: "b" }]);
  });
});
