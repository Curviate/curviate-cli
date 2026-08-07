// check:copy — copy-quality guard for the prose on the npm package page.
//
// npm renders README.md and CHANGELOG.md on the package page, and package.json's
// description sits under the title in search results. That is the first prose a
// prospective consumer reads, so it gets a gate the same way the
// internal-reference leak scan does.
//
// SCOPE, and why it stops where it does. This checks the npm-page copy only.
// The other half of what a user reads is the help and error text in src/, and
// that is already gated, more precisely, by test/copy-tells.test.ts: it walks
// the TypeScript AST so it inspects string and template literals and nothing
// else. Comments never become AST nodes, which is the exemption obtained
// structurally. A regex over src/ cannot make that distinction and would red on
// internal comments, which tsup strips from the bundle and which CLAUDE.md
// exempts. Two instruments, each pointed at what it can actually judge.
//
// TWO TIERS, and the split is deliberate.
//
//   BLOCKING — non-ASCII typographic characters (em/en dash, curly quotes, the
//   ellipsis glyph, non-breaking and zero-width spaces, arrows, math symbols).
//   Every one is mechanically decidable, has an exact ASCII equivalent, and is
//   not something a human typing in an editor produces. A run over clean
//   sources reports zero, so this tier cannot cry wolf.
//
//   WARNING — the LLM vocabulary register ("leverage", "seamless", "robust",
//   "comprehensive", "unlock", ...) and emoji. The register words have
//   legitimate technical uses: an account really can be unlocked, a parser
//   really can be robust. Emoji can be the subject matter rather than
//   decoration, as `post react --emoji` proves by documenting its argument with
//   a literal emoji. Blocking on either would red a release that is fine, and a
//   gate that reds on a fine release is a gate people learn to bypass, taking
//   the typographic tier down with it. So these are reported and the run still
//   exits 0. A human decides.
//
// U+2022 BULLET is absent from both tiers: `config list` uses it as the mask
// glyph for a redacted API key, which is function, not prose.
//
// Usage:  node scripts/check-copy.mjs [--verbose]
// Exits non-zero when a blocking tell is found, and prints every offending
// file:line. Chained into prepack so no publish can skip it.

import { readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const verbose = process.argv.includes("--verbose");

/** The published copy surfaces, in the order a consumer meets them. */
const TARGETS = ["README.md", "CHANGELOG.md", "package.json"];

/**
 * Blocking tier. Each entry names a non-ASCII typographic character with a
 * plain-ASCII replacement, so a hit is always actionable and never a judgment
 * call.
 * @type {Array<{ label: string; pattern: RegExp; fix: string }>}
 */
const TYPOGRAPHIC = [
  { label: "em dash (U+2014)", pattern: /—/, fix: "a comma, semicolon, colon, or period" },
  { label: "en dash (U+2013)", pattern: /–/, fix: "a hyphen in a range, otherwise a comma" },
  { label: "horizontal bar (U+2015)", pattern: /―/, fix: "a comma or period" },
  { label: "curly single quote (U+2018/U+2019)", pattern: /[‘’]/, fix: "'" },
  { label: "curly double quote (U+201C/U+201D)", pattern: /[“”]/, fix: '"' },
  { label: "ellipsis glyph (U+2026)", pattern: /…/, fix: "..." },
  { label: "non-breaking or exotic space", pattern: /[\u00A0\u2007\u2008\u2009\u202F\u205F\u3000]/, fix: "a normal space" },
  { label: "zero-width or invisible character", pattern: /[\u200B-\u200D\u2060\uFEFF\u00AD]/, fix: "delete it" },
  { label: "arrow (U+2190-U+21FF)", pattern: /[←-⇿]/, fix: "-> or <-" },
  { label: "minus sign (U+2212)", pattern: /−/, fix: "-" },
  { label: "multiplication sign (U+00D7)", pattern: /×/, fix: "x" },
  { label: "inequality glyph (U+2264/U+2265)", pattern: /[≤≥]/, fix: "<= or >=" },
  { label: "prime (U+2032/U+2033)", pattern: /[′″]/, fix: "' or \"" },
  { label: "decorative check or cross glyph", pattern: /[✓✗✅❌]/, fix: "plain text" },
];

/**
 * Warning tier: the LLM vocabulary register, plus emoji. Reported, never
 * blocking, because each has a legitimate use.
 * @type {Array<{ label: string; pattern: RegExp }>}
 */
const REGISTER = [
  // (c), (R) and (TM) are legal marks, not decoration, so they are excluded.
  { label: "emoji (decorative emoji reads as generated; an emoji-valued example does not)", pattern: /(?![\u00A9\u00AE\u2122])\p{Extended_Pictographic}/u },
  { label: "delve", pattern: /\bdelv(e|es|ing|ed)\b/i },
  { label: "leverage (as a verb)", pattern: /\bleverag(e|es|ing|ed)\b/i },
  { label: "seamless", pattern: /\bseamless(ly)?\b/i },
  { label: "robust", pattern: /\brobust(ly|ness)?\b/i },
  { label: "comprehensive", pattern: /\bcomprehensive(ly)?\b/i },
  { label: "elevate", pattern: /\belevat(e|es|ing|ed)\b/i },
  { label: "empower", pattern: /\bempower(s|ing|ed|ment)?\b/i },
  { label: "unlock", pattern: /\bunlock(s|ing|ed)?\b/i },
  { label: "streamline", pattern: /\bstreamlin(e|es|ing|ed)\b/i },
  { label: "cutting-edge", pattern: /\bcutting[- ]edge\b/i },
  { label: "game-changing", pattern: /\bgame[- ]chang(er|ing)\b/i },
  { label: "state-of-the-art / best-in-class / world-class", pattern: /\b(state[- ]of[- ]the[- ]art|best[- ]in[- ]class|world[- ]class)\b/i },
  { label: "revolutionize / supercharge", pattern: /\b(revolutioni[sz]|supercharg)\w*/i },
  { label: "effortless / powerful / intuitive", pattern: /\b(effortless(ly)?|powerful|intuitive(ly)?)\b/i },
  { label: "holistic / synergy / paradigm / tapestry", pattern: /\b(holistic\w*|synerg\w+|paradigm|tapestry)\b/i },
  { label: "plethora / myriad", pattern: /\b(plethora|myriad)\b/i },
  { label: "utilize (prefer 'use')", pattern: /\butiliz(e|es|ing|ed|ation)\b/i },
  { label: "facilitate / foster", pattern: /\b(facilitat(e|es|ing|ed)|foster(s|ing|ed)?)\b/i },
  { label: "it's worth noting", pattern: /\b(it'?s|its) worth noting\b/i },
  { label: "in today's ...", pattern: /\bin today'?s\b/i },
  { label: "dive in / deep dive", pattern: /\b(dive in|deep dive|let'?s dive)\b/i },
  { label: "realm of / landscape of / testament to", pattern: /\b(realm of|landscape of|testament to)\b/i },
  { label: '"not just X, it\'s Y"', pattern: /\bnot (just|only) [^.\n]{1,60}\b(but|it'?s)\b/i },
  { label: "whether you're ...", pattern: /\bwhether you'?re\b/i },
  { label: "a wide range / variety of", pattern: /\b(a )?wide (range|variety) of\b/i },
  { label: "paragraph opening with a connective", pattern: /^\s*(Moreover|Furthermore|Additionally|In conclusion|Notably)\b/ },
];

let blocking = 0;
let scannedLines = 0;
const warnings = new Map();

for (const target of TARGETS) {
  let content;
  try {
    content = await readFile(join(pkgRoot, target), "utf8");
  } catch {
    // A published surface that has gone missing is itself a problem worth
    // failing on, rather than a file the scan quietly skips.
    console.error(`check:copy FAIL — ${target} is missing; it is part of the published package.`);
    process.exit(1);
  }

  const lines = content.split("\n");
  scannedLines += lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { label, pattern, fix } of TYPOGRAPHIC) {
      if (!pattern.test(line)) continue;
      console.error(`TELL  ${target}:${i + 1}  [${label}]  use ${fix}`);
      console.error(`      ${line.trim()}`);
      blocking++;
      break;
    }
    for (const { label, pattern } of REGISTER) {
      if (!pattern.test(line)) continue;
      if (!warnings.has(label)) warnings.set(label, []);
      warnings.get(label).push(`${target}:${i + 1}  ${line.trim()}`);
    }
  }
}

// A scan that reads nothing reports zero and looks like a pass. Refuse to.
if (scannedLines < 50) {
  console.error(`check:copy FAIL — only ${scannedLines} lines scanned; the published copy cannot be that short.`);
  process.exit(1);
}

if (warnings.size > 0) {
  console.error(`\ncheck:copy WARN — wording worth a second look (not blocking):`);
  for (const [label, hits] of warnings) {
    console.error(`  ${label} (${hits.length})`);
    for (const hit of verbose ? hits : hits.slice(0, 3)) console.error(`      ${hit}`);
    if (!verbose && hits.length > 3) console.error(`      ... ${hits.length - 3} more (run with --verbose)`);
  }
  console.error(`  These all have legitimate uses, so they never fail the run. Read them and decide.`);
}

if (blocking > 0) {
  console.error(
    `\ncheck:copy FAIL — ${blocking} typographic tell(s). Every one has a plain-ASCII equivalent; replace them before publishing.`,
  );
  process.exit(1);
}

console.error(`check:copy OK — no typographic tells across ${scannedLines} lines of published copy.`);
