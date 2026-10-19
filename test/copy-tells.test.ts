/**
 * No typographic tells in anything the CLI prints: em and en dashes, curly
 * quotes, the ellipsis glyph, arrows, exotic spaces read as machine-written.
 * Walks the TypeScript AST so only string and template literals are inspected
 * (comments are trivia; tsup's surviving ones are covered by `check:clean --dist`).
 * Scope is `src/**`: citty renders help from the `meta`/`args` strings there and
 * every error message is a literal in the same tree. The npm-page copy is gated
 * by `pnpm check:copy`. U+2022 (the mask glyph) and emoji are deliberately not
 * tells: one is functional, the other documents `message react`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pkgRoot } from "./helpers/pkg.js";
import { literals, walkTs as walk } from "./helpers/literals.js";

const TELLS: Array<[string, RegExp, string]> = [
  ["em dash", /—/, "—"],
  ["en dash", /–/, "–"],
  ["horizontal bar", /―/, "―"],
  ["curly single quote", /[‘’]/, "’"],
  ["curly double quote", /[“”]/, "“"],
  ["ellipsis glyph", /…/, "…"],
  ["exotic space", /[      　]/, " "],
  ["invisible character", /[​-‍⁠﻿­]/, "​"],
  ["arrow", /[←-⇿]/, "→"],
  ["minus sign", /−/, "−"],
  ["multiplication sign", /×/, "×"],
  ["inequality glyph", /[≤≥]/, "≤"],
  ["prime", /[′″]/, "′"],
  ["check or cross glyph", /[✓✗✅❌]/, "✅"],
];

describe("customer-facing copy has no typographic tells", () => {
  it("no string or template literal under src/ contains one", () => {
    const files = walk(resolve(pkgRoot, "src"));
    expect(files.length).toBeGreaterThan(10);
    const findings = files.flatMap((f) =>
      literals(f, readFileSync(f, "utf8")).flatMap((l) => {
        const hit = TELLS.find(([, p]) => p.test(l.text));
        return hit ? [`${relative(pkgRoot, f)}:${l.line} [${hit[0]}] ${l.text.trim().slice(0, 100)}`] : [];
      }),
    );
    expect(findings).toEqual([]);
  });

  it("each tell is detected, comments are exempt and literals are not", () => {
    for (const [label, pattern, sample] of TELLS) expect(pattern.test(`copy ${sample} here`), label).toBe(true);
    const lits = literals("s.ts", `// a comment —\nconst a = "printed —";\nconst b = \`clean \${x}\`;`);
    expect(lits.filter((l) => TELLS.some(([, p]) => p.test(l.text))).map((l) => l.text)).toEqual(["printed —"]);
  });
});
