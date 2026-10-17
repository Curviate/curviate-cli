/**
 * A repeated flag never crashes and never silently changes meaning: citty turns
 * `--account a --account b` into an array (and `--json --json` into
 * `[true, true]`, which reads as "not JSON"). Every flag on every command is
 * swept; only the flags whose help says "repeatable" accumulate.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { repeatedFlag } from "../src/dispatch.js";
import { pkgRoot } from "./helpers/pkg.js";
import { useSink } from "./helpers/sink.js";
import { allNodes } from "./helpers/tree.js";

const saysRepeatable = (d?: string) => /\brepeatable\b/i.test(d ?? "");
const sink = useSink();

const leaves = (await allNodes(true)).filter((n) => n.run);

describe("every flag, repeated", () => {

  it("is refused unless declared repeatable, on every command; a boolean's negation counts as a repeat", async () => {
    let checked = 0;
    let repeatable = 0;
    const wrong: string[] = [];
    for (const { path, cmd, defs } of leaves) {
      for (const [flag, def] of Object.entries(defs)) {
        if (def.type === "positional") continue;
        const once = [{ name: flag }];
        const rep = saysRepeatable(def.description);
        repeatable += rep ? 1 : 0;
        if ((await repeatedFlag(cmd, [...once, ...once])) !== (rep ? null : flag)) wrong.push(`${path.join(" ")} --${flag} twice`);
        if ((await repeatedFlag(cmd, once)) !== null) wrong.push(`${path.join(" ")} --${flag} once`);
        if (def.type === "boolean" && !(`no-${flag}` in defs) && (await repeatedFlag(cmd, [...once, { name: `no-${flag}` }])) !== flag) wrong.push(`${path.join(" ")} --${flag} --no-${flag}`);
        checked++;
      }
    }
    expect([leaves.length > 100, checked > 500, repeatable > 0]).toEqual([true, true, true]);
    expect(wrong).toEqual([]);
  });

  it("in each command file, the flags read as an array are exactly the ones its help calls repeatable", () => {
    const dir = resolve(pkgRoot, "src", "commands");
    const described = new Map<string, Set<string>>();
    for (const { path, defs } of leaves) {
      const set = described.get(path[0]!) ?? new Set<string>();
      for (const [flag, def] of Object.entries(defs)) if (saysRepeatable(def.description)) set.add(flag);
      described.set(path[0]!, set);
    }
    let files = 0;
    for (const f of readdirSync(dir)) {
      const group = f.replace(/\.ts$/, "");
      if (!described.has(group)) continue;
      const arrayFlags = [...readFileSync(join(dir, f), "utf8").matchAll(/^\s*"?([a-z-]+)"?\?: string \| string\[\];/gm)].map((m) => m[1]!);
      expect(arrayFlags.sort(), f).toEqual([...described.get(group)!].sort());
      files++;
    }
    expect(files).toBe(described.size);
  });
});

describe("through the entry point", () => {
  const A = ["--account", "acc_1"];
  const refused = async (args: string[], message: RegExp) => {
    const r = await sink.run(args);
    expect([r.status, r.requests], r.stderr).toEqual([2, []]);
    expect(r.stderr).toMatch(message);
    expect(r.stderr).not.toMatch(/is not a function|Internal error/);
  };

  it("--account a --account b and the alias pair -o x --output y are repeats", async () => {
    await refused(["profile", "me", "--account", "a", "--account", "b"], /--account was given more than once/);
    await refused(["job", "applicant", "resume", "a", "b", "-o", "x", "--output", "y", ...A], /--output was given more than once/);
  });

  it.each([["comment", "add", "p1", "hi"], ["comment", "reply", "p1", "c1", "hi"]])("%s --attach a --attach b: at most one", async (...argv) => {
    await refused([...argv, "--attach", "a.png", "--attach", "b.png", ...A], /--attach was given more than once/);
  });

  it("message send --attach a --attach b is accepted (it is repeatable); --json --json is a repeat and --json once works", async () => {
    const r = await sink.run(["message", "send", "chat_1", "hi", "--attach", "a.png", "--attach", "b.png", "--preview", ...A]);
    expect(r.stderr).not.toMatch(/was given more than once/);
    expect(r.stderr).toMatch(/Cannot read attachment/);
    await refused(["config", "list", "--json", "--json"], /more than once/);
    expect((await sink.run(["config", "list", "--json"])).status).toBe(0);
  });
});
