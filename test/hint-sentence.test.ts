/**
 * The missing-argument hint is the first COMPLETE sentence of a flag's
 * description: a period inside parentheses or after an abbreviation
 * ("e.g.", "incl.") is not a sentence end. The four bin cases are real
 * descriptions that were cut mid-parenthesis; the scan below checks every
 * required flag on every command so a new description cannot reintroduce it.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArgDef, CommandDef } from "citty";
import { firstSentenceHint } from "../src/dispatch.js";
import { runBin } from "./helpers/run-bin.js";

const xdgHome = mkdtempSync(join(tmpdir(), "curviate-hint-"));

const balanced = (s: string) => {
  let depth = 0;
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")" && --depth < 0) return false;
  }
  return depth === 0;
};

describe("hint on real descriptions (built bin)", () => {
  const cases: Array<[string, string[], string]> = [
    ["message new --to", ["message", "new"], "--to"],
    ["search service-parameters --keywords", ["search", "service-parameters"], "--keywords"],
    ["search parameters --type SKILL --keywords", ["search", "parameters", "--type", "SKILL"], "--keywords"],
    ["recruiter search parameters --source SEARCH --type", ["recruiter", "search", "parameters", "--source", "SEARCH"], "--type"],
  ];

  it.each(cases)("%s: balanced parens, ends in a complete sentence", (_label, args, flag) => {
    const r = runBin(args, xdgHome);
    expect(r.status).toBe(2);
    const hint = r.stderr.split("\n").find((l) => l.startsWith(`hint: ${flag}: `));
    expect(hint, r.stderr).toBeDefined();
    expect(balanced(hint!)).toBe(true);
    expect(hint).toMatch(/[.!?)]$/);
    expect(hint).not.toMatch(/\b(e\.g|i\.e|incl|etc|vs)\.$/);
  });
});

describe("firstSentenceHint", () => {
  it.each([
    ["A (e.g. x. y) thing. Second.", "A (e.g. x. y) thing."],
    ["Use it, incl. this one. Then more.", "Use it, incl. this one."],
    ["Filter by state (required): A|B. More.", "Filter by state: A|B."],
    ["No terminal period", "No terminal period"],
    ["Ends with vs. other. Next.", "Ends with vs. other."],
  ])("%s", (input, expected) => {
    expect(firstSentenceHint(input)).toBe(expected);
  });
});

describe("every required flag's hint has balanced parentheses", () => {
  const modules = (import.meta as unknown as { glob: (p: string) => Record<string, () => Promise<unknown>> })
    .glob("../src/commands/*.ts");
  const resolve = async <T>(v: unknown): Promise<T> => (typeof v === "function" ? await (v as () => T)() : (v as T));

  it("scans the whole command tree", async () => {
    const descriptions: Array<[string, string]> = [];
    const walk = async (cmd: CommandDef, path: string) => {
      const args = ((await resolve(cmd.args)) ?? {}) as Record<string, ArgDef & { required?: boolean }>;
      for (const [name, def] of Object.entries(args)) {
        if (def.required && def.type !== "positional" && def.description) {
          descriptions.push([`${path} --${name}`, def.description]);
        }
      }
      const subs = ((await resolve(cmd.subCommands)) ?? {}) as Record<string, unknown>;
      for (const [n, sub] of Object.entries(subs)) await walk(await resolve<CommandDef>(sub), `${path} ${n}`);
    };
    for (const load of Object.values(modules)) {
      for (const [name, value] of Object.entries((await load()) as Record<string, unknown>)) {
        if (value && typeof value === "object" && "meta" in value) await walk(value as CommandDef, name);
      }
    }
    // Guard on the guard: the scan must actually find the surface.
    expect(descriptions.length).toBeGreaterThan(30);
    const broken = descriptions
      .map(([where, d]) => [where, firstSentenceHint(d)] as const)
      .filter(([, h]) => !balanced(h));
    expect(broken).toEqual([]);
  });
});
