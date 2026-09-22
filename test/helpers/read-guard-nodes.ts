/**
 * The single-object read surface for the `readableObject` guard: every
 * command function that calls `rejectPreviewOnRead` (a read), does NOT
 * call `streamAll` (not a paginated list — those already guard via
 * `readablePage`, see `no-page-body-exit7-bin.test.ts`), and calls
 * `renderSuccess` (excludes the binary-download reads, exempt per the
 * exit-code spec's As-built note: they save a 2xx body verbatim and never
 * reach `renderSuccess`).
 * Plus a narrow, explicitly-scoped second signal for two functions that
 * fail that primary test (see `deriveSingleObjectReadFunctions`'s doc).
 *
 * Both derivations happen at test run time, from the source, never a
 * hand-written list:
 *   - the candidate FUNCTION names come from a real TypeScript-AST scan of
 *     every top-level function in `src/commands/*.ts` (not a brace-counting
 *     regex — that mis-locates a body whenever a `{` appears inside a string
 *     literal before the real one, or inside a return-type object literal
 *     before the parameter list's closing `)`; both occur in this codebase
 *     today, confirmed against `resolveWebhookBody` and `buildRecruiterRef`);
 *   - the CLI PATH for each is found by walking the live command tree
 *     (`allNodes`, shared with streaming-nodes.ts) and pattern-matching each
 *     leaf's bound `run` closure source against the candidate names — this
 *     is what that leaf's handler genuinely calls, not a naming guess.
 *
 * Shared by the source-check guard test (function-name granularity, no
 * server) and the bin-level sweep (CLI-path granularity, exercises the real
 * exit code), so a new read is covered by both the moment it exists.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { allNodes, argvFor, type Node } from "./streaming-nodes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const commandsDir = join(__dirname, "../../src/commands");

export type ReadFunction = { file: string; name: string; body: string };

/**
 * Every top-level function in `src/commands/*.ts`, with its AST-extracted
 * body text. Not filtered — callers apply their own predicate so the raw
 * source scan stays in one place.
 */
export function scanCommandFunctions(): ReadFunction[] {
  const files = readdirSync(commandsDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const out: ReadFunction[] = [];
  for (const file of files) {
    const src = readFileSync(join(commandsDir, file), "utf8");
    const sourceFile = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        out.push({ file, name: node.name.text, body: node.body.getText(sourceFile) });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return out;
}

/**
 * The primary signal: calls `rejectPreviewOnRead`, does not call
 * `streamAll`, calls `renderSuccess`, and has not already called
 * `readablePage` (see the exclusion note below). Covers every command that
 * follows the majority "read refuses --preview" convention.
 */
function isPrimarySingleObjectRead(fn: ReadFunction): boolean {
  return (
    /rejectPreviewOnRead\s*\(/.test(fn.body) &&
    !/streamAll\s*\(/.test(fn.body) &&
    /renderSuccess\s*\(/.test(fn.body) &&
    !/readablePage\s*\(/.test(fn.body)
  );
}

/**
 * Two SDK calls found NOT to match the primary signal (code review
 * follow-up): `account connect-session poll` / `account checkpoint poll`
 * (their non-`--wait` branch) allow `--preview` inline (`buildPreviewOutput`)
 * instead of refusing it via `rejectPreviewOnRead` — per the command-surface
 * spec, `checkpoint poll` is even classified `W` (its underlying op is a
 * POST that can transition state) — so the primary signal cannot see them
 * as reads.
 * But both operations' OpenAPI response only ever declares `200: object`
 * (verified against `test/fixtures/openapi.json`; no `204`), i.e. a
 * successful call to either ALWAYS has a real object body — exactly the
 * `readableObject` contract, independent of the R/W label. Named by their
 * exact SDK call (ground truth, not a function-name guess) so this stays
 * precise rather than sweeping in genuine writes that legitimately render a
 * null 204 (which must NOT get this guard).
 */
const KNOWN_NON_REJECTING_SINGLE_OBJECT_READS = ["client.auth.getSession(", "client.auth.pollCheckpoint("];

function isKnownNonRejectingSingleObjectRead(fn: ReadFunction): boolean {
  return (
    !/streamAll\s*\(/.test(fn.body) &&
    /renderSuccess\s*\(/.test(fn.body) &&
    !/readablePage\s*\(/.test(fn.body) &&
    KNOWN_NON_REJECTING_SINGLE_OBJECT_READS.some((call) => fn.body.includes(call))
  );
}

/**
 * The single-object reads that must call `readableObject`: the primary
 * signal, plus the narrow named exception above.
 *
 * One further exclusion, found empirically (not hand-picked): a function
 * that already calls `readablePage` needs nothing added — excluded from
 * BOTH signals above. Two examples: `account seats` (its body IS a page,
 * `{items, ...}`, human mode iterates `result.items`) and `recruiter
 * applicants` (its response is `{object, data: [...], cursor}` per
 * `test/fixtures/openapi.json`, the SDK-paginator page shape `readablePage`
 * already recognizes via its `items`-or-`data` fallback). Both get the same
 * platform-fault contract (null/scalar/array/malformed all throw
 * PLATFORM_ERROR before `renderSuccess` runs) from the stronger guard
 * already in their body, so a second, weaker guard on an already-validated
 * value would be dead code.
 */
export function deriveSingleObjectReadFunctions(): ReadFunction[] {
  const all = scanCommandFunctions();
  return all.filter((fn) => isPrimarySingleObjectRead(fn) || isKnownNonRejectingSingleObjectRead(fn));
}

/**
 * The CLI leaf nodes whose handler delegates to one of
 * `deriveSingleObjectReadFunctions()` — the actual `readableObject`-guarded
 * surface, walked from the live command tree so a new command is picked up
 * automatically.
 */
export async function discoverReadableObjectNodes(): Promise<Node[]> {
  const names = deriveSingleObjectReadFunctions().map((fn) => fn.name);
  const nodes = await allNodes();
  return nodes.filter((n) => {
    if (!n.run) return false;
    const src = n.run.toString();
    // Word-boundary, not a trailing "(": most leaves call their handler
    // directly (`runCompanyGet(...)`), but several pass it BY REFERENCE to a
    // shared dispatcher (`withClient(args, runProfileSsi)`), where the name
    // is never itself followed by "(".
    return names.some((name) => new RegExp(`\\b${name}\\b`).test(src));
  });
}

/**
 * Where the generic `argvFor` (positionals filled only when `required !==
 * false`) would not reach the guarded call: a bare group whose positional is
 * explicitly optional so the SAME command can print multi-subcommand usage
 * when it is omitted (`recruiter project-job`, `recruiter applicant`) rather
 * than a hard usage error. Omitting the id there exits 0 with a usage note,
 * never reaching the read at all — which would silently read as "the guard
 * doesn't apply here" rather than "this argv never asked for a read".
 */
const READ_ARGV_OVERRIDES: Record<string, string[]> = {
  "recruiter project-job": ["recruiter", "project-job", "1"],
  "recruiter applicant": ["recruiter", "applicant", "1", "1"],
};

/** `argvFor`, with the above bare-optional-positional cases corrected. */
export function argvForRead(node: Node): string[] {
  return READ_ARGV_OVERRIDES[node.path.join(" ")] ?? argvFor(node);
}
