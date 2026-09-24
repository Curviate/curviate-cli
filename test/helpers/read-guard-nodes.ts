/**
 * HOUSE-PATTERN LINT ONLY (qa cycle 2 amendment)
 * — feeds `readable-object-guard-source.test.ts`, a fast, no-server,
 * no-build lint for the common `const IDENT = await ns.x.y(...);
 * renderSuccess(IDENT, ...)` shape. It is NOT the authority on guard
 * coverage; that is the runtime sweep in `readable-object-null-exit7-bin
 * .test.ts` (`live-command-sweep.ts`), which invokes the live command
 * registry against a stub and reads actual exit codes, so it is immune to
 * every code-shape blind spot below. Keep this file's checks passing (it
 * catches the common case in milliseconds), but its silence is never proof
 * of coverage on its own.
 *
 * The single-object read surface, at CALL-SITE granularity — not per
 * function, and not keyed on whether the enclosing function calls
 * `streamAll`: a function can mix a paginated branch (`streamAll`, guarded
 * by `readablePage`) with a plain single-object branch in a SIBLING branch
 * of the same `if`/`else if` chain (`profile <id>`, `profile me`). Gating
 * candidacy on "does the whole function avoid `streamAll`" excluded the
 * entire function, plain branch included, the moment any branch used it.
 *
 * Every `renderSuccess(IDENT, ...)` call site in `src/commands/*.ts` is
 * found via a real TypeScript AST walk (not a brace-counting regex — see
 * `scanRenderSuccessCallSites`'s doc for the two real mis-extractions that
 * caused). For each, `IDENT`'s nearest preceding declaration/reassignment
 * in the same function is traced by source position (the sequential
 * `if`/`else if` branch shape this codebase uses means "nearest preceding
 * position" tracks lexical scope correctly here — each branch declares and
 * consumes its own `const result`, adjacent in the file).
 *
 * A call site is a `readableObject` candidate when either:
 *   - its enclosing function never mentions `preview` (a read does not
 *     declare `--preview`, so its handler has no preview branch; the
 *     dispatcher refuses the flag) — applied per call site, not as a
 *     whole-function gate; or
 *   - its traced initializer is one of `KNOWN_NON_REJECTING_SDK_CALLS`
 *     below: reads that accept `--preview` and check it inline, verified against the vendored OpenAPI fixture
 *     to always return a real object (no `204`), so a malformed body is a
 *     platform fault regardless of the R/W label. Named by exact SDK call,
 *     not a name guess — see that constant's doc for why this can't safely
 *     widen further: this codebase's genuine writes use the IDENTICAL
 *     inline-preview shape (`if (flags.preview) { buildPreviewOutput...
 *     return; }` then a bare `await ns.X.Y(...)` rendered directly), and
 *     many resolve to an equally "object" OpenAPI shape (an update/delete
 *     that echoes the mutated resource) — response shape alone cannot tell
 *     "poll queried a stateful resource" from "this mutated one and
 *     handed the result back", only the exact operation identity can.
 *
 * EXCLUDED regardless of the above: a call site whose traced window (decl
 * -> render call) already contains `readablePage(IDENT)` — a stronger,
 * already-present guard on the identical value (`account seats`,
 * `recruiter applicants`); adding `readableObject` on top would be dead
 * code validating an already-validated value.
 *
 * The source-check test verifies call-site PAIRING, not mere presence:
 * `readableObject(IDENT)` must appear, with the SAME identifier text, in
 * this call site's own traced window — `readableObject` called on a
 * different value entirely (qa arm D) fails this, where a body-wide
 * "does `readableObject(` appear anywhere" check would not.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const commandsDir = join(__dirname, "../../src/commands");

export type RenderCallSite = {
  file: string;
  fn: string;
  /** The exact text of `renderSuccess`'s first argument, e.g. "result". */
  argText: string;
  /** True if the enclosing function never mentions `preview`: a read (reads do not declare --preview). */
  fnIsRead: boolean;
  /** The traced nearest-preceding declaration/reassignment of `argText`, or null if untraceable. */
  tracedInitText: string | null;
  /**
   * The source text window from the traced declaration through this
   * `renderSuccess` call (inclusive) — the reachable span a paired
   * `readableObject(argText)` call must appear in.
   */
  window: string;
};

/**
 * Every `renderSuccess(IDENT, ...)` call site in `src/commands/*.ts`,
 * traced but not yet filtered — callers apply the candidacy rule so the AST
 * walk stays in one place. AST-based, not brace-counting: the earlier
 * regex-based version mis-extracted two real function bodies (a `{` inside
 * a string literal before the real one in `webhook.ts`'s
 * `resolveWebhookBody`, and a `{` inside a return-type object literal
 * before the parameter list's closing `)` in `recruiter.ts`'s
 * `buildRecruiterRef`).
 */
