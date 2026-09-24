/**
 * "Required" in `commands.json` (and so on the docs page and in --help) means
 * what the runtime enforces. For each flag a command's example passes,
 * dropping it from that example is refused with "is required" exactly when
 * the flag is declared `required: true`. A flag that is only required
 * alongside another value (`--website-url` with `--apply-method external`) or
 * that has an alternative (`--job-title` or `--job-title-id`) is not
 * "required" and is not held to this.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { INTERACTIVE_ONLY, readManifest, startExamplesStub, type ExamplesStub } from "./helpers/examples-stub.js";

let stub: ExamplesStub;
beforeAll(async () => {
  stub = await startExamplesStub();
}, 60_000);
afterAll(() => stub.stop());

/** The line without `--name` (and its value, for a non-boolean flag). */
function drop(line: string, name: string, boolean: boolean): string {
  const value = boolean ? "" : `(\\s+("[^"]*"|'[^']*'|\\S+))`;
  return line.replace(new RegExp(`\\s--${name}(=\\S+|${value})${boolean ? "?" : ""}(?=\\s|$)`), "");
}

/** Refused as unconditionally required: names the flag, offers no alternative or condition. */
function refusedAsRequired(stderr: string, name: string): boolean {
  const first = stderr.trim().split("\n")[0] ?? "";
  return first.includes(`--${name}`) && /required/i.test(first) && !/\bor\b|required when|required with|required for a/i.test(first);
}

describe("required flags", () => {
  it("dropping a flag from an example is refused as required exactly when the flag is declared required", async () => {
    const mismatches: string[] = [];
    let probed = 0;
    for (const c of readManifest().filter((m) => !m.usageOnly)) {
      const line = c.examples.find((l) => !INTERACTIVE_ONLY.has(l));
      if (!line) continue;
      for (const a of c.args.filter((x) => x.type !== "positional")) {
        if (!new RegExp(`\\s--${a.name}(\\s|=|$)`).test(line)) continue;
        const without = drop(line, a.name, a.type === "boolean");
        if (without === line) throw new Error(`could not drop --${a.name} from: ${line}`);
        probed++;
        const r = await stub.run(without, { fresh: true });
        const enforced = r.code === 2 && refusedAsRequired(r.stderr, a.name);
        if (enforced !== (a.required === true)) {
          mismatches.push(`${c.path.join(" ")} --${a.name}: declared required=${a.required === true}, runtime ${enforced ? "refuses" : "accepts"} its absence`);
        }
      }
    }
    expect(probed).toBeGreaterThan(40);
    expect(mismatches).toEqual([]);
  }, 600_000);
});
