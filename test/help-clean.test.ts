/**
 * Help-clean test — asserts the CLI's user-visible strings (help text,
 * descriptions, flag descriptions, error messages) are free of vendor names
 * and internal references.
 *
 * Strategy: scan the TypeScript source under src/ for leak patterns instead
 * of spawning subprocesses. This is equivalent because citty renders help
 * directly from the command meta.description and args description strings
 * that live in the source — what is in the source IS what the user sees.
 *
 * The full binary smoke (subprocess --help for several commands) is covered
 * by scripts/verify-dist.mjs, which runs outside vitest and does not have
 * the subprocess-output-capture limitations of the vitest worker context.
 */

import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, extname, relative } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const srcDir = resolve(pkgRoot, "src");

// ---------------------------------------------------------------------------
// Vendor/internal leak patterns (mirror of scripts/check-clean.mjs).
// Patterns assembled from fragments so the literals never appear in this file.
// ---------------------------------------------------------------------------

const vendorName = ["uni", "pi", "le"].join("");
// Codename pattern mirrors scripts/check-clean.mjs. No \b anchors: the boundary
// fails to match the scoped-package codename when it is preceded by a non-word
// char (a quote, an import path separator), which would let a real internal
// import slip past — so the three tokens match unanchored. They are specific
// enough that a false positive is implausible. Fragments are concatenated so
// the literals never appear in this file.
const codenamePat = new RegExp(
  ["red" + "arc", "@curviate/" + "shared", "apps/" + "server"].join("|"),
);

const LEAK_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "vendor name",          pattern: new RegExp(vendorName, "i") },
  { label: "spec/doc refs",        pattern: /\b(FR|AC|NFR|TS|ADR)-\d+/ },
  { label: "internal path prefix", pattern: /\b(sdk|api|core|infra|mcp|cli)\/\d+/ },
  { label: "internal doc paths",   pattern: /docs\/(specs|adr)\b/ },
  // A citation whose doc-reference half has been edited away (a "doc path
  // plus section marker" trimmed down to just the bare marker) still names
  // an internal document structure, but none of the patterns above can see
  // it once the doc-reference half is gone. Mirrors scripts/check-clean.mjs's
  // identical fix.
  { label: "bare section marker",  pattern: /§\s*[A-Za-z0-9]/ },
  { label: "issue tracker refs",   pattern: /#\d{3,}/ },
  { label: "internal policy labels", pattern: /hard\s+rule/i },
  { label: "internal codenames",   pattern: codenamePat },
  { label: "internal key prefix",  pattern: /\brdc_(?!live_)/ },
];

// ---------------------------------------------------------------------------
// File collection helpers
// ---------------------------------------------------------------------------

async function collectSourceFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectSourceFiles(abs)));
    } else if (entry.isFile() && extname(entry.name) === ".ts") {
      results.push(abs);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("help output — leak-clean across command source", () => {
  it("all src/**/*.ts files are free of vendor/internal-ref leaks", async () => {
    const files = await collectSourceFiles(srcDir);
    expect(files.length, "should find at least 10 source files").toBeGreaterThan(10);

    const findings: string[] = [];

    for (const file of files) {
      const content = await readFile(file, "utf8");
      const lines = content.split("\n");
      const rel = relative(pkgRoot, file);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        for (const { label, pattern } of LEAK_PATTERNS) {
          if (pattern.test(line)) {
            findings.push(`${rel}:${i + 1}  [${label}]  ${line.trim().slice(0, 100)}`);
            break; // one finding per line
          }
        }
      }
    }

    expect(
      findings,
      `Source contains vendor/internal references in help strings:\n${findings.join("\n")}`,
    ).toHaveLength(0);
  });

  it("README.md is free of vendor/internal-ref leaks", async () => {
    const readmePath = resolve(pkgRoot, "README.md");
    const content = await readFile(readmePath, "utf8");
    // An empty (or truncated) read would make "0 findings" a false assurance
    // rather than a real clean verdict — the same failure shape check:clean's
    // zero-files guard exists to catch, one file lower.
    expect(content.length, "README.md should not read back empty/truncated").toBeGreaterThan(500);
    const lines = content.split("\n");

    const findings: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const { label, pattern } of LEAK_PATTERNS) {
        if (pattern.test(line)) {
          findings.push(`README.md:${i + 1}  [${label}]  ${line.trim().slice(0, 100)}`);
          break;
        }
      }
    }

    expect(
      findings,
      `README.md contains vendor/internal references:\n${findings.join("\n")}`,
    ).toHaveLength(0);
  });

  it("README.md contains install section (npm install and npx)", async () => {
    const content = await readFile(resolve(pkgRoot, "README.md"), "utf8");
    expect(content).toMatch(/npm install.*@curviate\/cli/i);
    expect(content).toMatch(/npx.*@curviate\/cli/i);
  });

  it("README.md contains auth section (API key env + login command)", async () => {
    const content = await readFile(resolve(pkgRoot, "README.md"), "utf8");
    expect(content).toMatch(/CURVIATE_API_KEY/);
    expect(content).toMatch(/curviate login/);
  });

  it("README.md contains at least 5 fenced bash code block examples", async () => {
    const content = await readFile(resolve(pkgRoot, "README.md"), "utf8");
    // Count bash fenced blocks — each opening ```bash is one example block
    const exampleBlocks = content.match(/```bash/g) ?? [];
    expect(
      exampleBlocks.length,
      `README should have at least 5 fenced bash example blocks, found ${exampleBlocks.length}`,
    ).toBeGreaterThanOrEqual(5);
  });

  it("README.md does not embed real API keys or dry_run tokens", async () => {
    const content = await readFile(resolve(pkgRoot, "README.md"), "utf8");
    // A real key longer than 10 chars after the live prefix must not appear in examples
    expect(content).not.toMatch(/rdc_live_\w{10,}/);
    // No server-side preview parameter (removed from the API)
    expect(content).not.toMatch(/dry[_-]run/i);
  });
});
