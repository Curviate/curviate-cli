/**
 * Mutation-proven coverage for the check:clean leak guard (scripts/check-clean.mjs).
 *
 * The guard had two false-PASS holes, both with the same shape: an input the
 * guard should have flagged instead produced the identical "clean" verdict as
 * an actually-clean tree.
 *
 *   1. A citation whose doc-reference half had been stripped away (e.g. a
 *      "docs path + section marker" reference trimmed down to just the bare
 *      marker) still names an internal document structure, but no existing
 *      pattern could see it once the doc-reference part — the part every
 *      OTHER pattern keys on — was gone.
 *   2. A scan that silently touched zero files (a path typo, a build-tool
 *      change that stopped matching the extension filter) reported the same
 *      "OK — no internal references found" as a scan that touched everything
 *      and genuinely found nothing.
 *
 * A positive control alone does not prove either fix: a fixture string that
 * merely CONTAINS a leak-shaped substring can pass for reasons that have
 * nothing to do with the pattern under test (another pattern in the list
 * happens to catch the same line), and can pass even after the relevant fix
 * is reverted. Each case below is therefore checked twice — once against the
 * real exported PATTERNS/verdict, and once with the specific fix subtracted
 * (a patterns override with that one entry removed, or the pre-fix verdict
 * logic reproduced inline) — to prove the finding genuinely depends on the
 * fix under test, not on some other entry in the list or some other check.
 *
 * A note on the fixture strings themselves: this file is itself part of the
 * scanned tree, so a fixture payload written as a literal contiguous string
 * (e.g. the real two-character marker this guard hunts for) would trip the
 * real repo-wide `pnpm check:clean` run against ITS OWN test data. Every
 * payload below is therefore assembled from concatenated fragments — the
 * same technique scripts/check-clean.mjs uses for the vendor name, and
 * test/help-clean.test.ts uses for its codename pattern — so the string this
 * source file contains is never contiguous, while the file WRITTEN TO DISK
 * at test time (what scanDirectory actually scans) is the real, unbroken
 * leak text.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { scanDirectory, verdict, PATTERNS, pkgRoot } from "../scripts/check-clean.mjs";

// Section-marker character, held one hop away from any digit/letter literal
// so no line in this file itself reads as "§" immediately followed by alnum.
const SECTION_MARK = "§";

const tmpDirs: string[] = [];

async function makeFixtureDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "check-clean-fixture-"));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("check:clean guard — bare section marker (hole 1)", () => {
  it("catches a bare section-marker citation with no doc-reference half", async () => {
    const bareMarker = SECTION_MARK + "F"; // written to disk as one contiguous token
    const dir = await makeFixtureDir({
      "notes.ts": `// ${bareMarker} shape: field + value present\nexport const x = 1;\n`,
    });
    const result = await scanDirectory(dir);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.label).toContain("bare section marker");
    expect(verdict(result)).toEqual({ ok: false, reason: "leaks" });
  });

  it("catches a bare numeric section marker too", async () => {
    const bareMarker = SECTION_MARK + "4";
    const dir = await makeFixtureDir({ "notes.md": `See ${bareMarker} for details.\n` });
    const result = await scanDirectory(dir);
    expect(result.findings).toHaveLength(1);
  });

  it("also catches the marker with whitespace before the alnum (a spaced citation style)", async () => {
    const spacedMarker = SECTION_MARK + " 5";
    const dir = await makeFixtureDir({ "notes.md": `Reference ${spacedMarker} in the appendix.\n` });
    const result = await scanDirectory(dir);
    expect(result.findings).toHaveLength(1);
  });

  it("mutation check: the same fixture is invisible once the bare-section-marker pattern is removed", async () => {
    const bareMarker = SECTION_MARK + "F";
    const dir = await makeFixtureDir({
      "notes.ts": `// ${bareMarker} shape: field + value present\nexport const x = 1;\n`,
    });
    const patternsWithoutBareMarker = PATTERNS.filter(
      (p: { label: string }) => !p.label.includes("bare section marker"),
    );
    const result = await scanDirectory(dir, { patterns: patternsWithoutBareMarker });
    // Proves the finding above genuinely depends on that one pattern's
    // presence, not on some other entry in the list incidentally matching.
    expect(result.findings).toHaveLength(0);
    expect(verdict(result)).toEqual({ ok: true, reason: "clean" });
  });
});

describe("check:clean guard — cli/NNN path-prefix citation", () => {
  it("catches an internal cli-path-plus-number reference", async () => {
    const citation = "cli" + "/004"; // the two fragments join into one contiguous token on disk
    const dir = await makeFixtureDir({
      "notes.ts": `// see ${citation} for the removed-command map\nexport const x = 1;\n`,
    });
    const result = await scanDirectory(dir);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.label).toContain("internal path prefixes");
  });

  it("does not false-positive on a plain subpath with no digit segment", async () => {
    const dir = await makeFixtureDir({
      "notes.ts": "// cli/utils is a real subpath with no digit, not a citation\n",
    });
    const result = await scanDirectory(dir);
    expect(result.findings).toHaveLength(0);
  });

  it("mutation check: a prefix list missing this package's own token misses the identical citation", async () => {
    const citation = "cli" + "/004";
    const dir = await makeFixtureDir({
      "notes.ts": `// see ${citation} for the removed-command map\nexport const x = 1;\n`,
    });
    // Reproduces the historical shape of this exact bug in the sibling sdk
    // package's copy of this guard: the path-prefix alternation listed every
    // OTHER internal package's token but not this package's own, so a
    // citation into this package's own docs sailed through undetected.
    const patternsMissingOwnToken = PATTERNS.map((p: { label: string; pattern: RegExp }) =>
      p.label.includes("internal path prefixes")
        ? { ...p, pattern: /\b(sdk|api|core|infra|mcp)\/\d+/ }
        : p,
    );
    const result = await scanDirectory(dir, { patterns: patternsMissingOwnToken });
    expect(result.findings).toHaveLength(0);
  });
});

describe("check:clean guard — quote-prefixed internal package import", () => {
  it("catches an unspaced, quote-prefixed internal-package import", async () => {
    const pkgName = "@curviate" + "/shared"; // written to disk as one contiguous specifier
    const dir = await makeFixtureDir({
      "leak.ts": `import { thing } from "${pkgName}";\n`,
    });
    const result = await scanDirectory(dir);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.label).toContain("internal codenames");
  });

  it("mutation check: a \\b-anchored version of the same pattern misses the identical import", async () => {
    const pkgName = "@curviate" + "/shared";
    const dir = await makeFixtureDir({
      "leak.ts": `import { thing } from "${pkgName}";\n`,
    });
    // \b requires a word/non-word transition; a quote followed by "@" is
    // non-word/non-word, so an anchored \bPKG\b form never matches here. This
    // is the exact regression the real (unanchored) pattern prevents —
    // reproducing just this one alternative, anchored, proves the lack of
    // anchors is load-bearing, not incidental. (The real pattern has two
    // other alternatives; irrelevant to this fixture, so left out here rather
    // than spelled out as literal text this file would then itself contain.)
    const escapedPkgName = pkgName.replace(/[/@]/g, (c) => `\\${c}`);
    const anchoredPatterns = PATTERNS.map((p: { label: string; pattern: RegExp }) =>
      p.label.includes("internal codenames")
        ? { ...p, pattern: new RegExp(`\\b${escapedPkgName}\\b`) }
        : p,
    );
    const result = await scanDirectory(dir, { patterns: anchoredPatterns });
    expect(result.findings).toHaveLength(0);
  });
});

describe("check:clean guard — zero scannable files fails closed (hole 2)", () => {
  it("an empty directory scans zero files and fails, not passes", async () => {
    const dir = await makeFixtureDir({});
    const result = await scanDirectory(dir);
    expect(result.filesScanned).toBe(0);
    expect(verdict(result)).toEqual({ ok: false, reason: "empty-scan" });
  });

  it("a directory with files, but none of a scanned extension, also fails", async () => {
    const citation = "cli" + "/004";
    const dir = await makeFixtureDir({
      "binary.wasm": "not a scanned extension",
      // Deliberately contains a real leak pattern to prove the failure is
      // about the empty SCANNED set, not a lucky content-based catch.
      "notes.txt": `${citation} sits right here but .txt is not in SCAN_EXTS`,
    });
    const result = await scanDirectory(dir);
    expect(result.filesScanned).toBe(0);
    expect(result.findings).toHaveLength(0); // not caught via content — proves it's the extension filter, not a leak hit
    expect(verdict(result)).toEqual({ ok: false, reason: "empty-scan" });
  });

  it("mutation check: the pre-fix verdict logic (findings-only) really did treat this as OK", async () => {
    const dir = await makeFixtureDir({});
    const result = await scanDirectory(dir);
    // The pre-fix verdict was equivalent to "findings.length > 0 ? FAIL : OK",
    // with no filesScanned check at all. Reproducing that exact rule here
    // proves the fixed verdict() changed the outcome for this input, rather
    // than just adding a branch nothing reaches.
    const preFixVerdictWasOk = result.findings.length === 0;
    expect(preFixVerdictWasOk).toBe(true); // the vacuous-pass condition genuinely fires
    expect(verdict(result).ok).toBe(false); // the fixed verdict() rejects it anyway
  });

  it("a genuinely clean, non-empty fixture tree still passes", async () => {
    const dir = await makeFixtureDir({
      "clean.ts": "export const greeting = 'hello world';\n",
      "readme.md": "# A clean package\n\nNothing to see here.\n",
    });
    const result = await scanDirectory(dir);
    expect(result.filesScanned).toBe(2);
    expect(result.findings).toHaveLength(0);
    expect(verdict(result)).toEqual({ ok: true, reason: "clean" });
  });

  it("skips node_modules/ and dist/ by default rather than reporting them as scanned", async () => {
    const citation = "cli" + "/004";
    const dir = await makeFixtureDir({
      "node_modules/leaky-pkg/index.js": `// ${citation} buried in a dependency\n`,
      "dist/bundle.js": `// ${citation} buried in a build artifact\n`,
      "src/clean.ts": "export const ok = true;\n",
    });
    const result = await scanDirectory(dir);
    expect(result.filesScanned).toBe(1);
    expect(result.findings).toHaveLength(0);
  });
});

describe("check:clean guard — an unreadable file fails closed the same way", () => {
  it("a file with no read permission is reported, not silently skipped", async () => {
    const dir = await makeFixtureDir({ "locked.ts": "export const x = 1;\n" });
    const lockedPath = join(dir, "locked.ts");
    await chmod(lockedPath, 0o000);
    try {
      const result = await scanDirectory(dir);
      expect(result.unreadable).toEqual(["locked.ts"]);
      expect(result.filesScanned).toBe(0);
      expect(verdict(result)).toEqual({ ok: false, reason: "unreadable" });
    } finally {
      // Restore before the afterEach rm(), or cleanup itself can fail.
      await chmod(lockedPath, 0o644);
    }
  });
});

describe("check:clean guard — real invocation against the actual package (integration)", () => {
  it("node scripts/check-clean.mjs exits 0 against the real, currently-clean source tree", () => {
    // Black-box smoke test: proves the CLI entry point (argv handling, exit
    // codes, the "run only when invoked directly" guard) is actually wired
    // up end to end, not just the exported functions in isolation.
    // execFileSync throws on a non-zero exit, which is the failure mode we want.
    expect(() =>
      execFileSync(process.execPath, ["scripts/check-clean.mjs"], {
        cwd: pkgRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).not.toThrow();
  });

  it("importing the module for its exports prints nothing and never exits the process", async () => {
    // If the process.argv[1] "run only when invoked directly" guard at the
    // bottom of check-clean.mjs were ever removed, importing it from this
    // very test would call process.exit and kill the whole vitest worker —
    // so simply reaching this assertion at all is the proof it still holds.
    const mod = await import("../scripts/check-clean.mjs");
    expect(typeof mod.scanDirectory).toBe("function");
    expect(typeof mod.verdict).toBe("function");
    expect(Array.isArray(mod.PATTERNS)).toBe(true);
  });
});
