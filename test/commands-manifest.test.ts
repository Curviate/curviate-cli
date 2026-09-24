/**
 * `commands.json` is the command surface as data: every command in the live
 * registry (`src/main.ts`), with its description, its own args, the global
 * flags it accepts and its `meta.examples`. The docs site generates its CLI
 * reference from this file at the submodule gitlink, so it must equal what
 * the registry declares. Regenerate with `pnpm manifest`.
 *
 * Also the examples rule: every command a user can run (a leaf, or a group
 * with its own positional, e.g. `connect <id>`) carries 1-3 one-line
 * examples that invoke exactly that command.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandDef } from "citty";
import { main } from "../src/main.js";
import { GLOBAL_FLAGS } from "../src/lib/global-flags.js";
import { pkgRoot } from "./helpers/built-cli.js";

type Def = { type?: string; required?: boolean; default?: unknown; description?: string; alias?: string | string[]; valueHint?: string };

export type ManifestCommand = {
  path: string[];
  description: string;
  /** A group with no positional of its own: running it only prints its subcommands. */
  usageOnly: boolean;
  args: Array<{ name: string } & Def>;
  globals: string[];
  examples: string[];
  /** Conditional requirements, one line each (see src/lib/examples.ts). */
  requires: string[];
};

async function value<T>(v: T | (() => T) | (() => Promise<T>)): Promise<T> {
  return typeof v === "function" ? (v as () => T | Promise<T>)() : v;
}

async function walk(cmd: CommandDef, path: string[], out: ManifestCommand[]): Promise<void> {
  const meta = (await value(cmd.meta ?? {})) as { description?: string; examples?: string[]; requires?: string[] };
  const defs = (await value(cmd.args ?? {})) as Record<string, Def>;
  const subs = (await value(cmd.subCommands ?? {})) as Record<string, unknown>;
  const own = Object.entries(defs).filter(([n, d]) => d !== (GLOBAL_FLAGS as Record<string, unknown>)[n]);
  if (path.length > 0) {
    out.push({
      path,
      description: meta.description ?? "",
      usageOnly: Object.keys(subs).length > 0 && !own.some(([, d]) => d.type === "positional"),
      args: own.map(([name, d]) => ({ name, ...d })),
      globals: Object.keys(defs).filter((n) => !own.some(([o]) => o === n)),
      examples: meta.examples ?? [],
      requires: meta.requires ?? [],
    });
  }
  for (const [name, sub] of Object.entries(subs)) {
    await walk((await value(sub as CommandDef)) as CommandDef, [...path, name], out);
  }
}

export async function buildManifest(): Promise<{ commands: ManifestCommand[] }> {
  const commands: ManifestCommand[] = [];
  await walk(main as CommandDef, [], commands);
  return { commands };
}

const MANIFEST = resolve(pkgRoot, "commands.json");

describe("commands.json", () => {
  it("equals the live registry (regenerate: pnpm manifest)", async () => {
    const expected = JSON.stringify(await buildManifest(), null, 2) + "\n";
    if (process.env["WRITE_COMMANDS_MANIFEST"] === "1") writeFileSync(MANIFEST, expected);
    expect(readFileSync(MANIFEST, "utf8")).toBe(expected);
  });

  it("gives every runnable command 1-3 one-line examples that invoke it", async () => {
    const { commands } = await buildManifest();
    const runnable = commands.filter((c) => !c.usageOnly);
    // Positive control: the walk reached the registry, top-level leaves included.
    expect(runnable.map((c) => c.path.join(" "))).toEqual(expect.arrayContaining(["doctor", "post get", "recruiter job create"]));
    const bad = runnable
      .filter((c) => {
        const prefix = `curviate ${c.path.join(" ")}`;
        return (
          c.examples.length < 1 ||
          c.examples.length > 3 ||
          c.examples.some((e) => e.includes("\n") || !(e === prefix || e.startsWith(prefix + " ")))
        );
      })
      .map((c) => `${c.path.join(" ")}: ${JSON.stringify(c.examples)}`);
    expect(bad).toEqual([]);
  });
});
