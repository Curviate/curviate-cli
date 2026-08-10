/**
 * README.md's exit-code table and global-flags list are DATA about the
 * source, not independent prose: they must describe exactly the exit codes
 * exit-codes.ts actually produces and exactly the flags global-flags.ts
 * actually declares. Three rounds of hand-correction had already produced
 * three generations of a README that quietly drifted from both (the table
 * stopped at exit 5 when the real range was 0-12; --page-delay and --verbose
 * existed in --help with zero README occurrences).
 *
 * This file computes the expected content FROM the same source modules the
 * CLI itself is built from, and asserts README.md agrees, so a future
 * exit-code or flag change that forgets to touch the README fails `pnpm test`
 * immediately instead of shipping silently wrong docs a fourth time.
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { EXIT_CODE_MAP, AUTH_NEEDED } from "../src/lib/exit-codes.js";
import { GLOBAL_FLAGS } from "../src/lib/global-flags.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");

async function readReadme(): Promise<string> {
  return readFile(resolve(pkgRoot, "README.md"), "utf8");
}

/** The fenced ```bash blocks and the fenced Usage block (no language tag) share a syntax; this pulls the ONE plain ``` block that opens the Usage section. */
function extractUsageBlock(readme: string): string {
  const match = readme.match(/## Usage\s*\n\s*```\n([\s\S]*?)\n```/);
  if (!match) throw new Error("could not find the ## Usage fenced block in README.md");
  return match[1]!;
}

/** The `| Code | Meaning |` markdown table under `## Exit codes`. */
function extractExitCodeTable(readme: string): string {
  const match = readme.match(/## Exit codes\s*\n\s*\|[\s\S]*?\n\n/);
  if (!match) throw new Error("could not find the ## Exit codes table in README.md");
  return match[0];
}

describe("README.md exit-code table is generated from exit-codes.ts, not hand-transcribed", () => {
  it("documents exactly the set of exit codes the CLI can actually produce", async () => {
    // 0 (success) is never a member of EXIT_CODE_MAP (it isn't an error), so
    // it's added explicitly; every other code is derived straight from the
    // map plus the one named constant that deliberately sits outside it.
    const expectedCodes = new Set<number>([0, AUTH_NEEDED, ...Object.values(EXIT_CODE_MAP)]);

    const readme = await readReadme();
    const table = extractExitCodeTable(readme);
    const documentedCodes = new Set(
      [...table.matchAll(/^\|\s*(\d+)\s*\|/gm)].map((m) => Number(m[1])),
    );

    const missing = [...expectedCodes].filter((c) => !documentedCodes.has(c)).sort((a, b) => a - b);
    const extra = [...documentedCodes].filter((c) => !expectedCodes.has(c)).sort((a, b) => a - b);

    expect(missing, `exit codes the CLI can produce but the README does not document: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `exit codes the README documents that the CLI never produces: ${extra.join(", ")}`).toEqual([]);
  });

  it("has no duplicate exit-code rows", async () => {
    const readme = await readReadme();
    const table = extractExitCodeTable(readme);
    const codes = [...table.matchAll(/^\|\s*(\d+)\s*\|/gm)].map((m) => Number(m[1]));
    expect(codes.length, "each documented code should appear exactly once").toBe(new Set(codes).size);
  });

  it("regression: 6-11 were entirely absent from the table (README stopped at 5)", async () => {
    const readme = await readReadme();
    const table = extractExitCodeTable(readme);
    const documentedCodes = new Set(
      [...table.matchAll(/^\|\s*(\d+)\s*\|/gm)].map((m) => Number(m[1])),
    );
    for (const code of [6, 7, 8, 9, 10, 11]) {
      expect(documentedCodes.has(code), `exit code ${code} should be documented`).toBe(true);
    }
  });
});

describe("README.md global-flags list is generated from global-flags.ts, not hand-transcribed", () => {
  it("mentions every flag GLOBAL_FLAGS declares", async () => {
    const readme = await readReadme();
    const usageBlock = extractUsageBlock(readme);
    const documentedFlags = new Set(
      [...usageBlock.matchAll(/^\s{2}--([a-z][a-z0-9-]*)/gm)].map((m) => m[1]),
    );

    const expectedFlags = Object.keys(GLOBAL_FLAGS);
    const missing = expectedFlags.filter((f) => !documentedFlags.has(f));
    expect(missing, `flags --help lists that the README's Usage block omits: ${missing.map((f) => `--${f}`).join(", ")}`).toEqual([]);
  });

  it("documents no flag that GLOBAL_FLAGS does not declare", async () => {
    const readme = await readReadme();
    const usageBlock = extractUsageBlock(readme);
    const documentedFlags = [...usageBlock.matchAll(/^\s{2}--([a-z][a-z0-9-]*)/gm)].map((m) => m[1]!);

    const expectedFlags = new Set(Object.keys(GLOBAL_FLAGS));
    const extra = documentedFlags.filter((f) => !expectedFlags.has(f));
    expect(extra, `flags the README documents that GLOBAL_FLAGS does not declare: ${extra.map((f) => `--${f}`).join(", ")}`).toEqual([]);
  });

  it("regression: --page-delay and --verbose were entirely absent from the Usage block", async () => {
    const readme = await readReadme();
    const usageBlock = extractUsageBlock(readme);
    expect(usageBlock).toMatch(/^\s{2}--page-delay\b/m);
    expect(usageBlock).toMatch(/^\s{2}--verbose\b/m);
  });
});
