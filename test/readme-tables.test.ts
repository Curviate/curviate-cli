/** README's exit-code table and global-flags list are data about the source: they must describe exactly what exit-codes.ts produces and global-flags.ts declares. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTH_NEEDED, EXIT_CODE_MAP } from "../src/lib/exit-codes.js";
import { GLOBAL_FLAGS } from "../src/lib/global-flags.js";
import { pkgRoot } from "./helpers/pkg.js";

const readme = readFileSync(join(pkgRoot, "README.md"), "utf8");

describe("README.md", () => {
  it("documents each exit code the CLI can produce exactly once, and no other", () => {
    const table = readme.match(/## Exit codes\s*\n\s*\|[\s\S]*?\n\n/)![0];
    const documented = [...table.matchAll(/^\|\s*(\d+)\s*\|/gm)].map((m) => Number(m[1]));
    expect(documented.sort((a, b) => a - b)).toEqual([...new Set([0, AUTH_NEEDED, ...Object.values(EXIT_CODE_MAP)])].sort((a, b) => a - b));
  });

  it("lists exactly the global flags GLOBAL_FLAGS declares in its Usage block", () => {
    const usage = readme.match(/## Usage\s*\n\s*```\n([\s\S]*?)\n```/)![1]!;
    const documented = [...usage.matchAll(/^\s{2}--([a-z][a-z0-9-]*)/gm)].map((m) => m[1]);
    expect(documented.sort()).toEqual(Object.keys(GLOBAL_FLAGS).sort());
  });
});
