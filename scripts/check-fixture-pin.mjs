// check:fixture-pin — the vendored OpenAPI fixture must match the pinned SDK.
//
// test/fixtures/openapi.json is a vendored copy of the SDK's
// fixtures/openapi.json (qa BLOCKER: the flag-field-guard test
// used to resolve a relative path into a sibling `sdk` checkout, which does
// not exist in a standalone clone of this repo — exactly what the
// publish-runbook's step 1 produces. `pnpm test` reds gate 4 there: 1926
// passed / 8 failed, not the 1934/1934 a hand-built monorepo layout reported).
//
// Vendoring alone would recreate this issue's exact disease one level down:
// a copy that can silently drift from the real spec is itself a guard that
// can pass silently. So test/fixtures/VENDORED_FROM.json records the SDK
// version the copy was taken from, and this script is the loud-drift check:
// it fails whenever that recorded version stops matching the exact
// `@curviate/sdk` pin in package.json (bumped by check:sdk-pin's own release
// ritual) — the natural refresh point, since a CLI release that bumps the
// SDK pin is exactly when the vendored fixture goes stale.
//
// Usage:  node scripts/check-fixture-pin.mjs
// Exit 0 = the vendored fixture's recorded SDK version matches the declared
//          exact @curviate/sdk dependency.
// Exit 1 = mismatch, or either file is missing/unreadable (fails closed —
//          no vendored fixture is not a pass).
// Chained into prepack (after check:sdk-pin) and pretest, so both the
// release gate and a bare `pnpm test` on a fresh clone catch stale drift.

import { readFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const pkgRoot = resolve(__dirname, "..");

/**
 * @param {string} root - package root to check (defaults to this package's root)
 * @returns {Promise<{ ok: boolean, reason: "match" | "mismatch" | "unresolved", declared: string | null, vendored: string | null }>}
 */
export async function checkFixturePin(root = pkgRoot) {
  let pkgJson;
  try {
    pkgJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  } catch {
    return { ok: false, reason: "unresolved", declared: null, vendored: null };
  }
  const declared = pkgJson.dependencies?.["@curviate/sdk"] ?? null;

  let vendoredMeta;
  try {
    vendoredMeta = JSON.parse(
      await readFile(join(root, "test", "fixtures", "VENDORED_FROM.json"), "utf8"),
    );
  } catch {
    return { ok: false, reason: "unresolved", declared, vendored: null };
  }
  const vendored = vendoredMeta.sdkVersion ?? null;

  if (typeof declared !== "string" || declared.length === 0 || typeof vendored !== "string" || vendored.length === 0) {
    return { ok: false, reason: "unresolved", declared, vendored };
  }

  return declared === vendored
    ? { ok: true, reason: "match", declared, vendored }
    : { ok: false, reason: "mismatch", declared, vendored };
}

async function main() {
  const result = await checkFixturePin(pkgRoot);

  if (result.reason === "unresolved") {
    console.error(
      `check:fixture-pin FAIL — could not read package.json's declared @curviate/sdk version or ` +
        `test/fixtures/VENDORED_FROM.json's recorded sdkVersion. Both must exist and be readable.`,
    );
    process.exit(1);
  }
  if (result.reason === "mismatch") {
    console.error(
      `check:fixture-pin FAIL — the vendored fixture (test/fixtures/openapi.json) was captured from ` +
        `@curviate/sdk ${result.vendored}, but package.json now declares "${result.declared}". Re-copy ` +
        `packages/sdk/fixtures/openapi.json from a sibling checkout at the new pinned version and update ` +
        `test/fixtures/VENDORED_FROM.json's sdkVersion, then re-run this check.`,
    );
    process.exit(1);
  }

  console.error(`check:fixture-pin OK — vendored fixture matches the declared @curviate/sdk pin (${result.declared}).`);
}

// Run only when invoked directly, never on import — the test suite imports
// checkFixturePin against isolated fixture trees and must not trigger
// process.exit or console output as a side effect of that import.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
