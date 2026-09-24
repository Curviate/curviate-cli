/**
 * HOUSE-PATTERN LINT ONLY — not the authority on guard coverage.
 *
 * Per the exit-code spec's As-built amendment (qa cycle 2),
 * that role belongs to the runtime sweep in
 * `readable-object-null-exit7-bin.test.ts`: it invokes the live command
 * registry against a stub and checks actual exit codes, so it cannot be
 * fooled by how a read happens to be written. This file stays as a fast,
 * no-server, no-build source scan for the ONE shape this codebase's reads
 * actually use — `const IDENT = await ns.x.y(...); renderSuccess(IDENT,
 * ...)` — so that common case gets a red result in milliseconds instead of
 * waiting on the ~30s sweep.
 *
 * KNOWN LIMITS (each defeats this file, none defeats the runtime sweep):
 * an inline `if (flags.preview) {...}` check that isn't one of the two
 * named `KNOWN_NON_REJECTING_SDK_CALLS` patterns; `renderSuccess(await
 * ns.x.y(...))` with no intermediate variable; a property-access render
 * argument (`renderSuccess(result.data)`); an arrow-function export
 * (`export const runX = async (...) => {...}`, this scanner only walks
 * `function` declarations); render via a shared helper's parameter (the
 * `renderSuccess` call lives in a different function than the SDK call);
 * and a `readableObject` call reachable only under a conditional that
 * doesn't cover the render path (this file checks textual presence in a
 * window, not control-flow reachability).
 *
 * Every single-object read call site must PAIR a `readableObject(IDENT)`
 * call with its `renderSuccess(IDENT, ...)` call — a guard call on the
 * WRONG value is caught, not just presence somewhere in the function.
 * Call-site granularity, not per-function: a function that mixes a
 * paginated branch with a plain single-object branch (`profile <id>`,
 * `profile me`) is not excluded wholesale just because `streamAll` appears
 * somewhere in it. See `helpers/read-guard-nodes.ts` for the full
 * derivation.
 */

import { describe, it, expect } from "vitest";
import { deriveGuardCallSites, scanRenderSuccessCallSites } from "./helpers/read-guard-nodes.js";

describe("readableObject guard: every candidate call site pairs the guard with the rendered value", () => {
  const sites = deriveGuardCallSites();

  it("the derivation finds a real, non-trivial read surface (sanity: the scan itself works)", () => {
    // Guards the guard: if this regresses to 0, the scan broke (AST walk
    // drift, moved directory, renamed helper) and every test below would
    // vacuously pass having checked nothing. 30 call sites at authoring
    // time (28 from the primary signal + profile's 2); a wide floor so an
    // unrelated future read or two doesn't need this bumped.
    expect(sites.length).toBeGreaterThanOrEqual(25);
  });

  for (const site of sites) {
    it(`${site.file}:${site.fn} pairs readableObject(${site.argText}) with its renderSuccess(${site.argText}, ...) call`, () => {
      // Exact-identifier pairing, not "readableObject appears somewhere in
      // the function": a guard call on a DIFFERENT value must not satisfy
      // this (qa arm D). Escaped for regex safety, though argText is
      // always a plain identifier here.
      const escaped = site.argText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(site.window).toMatch(new RegExp(`readableObject\\(\\s*${escaped}\\s*\\)`));
    });
  }

  it("profile's mixed streamAll+single-object functions are both represented (control: the arm-B fix fires)", () => {
    // A same-path positive control for the per-call-site fix itself: these
    // two functions each have a streamAll-using branch elsewhere in the
    // SAME function, and were wholesale excluded by the old whole-function
    // check. If this regresses, the fix regressed with it.
    const fns = sites.map((s) => `${s.file}:${s.fn}`);
    expect(fns).toContain("profile.ts:runProfileMe");
    expect(fns).toContain("profile.ts:runProfileGet");
  });

  it("the inline-preview reads (which accept --preview) are covered (control: the arm-C signal fires)", () => {
    const fns = sites.map((s) => `${s.file}:${s.fn}`);
    expect(fns).toContain("account.ts:runAccountConnectSessionPoll");
    expect(fns).toContain("account.ts:runAccountCheckpointPoll");
    expect(fns).toContain("account.ts:runAccountCheckpointSolve");
  });

  it("a genuine write is never swept in merely because its response happens to be object-shaped (control: the signal doesn't over-include)", () => {
    // comment.ts:runCommentReact has the IDENTICAL inline-preview shape as
    // the account.ts poll functions (buildPreviewOutput, then a bare
    // `await ns.X.Y(...)` rendered directly) and its OpenAPI response is
    // also object-shaped — proving the KNOWN_NON_REJECTING_SDK_CALLS list
    // is doing real, named exclusion work, not vacuously matching every
    // inline-preview command.
    const fns = sites.map((s) => `${s.file}:${s.fn}`);
    expect(fns).not.toContain("comment.ts:runCommentReact");
  });

  it("no read function is silently excluded by also having a streamAll branch (control: the exclusion no longer fires wholesale)", () => {
    // Unlike the old per-function check, company.ts:runCompanyEmployees
    // (a streamAll-only function, no plain single-object branch at all)
    // correctly contributes ZERO call sites — not because the function is
    // excluded, but because none of its renderSuccess calls trace to a
    // bare single-object read (its one plain-mode renderSuccess call is
    // already guarded by readablePage).
    const companyEmployeesSites = sites.filter((s) => s.file === "company.ts" && s.fn === "runCompanyEmployees");
    expect(companyEmployeesSites).toEqual([]);
    // And the raw scan does see it call streamAll, proving this is a
    // deliberate exclusion (readablePage), not a scanning blind spot.
    const allCompanyEmployeesSites = scanRenderSuccessCallSites().filter(
      (s) => s.file === "company.ts" && s.fn === "runCompanyEmployees",
    );
    expect(allCompanyEmployeesSites.length).toBeGreaterThan(0);
  });
});
