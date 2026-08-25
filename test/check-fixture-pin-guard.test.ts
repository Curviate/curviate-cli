/**
 * Coverage for the check:fixture-pin drift guard (scripts/check-fixture-pin.mjs).
 *
 * The vendored test/fixtures/openapi.json (added to make
 * flag-field-guard.test.ts pass on a standalone clone instead of reaching
 * across a sibling `sdk` checkout) is itself a copy that can silently drift
 * from the real SDK spec — the exact disease this guard exists to catch, one level
 * down. This guard is the loud-drift check: it fails whenever the SDK
 * version recorded in test/fixtures/VENDORED_FROM.json stops matching the
 * exact `@curviate/sdk` pin declared in package.json.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { checkFixturePin, fixtureHash, pkgRoot } from "../scripts/check-fixture-pin.mjs";

const tmpDirs: string[] = [];

const OLD_SDK_VERSION = "0.24.2";
const REAL_OPENAPI_CONTENT = '{"openapi":"3.0.0","info":{"title":"fixture"}}';
// Salted with the version it was actually vendored from — matches
// fixtureHash's own salting, so this constant stays meaningful only
// alongside OLD_SDK_VERSION and REAL_OPENAPI_CONTENT together.
const REAL_OPENAPI_HASH = fixtureHash(OLD_SDK_VERSION, Buffer.from(REAL_OPENAPI_CONTENT));

async function makeFixture(opts: {
  declared?: string; // omit to simulate a missing/unreadable package.json dependency
  vendoredSdkVersion?: string; // omit to simulate a missing VENDORED_FROM.json
  recordedHash?: string; // omit (with vendoredSdkVersion set) to simulate a missing sha256 field
  openapiContent?: string; // omit to simulate a missing test/fixtures/openapi.json
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "check-fixture-pin-fixture-"));
  tmpDirs.push(dir);
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "fixture-cli",
      dependencies: opts.declared !== undefined ? { "@curviate/sdk": opts.declared } : {},
    }),
    "utf8",
  );
  if (opts.vendoredSdkVersion !== undefined) {
    const fixturesDir = join(dir, "test", "fixtures");
    await mkdir(fixturesDir, { recursive: true });
    await writeFile(
      join(fixturesDir, "VENDORED_FROM.json"),
      JSON.stringify({
        sdkVersion: opts.vendoredSdkVersion,
        ...(opts.recordedHash !== undefined ? { sha256: opts.recordedHash } : {}),
      }),
      "utf8",
    );
    if (opts.openapiContent !== undefined) {
      await writeFile(join(fixturesDir, "openapi.json"), opts.openapiContent, "utf8");
    }
  }
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("check:fixture-pin — drift between the SDK pin and the vendored fixture (RED)", () => {
  it("a bumped declared pin with an untouched VENDORED_FROM.json is rejected as a mismatch", async () => {
    const dir = await makeFixture({
      declared: "0.25.0",
      vendoredSdkVersion: OLD_SDK_VERSION,
      recordedHash: REAL_OPENAPI_HASH,
      openapiContent: REAL_OPENAPI_CONTENT,
    });
    const result = await checkFixturePin(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("mismatch");
    expect(result.declared).toBe("0.25.0");
    expect(result.vendored).toBe(OLD_SDK_VERSION);
  });

  // This is the exact defect this fix targets, and the one that currently
  // passes and must not: an operator bumps package.json's declared pin AND
  // VENDORED_FROM.json's sdkVersion label together, but never re-copies
  // openapi.json and never touches its recorded hash either. A version-only
  // guard sees matching labels and reports green over a stale 2.8MB fixture.
  // A plain content hash can't catch this either — the file is genuinely
  // unchanged, so an unsalted hash of it still matches the untouched
  // recorded value. Salting the hash with sdkVersion is what makes the
  // untouched recorded hash go stale the moment the version label moves
  // without a real re-copy. Before that salting, this test failed (the
  // guard reported "match").
  it("label drift — declared and recorded sdkVersion bumped together, hash and file both left untouched — is rejected as a hash-mismatch, not a silent pass", async () => {
    const dir = await makeFixture({
      declared: "0.25.0",
      vendoredSdkVersion: "0.25.0", // label bumped to match declared...
      recordedHash: REAL_OPENAPI_HASH, // ...recorded hash from the OLD version, never recomputed...
      openapiContent: REAL_OPENAPI_CONTENT, // ...because the file was never re-copied either.
    });
    const result = await checkFixturePin(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("hash-mismatch");
    expect(result.declared).toBe("0.25.0");
    expect(result.vendored).toBe("0.25.0");
    expect(result.recordedHash).toBe(REAL_OPENAPI_HASH);
    expect(result.actualHash).not.toBe(REAL_OPENAPI_HASH);
  });

  it("content drift — openapi.json mutated but the label left untouched — is rejected as a hash-mismatch", async () => {
    const dir = await makeFixture({
      declared: OLD_SDK_VERSION,
      vendoredSdkVersion: OLD_SDK_VERSION,
      recordedHash: REAL_OPENAPI_HASH,
      openapiContent: REAL_OPENAPI_CONTENT + " ", // one byte of drift, label untouched
    });
    const result = await checkFixturePin(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("hash-mismatch");
    expect(result.recordedHash).toBe(REAL_OPENAPI_HASH);
    expect(result.actualHash).not.toBe(REAL_OPENAPI_HASH);
  });

  it("missing VENDORED_FROM.json fails closed as unresolved, not a silent pass", async () => {
    const dir = await makeFixture({ declared: OLD_SDK_VERSION });
    const result = await checkFixturePin(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unresolved");
    expect(result.vendored).toBeNull();
  });

  it("missing declared SDK dependency fails closed as unresolved", async () => {
    const dir = await makeFixture({ vendoredSdkVersion: OLD_SDK_VERSION, recordedHash: REAL_OPENAPI_HASH, openapiContent: REAL_OPENAPI_CONTENT });
    const result = await checkFixturePin(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unresolved");
    expect(result.declared).toBeNull();
  });

  it("missing recorded sha256 fails closed as unresolved", async () => {
    const dir = await makeFixture({ declared: OLD_SDK_VERSION, vendoredSdkVersion: OLD_SDK_VERSION, openapiContent: REAL_OPENAPI_CONTENT });
    const result = await checkFixturePin(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unresolved");
    expect(result.recordedHash).toBeNull();
  });

  it("missing test/fixtures/openapi.json fails closed as unresolved, not a silent pass", async () => {
    const dir = await makeFixture({ declared: OLD_SDK_VERSION, vendoredSdkVersion: OLD_SDK_VERSION, recordedHash: REAL_OPENAPI_HASH });
    const result = await checkFixturePin(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unresolved");
    expect(result.actualHash).toBeNull();
  });
});

describe("check:fixture-pin — matching state (GREEN)", () => {
  it("a vendored fixture recorded at the same version and content hash as the declared pin passes", async () => {
    const dir = await makeFixture({
      declared: OLD_SDK_VERSION,
      vendoredSdkVersion: OLD_SDK_VERSION,
      recordedHash: REAL_OPENAPI_HASH,
      openapiContent: REAL_OPENAPI_CONTENT,
    });
    const result = await checkFixturePin(dir);
    expect(result).toEqual({
      ok: true,
      reason: "match",
      declared: OLD_SDK_VERSION,
      vendored: OLD_SDK_VERSION,
      recordedHash: REAL_OPENAPI_HASH,
      actualHash: REAL_OPENAPI_HASH,
    });
  });
});

describe("check:fixture-pin — real invocation against the actual package (integration)", () => {
  it("node scripts/check-fixture-pin.mjs exits 0 against the real, currently-synced source tree", () => {
    expect(() =>
      execFileSync(process.execPath, ["scripts/check-fixture-pin.mjs"], {
        cwd: pkgRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).not.toThrow();
  });

  it("importing the module for its exports prints nothing and never exits the process", async () => {
    const mod = await import("../scripts/check-fixture-pin.mjs");
    expect(typeof mod.checkFixturePin).toBe("function");
    expect(typeof mod.pkgRoot).toBe("string");
  });
});
