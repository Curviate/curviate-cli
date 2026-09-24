/**
 * Every conditional requirement a handler enforces (one-of, a --body-file
 * alternative, at-least-one, "required when/with/for", "requires --x") is
 * stated in a `meta.requires` entry of a command in the same file, so
 * `--help` and the docs page say it before a caller trips it. A source scan:
 * each such error string's flags must all appear in one `requires` entry of
 * that file. Unconditional requirements are flag declarations
 * (`required: true`) and are covered by required-flags-bin.test.ts.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { pkgRoot } from "./helpers/built-cli.js";

/** The conditional shapes: an alternative, a condition, or "at least one". */
export const CONDITIONAL = /\bor\b[^.]*\bis required|is required \(or |at least one|required (when|with|for)|requires --|\(or --/i;

const DIR = join(pkgRoot, "src/commands");

function scan(file: string): { messages: string[]; requires: string[]; declared: Set<string> } {
  const src = readFileSync(join(DIR, file), "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const messages: string[] = [];
  const requires: string[] = [];
  /** Flags some command in this file declares `required: true` (unconditional). */
  const declared = new Set<string>();
  const text = (n: ts.Node): string | null =>
    ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : ts.isTemplateExpression(n) ? n.getText(sf) : null;
  const visit = (n: ts.Node, inDescription: boolean, inRequires: boolean): void => {
    if (ts.isPropertyAssignment(n)) {
      const key = n.name.getText(sf);
      if (
        ts.isObjectLiteralExpression(n.initializer) &&
        n.initializer.properties.some((p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === "required" && p.initializer.kind === ts.SyntaxKind.TrueKeyword)
      ) {
        declared.add(`--${key.replace(/^["']|["']$/g, "")}`);
      }
      if (key === "description" || key === "examples") return visit(n.initializer, true, false);
      if (key === "requires") return visit(n.initializer, false, true);
    }
    const t = text(n);
    if (t !== null) {
      if (inRequires) requires.push(t);
      else if (!inDescription && CONDITIONAL.test(t) && /--[a-z]/.test(t)) messages.push(t);
      return;
    }
    ts.forEachChild(n, (c) => visit(c, inDescription, inRequires));
  };
  visit(sf, false, false);
  return { messages, requires, declared };
}

const flagsOf = (s: string) => [...new Set(s.match(/--[a-z][a-z-]*/g) ?? [])];

describe("meta.requires covers every conditional requirement a handler enforces", () => {
  it("each conditional error message's flags appear together in one requires entry of its file", () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith(".ts"));
    const all = files.map((f) => ({ f, ...scan(f) }));
    // Non-vacuous: the scan finds the known handler messages.
    expect(all.flatMap((x) => x.messages).length).toBeGreaterThan(10);
    const uncovered = all.flatMap(({ f, messages, requires, declared }) =>
      messages
        // A message about a flag declared required is the unconditional case.
        .filter((m) => !declared.has(flagsOf(m)[0]!))
        .filter((m) => !requires.some((r) => flagsOf(m).every((flag) => r.includes(flag))))
        .map((m) => `${f}: ${m.slice(0, 120)}`),
    );
    expect(uncovered).toEqual([]);
  });

  it("the shape matcher recognises each conditional form, and not an unconditional one (self-test)", () => {
    for (const m of [
      "error: --job-title (a free-text name) or --job-title-id is required.",
      "error: ${flagDesc} is required (or ${key} in --body-file/--body -).",
      "error: nothing to update. Pass at least one of --first-name, --last-name.",
      "--website-url (required when --apply-method is external)",
      "error: --seat-id is required with --preview, which does not call the API.",
      "--budget-currency (required for a paid publish)",
      "--li-at-stdin requires --auth-method cookie",
    ]) expect(m).toMatch(CONDITIONAL);
    expect("error: --state is required.").not.toMatch(CONDITIONAL);
  });
});
