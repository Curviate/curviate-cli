/**
 * The global flags `commands.json` lists for a command (and the docs page
 * prints) are ones that command accepts: for each listed global flag, one of
 * the command's examples (the first, unless the flag only acts together with
 * a flag a later example carries, as `profile me --posts` does for --all)
 * runs with it added and is not refused as a usage error.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { INTERACTIVE_ONLY, readManifest, startExamplesStub, type ExamplesStub } from "./helpers/examples-stub.js";

let stub: ExamplesStub;
beforeAll(async () => {
  stub = await startExamplesStub();
}, 60_000);
afterAll(() => stub.stop());

/**
 * A valid value per string global. `--max-pages`/`--page-delay` only act
 * under `--all`; `--preview` sends nothing, so it needs the account named.
 */
function withFlag(line: string, flag: string, baseUrl: string): string {
  const value: Record<string, string> = {
    "api-key": "rdc_live_examples_fixture",
    profile: "default",
    account: "acc_1",
    "base-url": baseUrl,
    timeout: "5000",
    fields: "id",
    limit: "5",
    cursor: "c1",
    "max-pages": "1 --all",
    "page-delay": "0 --all",
    preview: "--account acc_1",
  };
  return `${line} --${flag}${value[flag] !== undefined ? ` ${value[flag]}` : ""}`;
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => {
    for (let t = queue.shift(); t !== undefined; t = queue.shift()) await fn(t);
  }));
}

describe("listed global flags are accepted", () => {
  it("each listed global flag, added to one of the command's examples, is not a usage error", async () => {
    const cases = readManifest()
      .filter((c) => !c.usageOnly)
      .flatMap((c) => {
        const lines = c.examples.filter((l) => !INTERACTIVE_ONLY.has(l));
        return lines.length ? c.globals.map((g) => ({ path: c.path.join(" "), flag: g, lines })) : [];
      });
    expect(cases.length).toBeGreaterThan(1000);
    const refused: string[] = [];
    await pool(cases, 6, async ({ path, flag, lines }) => {
      let last = "";
      for (const line of lines) {
        const r = await stub.run(withFlag(line, flag, stub.baseUrl), { fresh: true });
        if (r.code !== 2) return;
        last = r.stderr.trim().split("\n")[0]!;
      }
      refused.push(`${path} --${flag}: ${last}`);
    });
    expect(refused.sort()).toEqual([]);
  }, 900_000);
});
