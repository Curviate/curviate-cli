// check:sdk-pin — construction-level SDK coupling guard.
//
// `@curviate/cli@0.24.0` declared `"@curviate/sdk":
// "^0.23.0"`. On a 0.x package npm's caret pins the minor
// (`>=0.23.0 <0.24.0`), so the published tarball could never resolve the
// registry's actual latest (`0.24.2`) — every release, the floor was
// hand-bumped and drifted a minor behind. The declared range is now an EXACT
// pin (CLAUDE.md decision: the CLI is compiler-coupled to one SDK build), so
// any mismatch between what's declared and what's actually installed is a
// defect, not merely worth a note.
//
// This guard is deliberately NOT a manifest-string check. A regex over
// package.json inspects intent; this bug was only provable by looking at
// what actually gets BUNDLED — the resolved package under node_modules. So
// this reads the real installed `node_modules/@curviate/sdk/package.json`
// version and compares it against the declared dependency string. A guard
// that only read package.json could not have caught it and must not be
// what ships here.
//
// Usage:  node scripts/check-sdk-pin.mjs
// Exit 0 = declared and resolved SDK versions match exactly.
// Exit 1 = mismatch, or the resolved package could not be found/read
//          (fails closed — no node_modules is not a pass).
// Chained into prepack, after check-copy and before the build, so no publish
// can proceed with an SDK pin that doesn't match what's actually installed.

import { readFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const pkgRoot = resolve(__dirname, "..");

/**
 * @param {string} root - package root to check (defaults to this package's root)
 * @returns {Promise<{ ok: boolean, reason: "match" | "mismatch" | "not-exact" | "unresolved", declared: string, resolved: string | null }>}
 */
export async function checkSdkPin(root = pkgRoot) {
  const pkgJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const declared = pkgJson.dependencies?.["@curviate/sdk"];

  if (typeof declared !== "string" || declared.length === 0) {
    return { ok: false, reason: "unresolved", declared: declared ?? "", resolved: null };
  }

  // Exact-pin policy: no range operator.
  if (/^[\^~>=<]/.test(declared)) {
    return { ok: false, reason: "not-exact", declared, resolved: null };
  }

  let resolvedPkg;
  try {
    resolvedPkg = JSON.parse(
      await readFile(join(root, "node_modules", "@curviate", "sdk", "package.json"), "utf8"),
    );
  } catch {
    // Not installed / unreadable — fail closed rather than silently skip.
    return { ok: false, reason: "unresolved", declared, resolved: null };
  }

  const resolved = resolvedPkg.version;
  if (typeof resolved !== "string" || resolved.length === 0) {
    return { ok: false, reason: "unresolved", declared, resolved: null };
  }

  return resolved === declared
    ? { ok: true, reason: "match", declared, resolved }
    : { ok: false, reason: "mismatch", declared, resolved };
}

async function main() {
  const result = await checkSdkPin(pkgRoot);

  if (result.reason === "unresolved") {
    console.error(
      `check:sdk-pin FAIL — could not read the resolved @curviate/sdk version from node_modules. ` +
        `Run \`pnpm install\` first; an uninstalled dependency is not a passing check.`,
    );
    process.exit(1);
  }
  if (result.reason === "not-exact") {
    console.error(
      `check:sdk-pin FAIL — declared @curviate/sdk range "${result.declared}" is not an exact pin. ` +
        `The CLI is compiler-coupled to one SDK build; declare an exact version.`,
    );
    process.exit(1);
  }
  if (result.reason === "mismatch") {
    console.error(
      `check:sdk-pin FAIL — declared @curviate/sdk "${result.declared}" does not match the ` +
        `resolved/installed version "${result.resolved}" in node_modules. Run \`pnpm install\` ` +
        `after bumping the dependency, or the tarball will bundle a different SDK than the one declared.`,
    );
    process.exit(1);
  }

  console.error(`check:sdk-pin OK — declared and resolved @curviate/sdk both at ${result.resolved}.`);
}

// Run only when invoked directly, never on import — the test suite imports
// checkSdkPin against isolated fixture trees and must not trigger
// process.exit or console output as a side effect of that import.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
