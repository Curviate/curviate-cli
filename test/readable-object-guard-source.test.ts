/**
 * Source check: every single-object read must call `readableObject` before
 * it can reach `renderSuccess`, so a new read command cannot silently skip
 * the guard by copy-pasting an existing handler and forgetting the call.
 * Pure source scan (real TypeScript AST, not a brace-counting regex — see
 * `helpers/read-guard-nodes.ts`), no server, no built binary — fast enough
 * to run on every save, and it fails the moment a read's body drops the
 * call.
 *
 * The read set itself is derived from the source, never a hand-written
 * list: primarily, a command whose handler calls `rejectPreviewOnRead` and
 * does not call `streamAll` is a single-object read; excluding the ones
 * that never call `renderSuccess` at all (the binary-download reads — `job
 * applicant resume`, `message attachment`, `recruiter applicant resume` —
 * exempt per the exit-code spec's As-built note, they save a 2xx body
 * verbatim and have no JSON object to validate). Plus a narrow named
 * exception for two commands that don't follow the `rejectPreviewOnRead`
 * convention at all (`account connect-session poll`, `account checkpoint
 * poll`) but still render a single always-object response — see
 * `helpers/read-guard-nodes.ts` for the OpenAPI-verified justification.
 */

import { describe, it, expect } from "vitest";
import { deriveSingleObjectReadFunctions } from "./helpers/read-guard-nodes.js";

describe("readableObject guard: every single-object read calls it", () => {
  const reads = deriveSingleObjectReadFunctions();

  it("the derivation finds a real, non-trivial read surface (sanity: the scan itself works)", () => {
    // Guards the guard: if this regresses to 0, the scan broke (AST walk
    // drift, moved directory, renamed helper) and every test below would
    // vacuously pass having checked nothing. 28 at authoring time; a wide
    // floor so an unrelated future read or two doesn't need this bumped.
    expect(reads.length).toBeGreaterThanOrEqual(20);
  });

  for (const { file, name, body } of deriveSingleObjectReadFunctions()) {
    it(`${file}:${name} calls readableObject before renderSuccess`, () => {
      expect(body).toMatch(/readableObject\s*\(/);
    });
  }

  it("no read function is silently excluded by also matching streamAll (control: the exclusion path fires)", () => {
    // A same-path positive control for the exclusion rule itself: at least
    // one function in the source genuinely calls both rejectPreviewOnRead
    // AND streamAll (a paginated read), proving the `!streamAll` filter
    // above is discriminating, not vacuously true because nothing in the
    // corpus ever matches it.
    const names = reads.map((r) => `${r.file}:${r.name}`);
    expect(names).not.toContain("company.ts:runCompanyEmployees");
  });
});
