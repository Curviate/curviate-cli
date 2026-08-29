// check:clean — anti-leak guard for the public repo.
//
// Greps the package source (excluding node_modules/, dist/) for patterns
// that must never appear in a public repository:
//   - Internal spec/doc reference codes: FR-N, AC-N, NFR-N, TS-N, ADR-N
//   - Internal path prefixes: sdk/N, api/N, core/N, infra/N, mcp/N, cli/N
//   - Internal doc paths: docs/specs, docs/adr
//   - Bare section markers: §4, §key — a citation whose doc reference was
//     stripped away still points at an internal document structure.
//   - Issue tracker refs: #NNN (3+ digit issue numbers)
//   - Internal policy labels: "Hard Rule" (case-insensitive)
//   - Internal codenames/paths: redarc, rdc_ (not rdc_live_), @curviate/shared, apps/server
//   - Substrate vendor name (assembled from fragments to avoid the literal appearing here)
//
// Scans both extensioned source files (see SCAN_EXTS) and a fixed allowlist
// of extensionless dotfiles (see SCAN_DOTFILES, e.g. .gitignore) — the latter
// exist because Node's path.extname() reports no extension for them
// (extname(".gitignore") === ""), so the extension-based filter alone would
// silently skip a leak sitting in a comment inside one of these files.
//
// Exits 0 when clean, non-zero and prints every offending line when not.
// Wire this as `pnpm check:clean` and invoke it from the prepack / verify:dist flow.
//
// --dist mode: `node scripts/check-clean.mjs --dist` scans ONLY the built
// dist/ output (the default run excludes dist/ entirely) with the identical
// pattern set. Source-level exclusions (e.g. inline comments explaining a
// pattern) don't protect the bundle — a leak can survive minification or be
// re-introduced by a dependency, so the assembled output gets its own pass.
// dist/ must already exist (run `pnpm build` first) — the mode fails closed
// rather than silently reporting 0 hits over a directory that isn't there.
// Chained into `prepack` AFTER the build step so no publish can skip it.
//
// --commits[=<baseRef>] mode: scans this branch's own commit MESSAGES
// (`git log <baseRef>..HEAD`, default baseRef `origin/main`) with the same pattern
// set, plus an AI-authorship-trailer pattern (Claude-Session, Co-Authored-By:
// Claude) that only makes sense for commit metadata. Source/--dist never see
// this: a leaked issue-tracker ref or session trailer can ride into the
// commit message of a fix that correctly stripped the leak from the diff
// itself, and once merged that message is public forever even though every
// other check passed clean. Not chained into `prepack` — publish-time is too
// late, the history is already public by then — this is meant to be run by
// hand (or wired into a pre-merge gate) before a PR lands.
//
// ── What this guard learned from its own holes ──────────────────────────────
// Two failure shapes both looked exactly like a clean pass:
//   1. A citation whose doc reference had been edited away (e.g. "see api/008
//      §F" trimmed down to a bare "§F") still names an internal document
//      structure, but no pattern above could see it — the FR-N/api-N/#NNN
//      patterns all require the doc-reference part that was exactly what got
//      stripped. Fixed by the bare-section-marker pattern.
//   2. A scan that silently touched zero files (a path typo, an extension
//      filter that stopped matching after a build-tool change) reported the
//      same "OK" as a scan that touched everything and found nothing. An
//      empty input set is not evidence of a clean tree; it is evidence the
//      guard never ran. Fixed by refusing (exit non-zero) whenever
//      filesScanned is 0. The same reasoning applies to a file the scanner
//      could not even read: silence there is indistinguishable from clean,
//      so an unreadable file also fails the scan rather than being skipped.
//
// The scanning/verdict logic below is exported as plain functions (not just
// invoked at the top level) specifically so a test can drive it against an
// isolated fixture tree — a subprocess spawn can't easily point this script
// at anything other than the real package root, and the zero-files failure
// mode in particular can only be proven by actually handing the scanner an
// empty directory.

