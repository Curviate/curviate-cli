/** String and template literals of a TypeScript source (comments are trivia), and every `.ts` file under a directory. */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

export function literals(file: string, content: string): Array<{ line: number; text: string }> {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.ESNext, true);
  const out: Array<{ line: number; text: string }> = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text: n.text });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export const walkTs = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkTs(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
