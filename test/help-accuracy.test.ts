/**
 * Help text is the contract an agent reads: every `--flag` a command's help
 * mentions must be declared by the command it is about (a backticked
 * `curviate <path> ...` span is checked against that command instead), (every quoted path resolving is
 * help-contract.test.ts's).
 */
import { describe, it, expect } from "vitest";
import { allNodes } from "./helpers/tree.js";

const GLOBALS = new Set(["account", "json", "fields", "limit", "cursor", "all", "max-pages", "page-delay", "preview", "verbose", "api-key", "base-url", "timeout", "profile", "help", "version"]);
const nodes = await allNodes(true);
const tree = new Map<string, { declared: Set<string>; text: string }>();
for (const n of nodes) {
  const meta = ((typeof n.cmd.meta === "function" ? await (n.cmd.meta as () => Promise<unknown>)() : n.cmd.meta) ?? {}) as Record<string, unknown>;
  const declared = new Set<string>();
  for (const [name, d] of Object.entries(n.defs)) {
    declared.add(name);
    for (const a of ([] as string[]).concat(d.alias ?? [])) declared.add(a);
  }
  const text = [...Object.entries(meta).filter(([k, v]) => k !== "name" && typeof v === "string").map(([, v]) => v as string), ...Object.values(n.defs).map((d) => d.description ?? "")].join("\n");
  // A pure group declares no flags; its copy (the `core` text) names its members' flags.
  tree.set(n.path.join(" "), { declared, text: n.hasSubs && declared.size === 0 ? "" : text });
}

/** The longest known command path a token list starts with. */
function referenced(tokens: string[]): string | null {
  let best: string | null = null;
  for (let i = 1; i <= tokens.length; i++) if (tree.has(tokens.slice(0, i).join(" "))) best = tokens.slice(0, i).join(" ");
  return best;
}

describe("help text", () => {
  it("names only flags the command (or the command a backticked `curviate ...` span refers to) declares", () => {
    const bad: string[] = [];
    for (const [path, { text }] of tree) {
      for (const span of text.split(/(`[^`]*`)/)) {
        const words = span.startsWith("`") && span.endsWith("`") ? span.slice(1, -1).trim().split(/\s+/) : [];
        const against = (words[0] === "curviate" && referenced(words.slice(1))) || path;
        for (const m of span.matchAll(/--([a-z][a-z0-9]*(?:-[a-z0-9]+)*)/g)) {
          const flag = m[1]!;
          const base = flag.startsWith("no-") ? flag.slice(3) : flag;
          const declared = tree.get(against)!.declared;
          if (!declared.has(flag) && !declared.has(base) && !GLOBALS.has(flag) && !GLOBALS.has(base)) bad.push(`${path}: help says --${flag}, \`${against}\` declares [${[...declared].sort().join(", ")}]`);
        }
      }
    }
    expect(tree.size).toBeGreaterThan(150);
    expect(bad).toEqual([]);
  });
});