import { readdir, readFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, relative, extname, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const pkgRoot = resolve(__dirname, "..");

// Directories to skip entirely (relative to the scan root).
export const SKIP_DIRS = new Set(["node_modules", "dist"]);

// File extensions to scan. .mts/.cts/.cjs/.map are here for --dist coverage:
// tsup currently emits esm .js only (no sourcemaps, no .d.ts), but a format or
// sourcemap change must not silently drop the emitted artifact out of the
// scanned set.
export const SCAN_EXTS = new Set([".ts", ".mts", ".cts", ".mjs", ".cjs", ".js", ".md", ".json", ".map"]);

// Extensionless files to scan explicitly, matched by exact basename
// (SCAN_EXTS can't catch these — see the module header comment). LICENSE is
// here (security-auditor F2) because it ships in the published
// tarball (see the `files` allowlist in package.json) and extname("LICENSE")
// === "" like every dotfile below, so without this it sat outside BOTH the
// extension filter and the dotfile allowlist — unscanned by this guard and
// by check:copy alike. Proven by mutation: appending the vendor name to
// LICENSE passed every gate green until this fix. Enumerated the rest of the
// `files` array for the same gap: README.md/CHANGELOG.md are already
// extensioned (SCAN_EXTS), dist/ is covered by --dist mode; LICENSE was the
// only unscanned entry.
export const SCAN_DOTFILES = new Set([".gitignore", ".npmrc", ".nvmrc", ".env.example", ".editorconfig", "LICENSE"]);

// The vendor name assembled from parts so the literal never appears in this file.
const vendorName = ["uni", "pi", "le"].join("");

/** @type {Array<{ label: string; pattern: RegExp }>} */
export const PATTERNS = [
  {
    label: "internal spec/doc refs (FR-N, AC-N, NFR-N, TS-N, ADR-N)",
    // Matches: FR-001, AC-003, NFR-001, TS-005, ADR-033
    pattern: /\b(FR|AC|NFR|TS|ADR)-\d+/,
  },
  {
    label: "internal path prefixes (sdk/N, api/N, core/N, infra/N, mcp/N, cli/N)",
    // Matches: sdk/001, api/003, core/002, infra/006, mcp/007, cli/004
    pattern: /\b(sdk|api|core|infra|mcp|cli)\/\d+/,
  },
  {
    label: "internal doc paths (docs/specs, docs/adr)",
    pattern: /docs\/(specs|adr)\b/,
  },
  {
    label: "bare section marker (§4, §key)",
    // A citation whose doc reference has been edited away still points at an
    // internal document; none of the patterns above can see it once the
    // "api/008" (or similar) half is gone and only the "§F" half remains.
    pattern: /§\s*[A-Za-z0-9]/,
  },
  {
    label: "issue tracker refs (#NNN — 3+ digit numbers)",
    // Matches: #289, #123 — but not #12 (2-digit) or markdown list items.
    pattern: /#\d{3,}/,
  },
  {
    label: "internal policy labels (Hard Rule)",
    pattern: /hard\s+rule/i,
  },
  {
    label: "internal codenames (redarc, @curviate/shared, apps/server)",
    // No \b anchors: \b fails to match @curviate/shared when preceded by a
    // non-word char (e.g. a quote), so an actual internal import could slip
    // past. These three tokens are specific enough that false positives are
    // implausible. (The SDK keeps its own separate copy of this scanner.)
    pattern: /redarc|@curviate\/shared|apps\/server/,
  },
  {
    label: "internal key prefix (rdc_ — not a customer key format)",
    // rdc_live_ is a valid customer-facing prefix; rdc_test_/rdc_ alone are internal.
    pattern: /\brdc_(?!live_)/,
  },
  {
    label: "substrate vendor name",
    pattern: new RegExp(vendorName, "i"),
  },
  {
    label: "AI-authorship trailer (Claude-Session, Co-Authored-By: Claude)",
    // Never a legitimate part of published source or a commit message here —
    // see CLAUDE.md's Conventions: commits carry no AI-naming trailers.
    pattern: /claude-session\s*:|co-authored-by:\s*claude/i,
  },
  {
    label: "npm auth token (credential shape)",
    // Classic granular npm auth tokens are "npm_" + 36+ base62 chars (qa,
    // cycle 3: exactly-36 missed a real longer token) — the shape an
    // accidentally-committed .npmrc `//registry.npmjs.org/:_authToken=` line
    // carries. Also matches the legacy pre-granular token shape, a bare UUID,
    // which carries no "npm_" prefix at all — keyed off the `_authToken=`
    // assignment itself (not a bare UUID anywhere) so an unrelated UUID in
    // ordinary code, e.g. a request id, is not a false positive. Verified
    // clean against npm_config_*/npm_package_*/npm_lifecycle_* prose, none of
    // which contain a 20+ char unbroken alnum run after the underscore.
    // Probed directly (security-auditor F3): a fixture .npmrc with one of
    // these scanned clean before this pattern existed.
    pattern:
      /\bnpm_[A-Za-z0-9]{36,}\b|_authToken\s*=\s*(?:npm_[A-Za-z0-9]{20,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  },
];

/**
 * Recursively collect files under `dir`, skipping `skipDirs` and keeping only
 * `scanExts`/`scanDotfiles` members.
 * @param {string} dir absolute path to walk
 * @param {{ skipDirs?: Set<string>; scanExts?: Set<string>; scanDotfiles?: Set<string>; root?: string }} [opts]
 *   `root` is the base relative-path skip checks are computed against;
 *   defaults to `dir` itself (the top of the walk).
 * @returns {Promise<string[]>} absolute file paths
 */
export async function collectFiles(dir, opts = {}) {
  const { skipDirs = SKIP_DIRS, scanExts = SCAN_EXTS, scanDotfiles = SCAN_DOTFILES, root = dir } = opts;
  const results = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const rel = relative(root, abs);
    if (entry.isDirectory()) {
      // Skip directories in the exclusion set (check both the name and relative path).
      if (skipDirs.has(entry.name) || skipDirs.has(rel)) continue;
      results.push(...(await collectFiles(abs, { skipDirs, scanExts, scanDotfiles, root })));
    } else if (
      entry.isFile() &&
      (scanExts.has(extname(entry.name)) || scanDotfiles.has(entry.name))
    ) {
      results.push(abs);
    }
  }
  return results;
}

/**
 * @typedef {{ rel: string; line: number; label: string; text: string }} Finding
 * @typedef {{ filesScanned: number; linesScanned: number; findings: Finding[]; unreadable: string[] }} ScanResult
 */

/**
 * Walk `root` and test every scanned line against `patterns`. Pure function
 * of its inputs (reads files, has no other side effects) so a test can point
 * it at an isolated fixture directory — the property under test here (an
 * empty or unreadable input set) has to be real, not simulated, or the test
 * proves nothing about the actual walk.
 *
 * @param {string} root absolute path to scan
 * @param {{
 *   patterns?: Array<{ label: string; pattern: RegExp }>;
 *   skipDirs?: Set<string>;
 *   scanExts?: Set<string>;
 *   scanDotfiles?: Set<string>;
 *   selfExcludeRel?: string;
 *   maxLineLen?: number;
 * }} [opts]
 * @returns {Promise<ScanResult>}
 */
export async function scanDirectory(root, opts = {}) {
  const {
    patterns = PATTERNS,
    skipDirs = SKIP_DIRS,
    scanExts = SCAN_EXTS,
    scanDotfiles = SCAN_DOTFILES,
    selfExcludeRel = "scripts/check-clean.mjs",
    maxLineLen = 200,
  } = opts;

  const files = await collectFiles(root, { skipDirs, scanExts, scanDotfiles, root });

  let filesScanned = 0;
  let linesScanned = 0;
  /** @type {Finding[]} */
  const findings = [];
  /** @type {string[]} */
  const unreadable = [];

  for (const file of files) {
    const rel = relative(root, file);
    // Skip this script itself (it deliberately contains pattern fragments,
    // e.g. example issue numbers in comments).
    if (rel === selfExcludeRel) continue;

    let content;
    try {
      content = await readFile(file, "utf8");
    } catch {
      // A file that could not be READ is a member the input set lost. Record
      // it rather than silently dropping it: silence here is indistinguishable
      // from clean.
      unreadable.push(rel);
      continue;
    }

    filesScanned++;
    const lines = content.split("\n");
    linesScanned += lines.length;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      for (const { label, pattern } of patterns) {
        if (pattern.test(line)) {
          // A minified bundle or a sourcemap is one enormous line; cap what
          // gets printed/returned to something a terminal (and a test
          // assertion) can actually use.
          findings.push({ rel, line: i + 1, label, text: line.trim().slice(0, maxLineLen) });
          break; // one label per line is enough
        }
      }
    }
  }

  return { filesScanned, linesScanned, findings, unreadable };
}

/**
 * Scan this branch's own commit MESSAGES (`git log <baseRef>..HEAD`) with
 * the same pattern set. A leak here survives even a perfectly clean source
 * scan: the diff itself can strip every internal reference while the commit
 * that made that fix still describes it using one.
 *
 * `root` must be inside a git worktree. A `baseRef` that doesn't resolve
 * (typo, shallow clone missing it) is reported as an error rather than
 * silently scanning zero commits — same "silence is not evidence of clean"
 * reasoning as the file scanner's unreadable/empty-scan cases.
 *
 * @param {string} root
 * @param {{ patterns?: Pattern[]; baseRef?: string; maxLineLen?: number }} [opts]
 */
export async function scanCommitMessages(root, opts = {}) {
  const { patterns = PATTERNS, baseRef = "origin/main", maxLineLen = 200 } = opts;

  let hashes;
  try {
    const out = execFileSync("git", ["rev-list", `${baseRef}..HEAD`], {
      cwd: root,
      encoding: "utf8",
    });
    hashes = out.split("\n").filter(Boolean);
  } catch (err) {
    return { commitsScanned: 0, findings: [], error: `could not resolve ${baseRef}..HEAD: ${err.message}` };
  }

  const findings = [];
  for (const hash of hashes) {
    const message = execFileSync("git", ["show", "-s", "--format=%B", hash], {
      cwd: root,
      encoding: "utf8",
    });
    const lines = message.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const { label, pattern } of patterns) {
        if (pattern.test(line)) {
          findings.push({
            rel: `commit ${hash.slice(0, 7)}`,
            line: i + 1,
            label,
            text: line.trim().slice(0, maxLineLen),
          });
          break;
        }
      }
    }
  }

  return { commitsScanned: hashes.length, findings, error: null };
}