export function scanRenderSuccessCallSites(): RenderCallSite[] {
  const files = readdirSync(commandsDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const out: RenderCallSite[] = [];

  for (const file of files) {
    const src = readFileSync(join(commandsDir, file), "utf8");
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);

    const visitTop = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        scanFunction(node.name.text, node.body);
      }
      ts.forEachChild(node, visitTop);
    };

    function scanFunction(fnName: string, body: ts.Block): void {
      const bodyText = body.getText(sf);
      const fnIsRead = !/\bpreview\b/.test(bodyText);
      const bodyStart = body.getStart(sf);

      // Every declaration/reassignment of a plain identifier within this
      // function, in source order, for nearest-preceding lookup.
      const decls: Array<{ pos: number; name: string; initText: string }> = [];
      const collect = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          decls.push({ pos: node.getStart(sf), name: node.name.text, initText: node.initializer.getText(sf) });
        }
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(node.left)
        ) {
          decls.push({ pos: node.getStart(sf), name: node.left.text, initText: node.right.getText(sf) });
        }
        ts.forEachChild(node, collect);
      };
      collect(body);

      const nearestDecl = (name: string, beforePos: number) => {
        let best: { pos: number; initText: string } | null = null;
        for (const d of decls) {
          if (d.name === name && d.pos < beforePos && (!best || d.pos > best.pos)) best = d;
        }
        return best;
      };

      const visitRender = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "renderSuccess"
        ) {
          const argExpr = node.arguments[0];
          const callPos = node.getStart(sf);
          if (argExpr && ts.isIdentifier(argExpr)) {
            const decl = nearestDecl(argExpr.text, callPos);
            // One level of dependency back-tracing: when the traced value is
            // itself derived from another identifier (`safeResult =
            // reencodeInvitableFollowers(result)`), widen the window to
            // include THAT identifier's own declaration too, so an earlier
            // guard on the underlying value (`readablePage(result)`) is
            // still visible in the window (company.ts's
            // `runCompanyInvitableFollowers`).
            let windowStart = decl ? decl.pos : bodyStart;
            if (decl) {
              const innerMatch = decl.initText.match(/^[\w.]+\(\s*([A-Za-z_$][\w$]*)\s*[,)]/);
              if (innerMatch) {
                const innerDecl = nearestDecl(innerMatch[1]!, decl.pos);
                if (innerDecl) windowStart = innerDecl.pos;
              }
            }
            const window = src.slice(windowStart, node.getEnd());
            out.push({
              file,
              fn: fnName,
              argText: argExpr.text,
              fnIsRead,
              tracedInitText: decl ? decl.initText : null,
              window,
            });
          }
        }
        ts.forEachChild(node, visitRender);
      };
      visitRender(body);
    }

    visitTop(sf);
  }

  return out;
}

/**
 * Reads that accept `--preview` and check it inline (`buildPreviewOutput`),
 * so the primary per-function signal (no `preview` mention) cannot
 * see them — found by code review, not exhaustively
 * enumerable from source shape alone (see this module's doc for why). Each
 * verified against `test/fixtures/openapi.json`: the operation's response
 * only ever declares `200: object` (no `204`), so a malformed body is a
 * platform fault on every call, independent of the R/W label.
 *
 *   - `client.auth.getSession(` — `account connect-session poll` (plain branch)
 *   - `client.auth.pollCheckpoint(` — `account checkpoint poll` (plain branch)
 *   - `client.auth.solveCheckpoint(` — `account checkpoint solve`
 */
const KNOWN_NON_REJECTING_SDK_CALLS = [
  "client.auth.getSession(",
  "client.auth.pollCheckpoint(",
  "client.auth.solveCheckpoint(",
];

function isCandidate(site: RenderCallSite): boolean {
  if (site.tracedInitText === null) return false;
  // Already covered by a stronger, already-present guard reachable in this
  // window: a second, weaker guard would be dead code. Checked by mere
  // presence of a `readablePage(` call anywhere in the window, not tied to
  // the exact rendered identifier: the guarded value sometimes flows
  // through an intermediate transform before render (company.ts's
  // `safeResult = reencodeInvitableFollowers(result)`, itself downstream of
  // `readablePage(result)`), and sometimes IS the assignment
  // (`result = readablePage(await ...)`, account.ts's `account seats`).
  if (/readablePage\s*\(/.test(site.window)) return false;
  if (site.fnIsRead) return true;
  return KNOWN_NON_REJECTING_SDK_CALLS.some((call) => site.tracedInitText!.includes(call));
}

/**
 * The call sites that must pair a `readableObject(IDENT)` call with their
 * `renderSuccess(IDENT, ...)`. House-pattern lint only (see module doc) —
 * `readable-object-null-exit7-bin.test.ts`'s runtime sweep is the coverage
 * authority, and does not consume this function.
 */
export function deriveGuardCallSites(): RenderCallSite[] {
  return scanRenderSuccessCallSites().filter(isCandidate);
}
