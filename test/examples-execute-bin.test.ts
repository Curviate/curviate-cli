/**
 * Every `meta.examples` line is a real invocation: run through bash against
 * the BUILT binary and a local stub standing in for the API, none may be
 * refused as a usage error (exit 2) or crash (exit 1). The docs site prints
 * these lines verbatim, so a renamed flag or a wrong positional count here is
 * a broken docs page.
 *
 * The stub may still make a read exit 7 on a body it cannot use: that is the
 * API's answer, not the example's usage, and is allowed.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { INTERACTIVE_ONLY, readManifest, startExamplesStub, type ExamplesStub } from "./helpers/examples-stub.js";

let stub: ExamplesStub;
beforeAll(async () => {
  stub = await startExamplesStub();
}, 60_000);
afterAll(() => stub.stop());

describe("meta.examples execute", () => {
  it("no example is a usage error or a crash", async () => {
    const lines = readManifest().flatMap((c) => c.examples).filter((l) => !INTERACTIVE_ONLY.has(l));
    expect(lines.length).toBeGreaterThan(150);
    const bad: string[] = [];
    for (const line of lines) {
      const r = await stub.run(line);
      // `setup --code -` finishes a key exchange whose response the stub cannot fake.
      const stubShape = r.code === 1 && r.stderr.includes("The API returned an unreadable response");
      if (!stubShape && (r.code === null || r.code === 1 || r.code === 2)) bad.push(`${line}\n  exit ${r.code}: ${r.stderr.trim().split("\n")[0]}`);
    }
    expect(bad).toEqual([]);
  }, 600_000);
});