/**
 * @typedef {{ ok: true; reason: "clean" } | { ok: false; reason: "empty-scan" | "unreadable" | "leaks" }} Verdict
 */

/**
 * Turn a {@link ScanResult} into a pass/fail verdict.
 *
 * A scan that touched zero files is a FAIL, not a pass — see the module
 * header. Checked before `findings` so an empty scan is never reported as
 * "0 leaks found" (true, but not the actual problem). An unreadable file is
 * checked first of all: it is the same "the guard didn't really run" shape,
 * just for one file instead of the whole tree.
 *
 * @param {ScanResult} result
 * @returns {Verdict}
 */
export function verdict(result) {
  if (result.unreadable.length > 0) return { ok: false, reason: "unreadable" };
  if (result.filesScanned === 0) return { ok: false, reason: "empty-scan" };
  if (result.findings.length > 0) return { ok: false, reason: "leaks" };
  return { ok: true, reason: "clean" };
}

/**
 * @typedef {{ ok: true; reason: "clean" } | { ok: false; reason: "error" | "leaks" }} CommitVerdict
 */

/**
 * Turn a {@link scanCommitMessages} result into a pass/fail verdict. Unlike
 * the file scanner, zero commits scanned is not itself a failure (a branch
 * with no commits yet, or already fast-forwarded, is legitimately clean) —
 * only an unresolved `baseRef` (`result.error`) is.
 *
 * @param {{ error: string | null; findings: Finding[] }} result
 * @returns {CommitVerdict}
 */
