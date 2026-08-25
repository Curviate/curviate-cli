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
// version the copy was taken from, and this script is the loud-drift check.
//
// A version-only check is itself the same defect one level down: an
// operator can bump the declared pin AND VENDORED_FROM.json's sdkVersion
// label without actually re-copying openapi.json, and a label-only compare
// reports green over a stale 2.8MB fixture. So this script also records and
// checks a sha256 hash of test/fixtures/openapi.json's actual bytes — the
// artifact itself, not just its label — the same "read what's actually
// there, not the manifest string" fix as scripts/check-sdk-pin.mjs.
//
// The recorded hash is salted with sdkVersion (sha256(sdkVersion + fileBytes),
// not sha256(fileBytes) alone. A plain content hash can't catch "bumped the
// version label, left the file alone": the file is genuinely unchanged, so
// its unsalted hash still matches whatever was already recorded — nothing
// looks wrong. Baking the version into the hash means bumping sdkVersion
// without re-copying the file changes what hash *should* be recorded, so
// the untouched recorded hash goes stale together with the version bump,
// not just with a content edit.
//
// Two independent failure modes:
//   - reason "mismatch": the declared @curviate/sdk pin and the recorded
//     sdkVersion label disagree (bumped one without the other).
//   - reason "hash-mismatch": the labels agree, but the recorded sha256
//     doesn't match sha256(vendored sdkVersion + openapi.json's actual
//     content) — either the label was bumped without re-copying the file,
//     or the file was hand-edited without recomputing the hash.
//
// Usage:  node scripts/check-fixture-pin.mjs
// Exit 0 = the vendored fixture's recorded SDK version matches the declared
//          exact @curviate/sdk dependency, AND its recorded content hash
//          matches the actual openapi.json bytes.
// Exit 1 = either mismatch, or any required file is missing/unreadable
//          (fails closed — no vendored fixture is not a pass).
// Chained into prepack (after check:sdk-pin) and pretest, so both the
// release gate and a bare `pnpm test` on a fresh clone catch stale drift.

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const pkgRoot = resolve(__dirname, "..");

/**
 * Content hash salted with the SDK version it's supposed to be vendored
 * from, so a version-label bump with no real re-copy invalidates the hash
 * too (see file-header comment for why an unsalted content hash can't).
 * @param {string} sdkVersion
 * @param {Buffer} fileBuf
 * @returns {string}
 */
export function fixtureHash(sdkVersion, fileBuf) {
  return createHash("sha256").update(sdkVersion).update("\n").update(fileBuf).digest("hex");
}

/**
 * @param {string} root - package root to check (defaults to this package's root)
 * @returns {Promise<{ ok: boolean, reason: "match" | "mismatch" | "hash-mismatch" | "unresolved", declared: string | null, vendored: string | null, recordedHash: string | null, actualHash: string | null }>}
 */
export async function checkFixturePin(root = pkgRoot) {
  let pkgJson;
  try {
    pkgJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  } catch {
    return { ok: false, reason: "unresolved", declared: null, vendored: null, recordedHash: null, actualHash: null };
  }
  const declared = pkgJson.dependencies?.["@curviate/sdk"] ?? null;

  let vendoredMeta;
  try {
    vendoredMeta = JSON.parse(
      await readFile(join(root, "test", "fixtures", "VENDORED_FROM.json"), "utf8"),
    );
  } catch {
    return { ok: false, reason: "unresolved", declared, vendored: null, recordedHash: null, actualHash: null };
  }
  const vendored = vendoredMeta.sdkVersion ?? null;
  const recordedHash = vendoredMeta.sha256 ?? null;

  if (
    typeof declared !== "string" || declared.length === 0 ||
    typeof vendored !== "string" || vendored.length === 0 ||
    typeof recordedHash !== "string" || recordedHash.length === 0
  ) {
    return { ok: false, reason: "unresolved", declared, vendored, recordedHash, actualHash: null };
  }

  if (declared !== vendored) {
    return { ok: false, reason: "mismatch", declared, vendored, recordedHash, actualHash: null };
  }

  let openapiBuf;
  try {
    openapiBuf = await readFile(join(root, "test", "fixtures", "openapi.json"));
  } catch {
    return { ok: false, reason: "unresolved", declared, vendored, recordedHash, actualHash: null };
  }
  const actualHash = fixtureHash(vendored, openapiBuf);

  if (actualHash !== recordedHash) {
    return { ok: false, reason: "hash-mismatch", declared, vendored, recordedHash, actualHash };
  }

  return { ok: true, reason: "match", declared, vendored, recordedHash, actualHash };
}

async function main() {
  const result = await checkFixturePin(pkgRoot);

  if (result.reason === "unresolved") {
    console.error(
      `check:fixture-pin FAIL — could not read package.json's declared @curviate/sdk version, ` +
        `test/fixtures/VENDORED_FROM.json's recorded sdkVersion/sha256, or test/fixtures/openapi.json ` +
        `itself. All must exist and be readable.`,
    );
    process.exit(1);
  }
  if (result.reason === "mismatch") {
    console.error(
      `check:fixture-pin FAIL — the vendored fixture (test/fixtures/openapi.json) was captured from ` +
        `@curviate/sdk ${result.vendored}, but package.json now declares "${result.declared}". Re-copy ` +
        `packages/sdk/fixtures/openapi.json from a sibling checkout at the new pinned version and update ` +
        `test/fixtures/VENDORED_FROM.json's sdkVersion and sha256, then re-run this check.`,
    );
    process.exit(1);
  }
  if (result.reason === "hash-mismatch") {
    console.error(
      `check:fixture-pin FAIL — test/fixtures/openapi.json is STALE: its actual content hash ` +
        `(${result.actualHash}) does not match the sha256 recorded in test/fixtures/VENDORED_FROM.json ` +
        `(${result.recordedHash}), even though the sdkVersion label ("${result.vendored}") matches the ` +
        `declared pin. The label was updated without re-copying the fixture — re-copy ` +
        `packages/sdk/fixtures/openapi.json from a sibling checkout at ${result.declared} and recompute ` +
        `sha256 in test/fixtures/VENDORED_FROM.json, then re-run this check.`,
    );
    process.exit(1);
  }

  console.error(`check:fixture-pin OK — vendored fixture matches the declared @curviate/sdk pin (${result.declared}) and its content hash.`);
}

// Run only when invoked directly, never on import — the test suite imports
// checkFixturePin against isolated fixture trees and must not trigger
// process.exit or console output as a side effect of that import.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
