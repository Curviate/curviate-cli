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
import { checkFixturePin, pkgRoot } from "../scripts/check-fixture-pin.mjs";

const tmpDirs: string[] = [];

async function makeFixture(opts: {
  declared?: string; // omit to simulate a missing/unreadable package.json dependency
  vendoredSdkVersion?: string; // omit to simulate a missing VENDORED_FROM.json
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
      JSON.stringify({ sdkVersion: opts.vendoredSdkVersion }),
      "utf8",
    );
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
  it("a bumped SDK pin with a stale vendored fixture is rejected as a mismatch", async () => {
    const dir = await makeFixture({ declared: "0.25.0", vendoredSdkVersion: "0.24.2" });
    const result = await checkFixturePin(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("mismatch");
    expect(result.declared).toBe("0.25.0");
    expect(result.vendored).toBe("0.24.2");
  });

  it("missing VENDORED_FROM.json fails closed as unresolved, not a silent pass", async () => {
    const dir = await makeFixture({ declared: "0.24.2" });
    const result = await checkFixturePin(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unresolved");
    expect(result.vendored).toBeNull();
  });

  it("missing declared SDK dependency fails closed as unresolved", async () => {
    const dir = await makeFixture({ vendoredSdkVersion: "0.24.2" });
    const result = await checkFixturePin(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unresolved");
    expect(result.declared).toBeNull();
  });
});

describe("check:fixture-pin — matching state (GREEN)", () => {
  it("a vendored fixture recorded at the same version as the declared pin passes", async () => {
    const dir = await makeFixture({ declared: "0.24.2", vendoredSdkVersion: "0.24.2" });
    const result = await checkFixturePin(dir);
    expect(result).toEqual({ ok: true, reason: "match", declared: "0.24.2", vendored: "0.24.2" });
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