export function commitVerdict(result) {
  if (result.error) return { ok: false, reason: "error" };
  if (result.findings.length > 0) return { ok: false, reason: "leaks" };
  return { ok: true, reason: "clean" };
}

/**
 * The CLI entry point: resolve the scan root from argv, run the scan, print
 * the same messages the original script printed, and exit with the same
 * codes. Only invoked when this file is run directly (see the guard at the
 * bottom) — importing this module for its exports (as the test suite does)
 * must never print anything or call process.exit.
 */
async function main() {
  const commitsArg = process.argv.find((a) => a === "--commits" || a.startsWith("--commits="));
  if (commitsArg) {
    const baseRef = commitsArg.includes("=") ? commitsArg.split("=")[1] : "origin/main";
    const result = await scanCommitMessages(pkgRoot, { baseRef });

    for (const f of result.findings) {
      console.error(`LEAK  ${f.rel}:${f.line}  [${f.label}]`);
      console.error(`      ${f.text}`);
    }

    const v = commitVerdict(result);
    if (!v.ok) {
      if (v.reason === "error") {
        console.error(`\ncheck:clean [--commits] FAIL — ${result.error}`);
      } else {
        console.error(
          `\ncheck:clean [--commits] FAIL — ${result.findings.length} leak(s) found across ` +
            `${result.commitsScanned} commit message(s) (${baseRef}..HEAD). Reword before this branch merges.`,
        );
      }
      process.exit(1);
    }

    console.error(
      `check:clean [--commits] OK — no internal references found in ${result.commitsScanned} commit message(s) (${baseRef}..HEAD).`,
    );
    return;
  }

  const distMode = process.argv.includes("--dist");
  const scanRoot = distMode ? join(pkgRoot, "dist") : pkgRoot;
  const modeLabel = distMode ? "--dist" : "source";

  if (distMode) {
    let distStat;
    try {
      distStat = await stat(scanRoot);
    } catch {
      console.error(`check:clean --dist FAIL — dist/ not found at ${scanRoot}. Run \`pnpm build\` first.`);
      process.exit(1);
    }
    if (!distStat.isDirectory()) {
      console.error(`check:clean --dist FAIL — ${scanRoot} exists but is not a directory.`);
      process.exit(1);
    }
  }

  const result = await scanDirectory(scanRoot);

  for (const rel of result.unreadable) {
    console.error(`UNREAD  ${rel}  — could not be read, so it was NOT scanned`);
  }
  for (const f of result.findings) {
    console.error(`LEAK  ${f.rel}:${f.line}  [${f.label}]`);
    console.error(`      ${f.text}`);
  }

  const v = verdict(result);
  if (!v.ok) {
    if (v.reason === "empty-scan") {
      console.error(
        `\ncheck:clean [${modeLabel}] FAIL — scanned ZERO files under ${scanRoot}. ` +
          `An empty scan is not a clean verdict; check the path and the SCAN_EXTS filter.`,
      );
    } else if (v.reason === "unreadable") {
      console.error(
        `\ncheck:clean [${modeLabel}] FAIL — ${result.unreadable.length} file(s) could not be read. ` +
          `An unreadable file was not scanned, so this is not a clean verdict either.`,
      );
    } else {
      console.error(
        `\ncheck:clean [${modeLabel}] FAIL — ${result.findings.length} leak(s) found in ${result.filesScanned} files ` +
          `(${result.linesScanned} lines). Strip the references above before publishing.`,
      );
    }
    process.exit(1);
  }

  console.error(
    `check:clean [${modeLabel}] OK — no internal references found in ${result.filesScanned} files (${result.linesScanned} lines).`,
  );
}

// Run only when invoked directly (`node scripts/check-clean.mjs`), never on
// import — the test suite imports the functions above against isolated
// fixture trees and must not trigger process.exit or console output as a
// side effect of that import.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
