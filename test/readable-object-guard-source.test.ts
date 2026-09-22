/**
 * Source check: every single-object read call site must PAIR a
 * `readableObject(IDENT)` call with its `renderSuccess(IDENT, ...)` call,
 * so a new read cannot silently skip the guard — and so a guard call on
 * the WRONG value (qa arm D) is caught, not just its
 * presence somewhere in the function.
 *
 * Call-site granularity, not per-function (qa arm B): a function that
 * mixes a paginated branch with a plain single-object branch
 * (`profile <id>`, `profile me`) is no longer excluded wholesale just
 * because `streamAll` appears somewhere in it — each `renderSuccess` call
 * site is judged on its own traced value. See `helpers/read-guard-nodes.ts`
 * for the full derivation (AST-based, call-site granularity, plus the
 * named non-`rejectPreviewOnRead` exception for qa arm C).
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

  it("the inline-preview (non-rejectPreviewOnRead) reads are covered (control: the arm-C signal fires)", () => {
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
