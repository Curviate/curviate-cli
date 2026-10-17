/**
 * Help text is the contract an agent reads: every `--flag` a command's help
 * mentions must be declared by the command it is about (a backticked
 * `curviate <path> ...` span is checked against that command instead), and no
 * help quotes a command that was removed or renamed.
 */
import { describe, it, expect } from "vitest";
import { successorHint } from "../src/dispatch.js";
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
  tree.set(n.path.join(" "), { declared, text });
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

  it("quotes no removed or renamed command", () => {
    const groups = new Set(nodes.filter((n) => n.path.length === 1).map((n) => n.path[0]));
    const stale: string[] = [];
    for (const [path, { text }] of tree) {
      for (const m of text.matchAll(/`([^`]*)`|'([^']*)'|"([^"]*)"/g)) {
        const words = (m[1] ?? m[2] ?? m[3] ?? "").trim().split(/\s+/).filter(Boolean);
        if (words[0] === "curviate") words.shift();
        const hint = words[0] && words[1] && groups.has(words[0]) ? successorHint(words[0], words[1]) : null;
        if (hint) stale.push(`${path}: quotes \`${m[0]}\`. ${hint}`);
      }
    }
    expect(stale).toEqual([]);
  });
});
