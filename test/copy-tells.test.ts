/**
 * No em dash in anything the CLI prints.
 *
 * An em dash in customer-facing copy reads as machine-generated. Comments and
 * JSDoc are exempt, so a line-based grep is the wrong instrument: it flags the
 * dozens of legitimate em dashes in this package's own prose and misses nothing
 * useful. This walks the TypeScript AST instead, so only string and template
 * literals are inspected - comments are trivia and never become nodes, which is
 * exactly the exemption, obtained structurally rather than by a heuristic.
 *
 * Scope is `src/**` because citty renders help directly from the `meta` and
 * `args` description strings that live there, and every error message the CLI
 * writes is a literal in the same tree: what is in a src literal IS what the
 * user reads.
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

describe("customer-facing copy: no em dash in CLI output", () => {
  it("no string or template literal under src/ contains an em dash", async () => {
    const files = await collectSourceFiles(srcDir);
    expect(files.length, "should find the CLI source tree").toBeGreaterThan(10);

    const findings: string[] = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const lit of stringLiterals(file, content)) {
        if (lit.text.includes(EM_DASH)) {
          findings.push(`${relative(pkgRoot, file)}:${lit.line}  ${lit.text.trim().slice(0, 100)}`);
        }
      }
    }

    expect(
      findings,
      `Em dash in printed copy (use a comma, semicolon, or period):\n${findings.join("\n")}`,
    ).toHaveLength(0);
  });

  it("the scan actually reaches literals, and exempts comments", () => {
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
    // The file's comment block is dense with em dashes; none may leak into the
    // literal set, or the exemption is broken.
    expect(content).toContain(EM_DASH);
  });
});
