/**
 * No typographic tells in anything the CLI prints.
 *
 * Copy that reaches for characters no keyboard produces reads as
 * machine-generated: em and en dashes, curly quotes, the single-glyph ellipsis,
 * arrows, non-breaking spaces. Comments and JSDoc are exempt (they never reach
 * a consumer: tsup strips them from the bundle), so a line-based grep is the
 * wrong instrument. It would flag this package's own internal prose and catch
 * nothing a user can see. This walks the TypeScript AST instead, so only string
 * and template literals are inspected; comments are trivia and never become
 * nodes, which is exactly the exemption, obtained structurally rather than by a
 * heuristic.
 *
 * Scope is `src/**` because citty renders help directly from the `meta` and
 * `args` description strings that live there, and every error message the CLI
 * writes is a literal in the same tree: what is in a src literal IS what the
 * user reads. The npm-page copy (README, CHANGELOG, package.json) is gated
 * separately by `pnpm check:copy`, which runs at prepack.
 *
 * Two characters are deliberately absent from the set:
 *   U+2022 BULLET  is functional, not prose. `config list` renders a redacted
 *                  API key as `rdc_live_....1234` using it as the mask glyph.
 *   emoji          can be the subject matter rather than decoration. `post
 *                  react --emoji` documents its value with a literal emoji,
 *                  which is the clearest possible help text for that argument.
 * A check that reds on either would be a check people learn to bypass.
 */

import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, extname, relative } from "node:path";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const srcDir = resolve(pkgRoot, "src");

const EM_DASH = "—";

/** Characters with a plain-ASCII equivalent that printed copy must not use. */
export const TYPOGRAPHIC_TELLS: ReadonlyArray<{ label: string; pattern: RegExp; fix: string }> = [
  { label: "em dash", pattern: /—/, fix: "a comma, semicolon, colon, or period" },
  { label: "en dash", pattern: /–/, fix: "a hyphen in a range, otherwise a comma" },
  { label: "horizontal bar", pattern: /―/, fix: "a comma or period" },
  { label: "curly single quote", pattern: /[‘’]/, fix: "'" },
  { label: "curly double quote", pattern: /[“”]/, fix: '"' },
  { label: "ellipsis glyph", pattern: /…/, fix: "..." },
  { label: "non-breaking or exotic space", pattern: /[\u00A0\u2007\u2008\u2009\u202F\u205F\u3000]/, fix: "a normal space" },
  { label: "zero-width or invisible character", pattern: /[\u200B-\u200D\u2060\uFEFF\u00AD]/, fix: "delete it" },
  { label: "arrow", pattern: /[←-⇿]/, fix: "-> or <-" },
  { label: "minus sign", pattern: /−/, fix: "-" },
  { label: "multiplication sign", pattern: /×/, fix: "x" },
  { label: "inequality glyph", pattern: /[≤≥]/, fix: "<= or >=" },
  { label: "prime", pattern: /[′″]/, fix: "' or \"" },
  { label: "decorative check or cross glyph", pattern: /[✓✗✅❌]/, fix: "plain text" },
];

async function collectSourceFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...(await collectSourceFiles(abs)));
    else if (entry.isFile() && extname(entry.name) === ".ts") results.push(abs);
  }
  return results;
}

