/**
 * `--help` prints a command's `meta.examples` under an EXAMPLES heading, on
 * every command shape: a leaf, a nested leaf, a group's bare form and a
 * top-level command. A group that only lists subcommands has none to print.
 * (citty's own usage block goes through consola, which is silent under a test
 * runner's env, so only the EXAMPLES block reaches stdout here.)
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBin } from "./helpers/run-bin.js";
import { pkgRoot } from "./helpers/built-cli.js";

const xdg = mkdtempSync(join(tmpdir(), "curviate-help-examples-"));
const manifest = JSON.parse(readFileSync(join(pkgRoot, "commands.json"), "utf8")) as {
  commands: Array<{ path: string[]; examples: string[] }>;
};
const examplesOf = (path: string) => manifest.commands.find((c) => c.path.join(" ") === path)!.examples;

describe("--help prints examples", () => {
  it.each(["post get", "recruiter job create", "connect", "doctor"])("%s", (path) => {
    const expected = examplesOf(path);
    expect(expected.length).toBeGreaterThan(0);
    const r = runBin([...path.split(" "), "--help"], xdg);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`EXAMPLES\n\n${expected.map((e) => `  ${e}`).join("\n")}\n`);
  });

  it("a subcommand-only group prints no EXAMPLES block", () => {
    expect(examplesOf("account")).toEqual([]);
    // Same path, positive control: a sibling leaf's help does print the block.
    expect(runBin(["account", "list", "--help"], xdg).stdout).toContain("EXAMPLES");
    const r = runBin(["account", "--help"], xdg);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("EXAMPLES");
  });
});
