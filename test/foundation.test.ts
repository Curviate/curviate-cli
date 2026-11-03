/** Package shape and the standing source rules: dependency closure, and no dry-run. */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pkgRoot } from "./helpers/pkg.js";

describe("package", () => {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as { type: string; name: string; version: string; dependencies: Record<string, string> };

  it("is an ES module named @curviate/cli with a semver version, depending on the SDK and citty and on no internal workspace package", () => {
    expect([pkg.type, pkg.name]).toEqual(["module", "@curviate/cli"]);
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    expect(Object.keys(pkg.dependencies)).toEqual(expect.arrayContaining(["@curviate/sdk", "citty"]));
    expect(Object.keys(pkg.dependencies)).not.toContain("@curviate/" + "shared"); // fragments: the codename never appears in source
  });
});

describe("source", () => {
  it("carries no dry-run parameter or token anywhere", () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const leaks = walk(resolve(pkgRoot, "src")).filter((f) => /dry[_-]run/i.test(readFileSync(f, "utf8")));
    expect(leaks).toEqual([]);
  });

  it("README.md embeds no real-shaped API key and no dry-run token", () => {
    const readme = readFileSync(join(pkgRoot, "README.md"), "utf8");
    expect(readme).not.toMatch(/rdc_live_\w{10,}/); // placeholders stay short
    expect(readme).not.toMatch(/dry[_-]run/i);
  });
});