/** Every string / template literal in a source file, with its 1-based line. */
export function stringLiterals(fileName: string, content: string): Array<{ line: number; text: string }> {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.ESNext, true);
  const found: Array<{ line: number; text: string }> = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      found.push({ line: line + 1, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

describe("customer-facing copy: no typographic tells in CLI output", () => {
  it("no string or template literal under src/ contains a typographic tell", async () => {
    const files = await collectSourceFiles(srcDir);
    expect(files.length, "should find the CLI source tree").toBeGreaterThan(10);

    const findings: string[] = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const lit of stringLiterals(file, content)) {
        for (const { label, pattern, fix } of TYPOGRAPHIC_TELLS) {
          if (!pattern.test(lit.text)) continue;
          findings.push(
            `${relative(pkgRoot, file)}:${lit.line}  [${label} -> ${fix}]  ${lit.text.trim().slice(0, 100)}`,
          );
          break;
        }
      }
    }

    expect(findings, `Typographic tell in printed copy:\n${findings.join("\n")}`).toHaveLength(0);
  });

  it("every tell in the set is actually detected, one at a time", () => {
    // A pattern set is only as good as its weakest entry, and a typo in one
    // regex would silently stop enforcing that character while the suite stays
    // green. Each entry gets its own literal proving it fires.
    const samples: Array<[string, string]> = [
      ["em dash", "—"],
      ["en dash", "–"],
      ["horizontal bar", "―"],
      ["curly single quote", "’"],
      ["curly double quote", "“"],
      ["ellipsis glyph", "…"],
      ["non-breaking or exotic space", " "],
      ["zero-width or invisible character", "​"],
      ["arrow", "→"],
      ["minus sign", "−"],
      ["multiplication sign", "×"],
      ["inequality glyph", "≤"],
      ["prime", "′"],
      ["decorative check or cross glyph", "✅"],
    ];
    expect(samples.map(([label]) => label)).toEqual(TYPOGRAPHIC_TELLS.map((t) => t.label));

    for (const [label, char] of samples) {
      const matched = TYPOGRAPHIC_TELLS.filter((t) => t.pattern.test(`copy ${char} here`));
      expect(matched.map((t) => t.label), `${label} must be caught`).toContain(label);
    }
  });

  it("the scan reaches literals, and exempts comments", () => {
    // Guards against a scan that silently matches nothing (the failure mode that
    // makes a green gate meaningless). A comment em dash must stay invisible to
    // it, and a literal em dash must be caught.
    const sample = [
      `// a comment with an em dash ${EM_DASH} stays exempt`,
      `/** JSDoc with an em dash ${EM_DASH} stays exempt */`,
      `const shown = "printed copy ${EM_DASH} caught";`,
      "const clean = `template ${x} without one`;",
    ].join("\n");

    const lits = stringLiterals("sample.ts", sample);
    const withEmDash = lits.filter((l) => l.text.includes(EM_DASH));

    expect(lits.length, "the walker must find the literals at all").toBeGreaterThanOrEqual(3);
    expect(withEmDash).toHaveLength(1);
    expect(withEmDash[0]!.text).toContain("printed copy");
  });

  it("finds the literals in the real source tree (the scan is not scanning nothing)", async () => {
    const content = await readFile(resolve(srcDir, "commands", "webhook.ts"), "utf8");
    const lits = stringLiterals("webhook.ts", content);
    expect(lits.length, "webhook.ts is full of help and error strings").toBeGreaterThan(20);
    // This used to also assert the file still held an em dash somewhere outside a
    // literal, as a live proof of the comment exemption. The copy sweep cleaned
    // src comments too, so no real file carries that premise any more; the
    // synthetic sample above owns the exemption proof, which is where it belongs.
  });

  it("leaves the two deliberate non-ASCII characters alone", async () => {
    // The mask glyph and the emoji-reaction example are the reason this set
    // stops where it does. If either ever starts failing, the set has drifted
    // into crying wolf and the change, not the copy, is what is wrong.
    const masked = await readFile(resolve(srcDir, "lib", "config-display.ts"), "utf8");
    expect(masked, "the redaction mask is a functional glyph, not prose").toContain("•");

    const react = await readFile(resolve(srcDir, "commands", "message.ts"), "utf8");
    const reactLits = stringLiterals("message.ts", react);
    const emojiExample = reactLits.filter((l) => /\p{Extended_Pictographic}/u.test(l.text));
    expect(emojiExample.length, "the emoji-reaction help text illustrates its own argument").toBeGreaterThan(0);
    for (const lit of emojiExample) {
      for (const { pattern } of TYPOGRAPHIC_TELLS) expect(pattern.test(lit.text)).toBe(false);
    }
  });
});
