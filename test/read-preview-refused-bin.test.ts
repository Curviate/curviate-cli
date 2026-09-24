/**
 * A read does not declare `--preview` (lib/global-flags.ts `readOnly`), so the
 * dispatcher refuses it before any handler runs: exit 2, saying why (an API
 * read) or as an unknown flag (a local command: login, config, webhook verify). Replaces
 * the per-handler `--preview` refusal tests, which exercised a check that
 * now lives in the declaration. The writes that do declare it are covered by
 * globals-accepted-bin.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { INTERACTIVE_ONLY, readManifest, startExamplesStub, type ExamplesStub } from "./helpers/examples-stub.js";

let stub: ExamplesStub;
beforeAll(async () => {
  stub = await startExamplesStub();
}, 60_000);
afterAll(() => stub.stop());

describe("--preview on a command that does not declare it", () => {
  it("is refused with exit 2 on every such command, with the write-only message on API reads", async () => {
    const commands = readManifest().filter((c) => !c.usageOnly && c.examples[0] && !INTERACTIVE_ONLY.has(c.examples[0]));
    const without = commands.filter((c) => !c.globals.includes("preview"));
    // Positive control on the manifest itself: writes still declare it.
    expect(commands.some((c) => c.path.join(" ") === "post create" && c.globals.includes("preview"))).toBe(true);
    expect(without.map((c) => c.path.join(" "))).toEqual(expect.arrayContaining(["post get", "account list", "feed home"]));
    const wrong: string[] = [];
    for (const c of without) {
      const r = await stub.run(`${c.examples[0]} --preview`, { fresh: true });
      const api = c.globals.includes("beta");
      const message = api ? "--preview is only valid on write commands" : "unknown flag `--preview`";
      if (r.code !== 2 || !r.stderr.includes(message)) {
        wrong.push(`${c.path.join(" ")}: exit ${r.code}, ${r.stderr.trim().split("\n")[0]}`);
      }
    }
    expect(wrong).toEqual([]);
  }, 600_000);
});
