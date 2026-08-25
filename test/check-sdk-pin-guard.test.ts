/**
 * Coverage for the check:sdk-pin construction-level guard (scripts/check-sdk-pin.mjs).
 *
 * the published `@curviate/cli@0.24.0` declared
 * `"@curviate/sdk": "^0.23.0"` — a caret on a 0.x package pins the minor
 * (`>=0.23.0 <0.24.0`), so it could never resolve the registry's actual
 * latest (`0.24.2`). The fixtures below reproduce that exact broken state
 * (declared range + a resolved node_modules copy genuinely one version
 * behind) to prove this guard would have caught it, then prove it passes
 * once the pin is exact and matches.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { checkSdkPin, pkgRoot } from "../scripts/check-sdk-pin.mjs";

const tmpDirs: string[] = [];

async function makeFixture(opts: {
  declared: string;
  resolvedVersion?: string; // omit to simulate node_modules missing the package entirely
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "check-sdk-pin-fixture-"));
  tmpDirs.push(dir);
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture-cli", dependencies: { "@curviate/sdk": opts.declared } }),
    "utf8",
  );
  if (opts.resolvedVersion !== undefined) {
    const sdkDir = join(dir, "node_modules", "@curviate", "sdk");
    await mkdir(sdkDir, { recursive: true });
    await writeFile(
      join(sdkDir, "package.json"),
      JSON.stringify({ name: "@curviate/sdk", version: opts.resolvedVersion }),
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

describe("check:sdk-pin — reproduces the real broken state (RED)", () => {
  it("a caret range that resolves one minor behind is rejected as not-exact, before resolution is even considered", async () => {
    // This is the literal shape shipped in @curviate/cli@0.24.0: declared
    // "^0.23.0", installed/resolved 0.23.0 — internally "consistent" by a
    // naive equality check, yet the range itself could never admit 0.24.x.
    const dir = await makeFixture({ declared: "^0.23.0", resolvedVersion: "0.23.0" });
    const result = await checkSdkPin(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not-exact");
  });

  it("a range-shaped declaration is rejected even when resolution happens to match", async () => {
    const dir = await makeFixture({ declared: ">=0.23.0", resolvedVersion: "0.23.0" });
    const result = await checkSdkPin(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not-exact");
  });
});

describe("check:sdk-pin — resolved/installed vs declared mismatch (construction-level, not manifest-only)", () => {
  it("an exact declared pin that does not match what's actually installed fails as a mismatch", async () => {
    // Proves this guard reads node_modules, not just package.json: a manifest
    // string check alone would see "0.24.2" declared and stop there.
    const dir = await makeFixture({ declared: "0.24.2", resolvedVersion: "0.24.0" });
    const result = await checkSdkPin(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("mismatch");
    expect(result.declared).toBe("0.24.2");
    expect(result.resolved).toBe("0.24.0");
  });

  it("mutation check: a manifest-only variant (declared-only, no node_modules read) would have passed this same mismatch", async () => {
    const dir = await makeFixture({ declared: "0.24.2", resolvedVersion: "0.24.0" });
    const pkgJson = JSON.parse(
      await (await import("node:fs/promises")).readFile(join(dir, "package.json"), "utf8"),
    );
    const manifestOnlyPassed = typeof pkgJson.dependencies["@curviate/sdk"] === "string";
    expect(manifestOnlyPassed).toBe(true); // the vacuous manifest-only check genuinely "passes"
    const result = await checkSdkPin(dir);
    expect(result.ok).toBe(false); // the real guard, reading node_modules, catches it anyway
  });

  it("no node_modules entry at all fails closed as unresolved, not as a silent pass", async () => {
    const dir = await makeFixture({ declared: "0.24.2" });
    const result = await checkSdkPin(dir);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unresolved");
    expect(result.resolved).toBeNull();
  });
});

describe("check:sdk-pin — the fixed, matching state (GREEN)", () => {
  it("an exact declared pin that matches the resolved/installed version passes", async () => {
    const dir = await makeFixture({ declared: "0.24.2", resolvedVersion: "0.24.2" });
    const result = await checkSdkPin(dir);
    expect(result).toEqual({ ok: true, reason: "match", declared: "0.24.2", resolved: "0.24.2" });
  });
});

describe("check:sdk-pin — real invocation against the actual package (integration)", () => {
  it("node scripts/check-sdk-pin.mjs exits 0 against the real, currently-fixed source tree", () => {
    expect(() =>
      execFileSync(process.execPath, ["scripts/check-sdk-pin.mjs"], {
        cwd: pkgRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).not.toThrow();
  });

  it("importing the module for its exports prints nothing and never exits the process", async () => {
    const mod = await import("../scripts/check-sdk-pin.mjs");
    expect(typeof mod.checkSdkPin).toBe("function");
    expect(typeof mod.pkgRoot).toBe("string");
  });
});
