/**
 * The command surface, derived at run time from the live registry (`main`),
 * never from a hand-written list: a new command is swept automatically. Local
 * commands (`setup`, `doctor`, `login`, `config`) are left out of the sweeps
 * that send API requests.
 */

import type { CommandDef } from "citty";
import { main } from "../../src/main.js";
import { GLOBAL_FLAGS } from "../../src/lib/global-flags.js";

export type ArgDef = { type?: string; required?: boolean; description?: string; alias?: string | string[] };
export type Node = {
  path: string[];
  cmd: CommandDef;
  defs: Record<string, ArgDef>;
  subs: string[];
  hasSubs: boolean;
  run: CommandDef["run"];
};

const LOCAL = new Set(["setup", "doctor", "login", "config"]);

async function val<T>(v: T | (() => T) | (() => Promise<T>)): Promise<T> {
  return typeof v === "function" ? (v as () => T | Promise<T>)() : v;
}

const caches: Partial<Record<"api" | "all", Promise<Node[]>>> = {};

/** Every node under `main` (groups and leaves); local commands excluded unless `withLocal`. */
export function allNodes(withLocal = false): Promise<Node[]> {
  return (caches[withLocal ? "all" : "api"] ??= (async () => {
    const out: Node[] = [];
    const walk = async (cmd: CommandDef, path: string[]) => {
      const subs = (await val(cmd.subCommands ?? {})) as Record<string, unknown>;
      out.push({ path, cmd, defs: (await val(cmd.args ?? {})) as Record<string, ArgDef>, subs: Object.keys(subs), hasSubs: Object.keys(subs).length > 0, run: cmd.run });
      for (const [name, sub] of Object.entries(subs)) {
        if (!withLocal && path.length === 0 && LOCAL.has(name)) continue;
        await walk((await val(sub as CommandDef)) as CommandDef, [...path, name]);
      }
    };
    await walk(main, []);
    return out.slice(1);
  })());
}

/** Values for required flags whose value is validated before any request. */
export const FLAG_VALUES: Record<string, string> = {
  state: "OPEN",
  source: "messaging",
  type: "LOCATION",
  keywords: "xyz",
  "channel-id": "c1",
  "request-url": "https://h.test/x",
  "account-ids": "acc_1",
  "endorsement-id": "e1",
};

/** Where the default argv would not reach the request: a URL-only form, a query minimum, a flag that selects the list. */
export const OVERRIDES: Record<string, string[]> = {
  search: ["search", "https://www.linkedin.com/search/results/people/?keywords=x"],
  "recruiter search": ["recruiter", "search", "https://www.linkedin.com/talent/search?searchContextId=1"],
  "sales-nav search": ["sales-nav", "search", "https://www.linkedin.com/sales/search/people?query=x"],
  "inbox search": ["inbox", "search", "hello"],
  "search groups": ["search", "groups", "hello"],
  "company search-chats": ["company", "search-chats", "1", "hello"],
  profile: ["profile", "1", "--posts"],
  "profile me": ["profile", "me", "--posts"],
};

const isUrlShaped = (name: string) => name === "url" || name.endsWith("-url");
const hasPositional = (n: Node) => Object.values(n.defs).some((d) => d.type === "positional");

/** A group that only prints its usage (no positional of its own) sends nothing either way. */
const usageOnly = (n: Node) => n.subs.length > 0 && !hasPositional(n) && !OVERRIDES[n.path.join(" ")];

/**
 * A runnable argv for the node. Numeric ids (not "x1"): a numeric-looking
 * identifier takes a resolver's fast path, so the ONLY request a list command
 * sends is the one under test.
 */
export function argvFor(node: Node): string[] {
  const key = node.path.join(" ");
  if (OVERRIDES[key]) return OVERRIDES[key]!;
  const positionals = Object.values(node.defs)
    .filter((d) => d.type === "positional" && d.required !== false)
    .map(() => "1");
  const required = Object.entries(node.defs)
    .filter(([, d]) => d.type !== "positional" && d.required)
    .flatMap(([name]) => [`--${name}`, FLAG_VALUES[name] ?? "x"]);
  return [...node.path, ...positionals, ...required];
}

/** Every runnable leaf that declares `--all` (the streaming surface). */
export async function discoverStreamingNodes(): Promise<Node[]> {
  return (await allNodes()).filter((n) => n.run && "all" in n.defs && !usageOnly(n));
}

/** Every runnable leaf that declares `--cursor`: a superset of the streaming surface. */
export async function discoverCursorNodes(): Promise<Node[]> {
  return (await allNodes()).filter((n) => n.run && "cursor" in n.defs && !usageOnly(n));
}

// --- the every-command read/write sweep -------------------------------------

export type SweepVariant = { path: string[]; argv: string[]; variant: string };

const GLOBAL_FLAG_NAMES = new Set(Object.keys(GLOBAL_FLAGS));
const firstEnumValue = (d?: string) => d?.match(/\b([A-Za-z][\w-]*)\s*\|\s*[A-Za-z]/)?.[1] ?? null;

const SWEEP_OVERRIDES: Record<string, string[]> = {
  profile: ["profile", "1"],
  "profile me": ["profile", "me"],
  "recruiter project-job": ["recruiter", "project-job", "1"],
  "recruiter applicant": ["recruiter", "applicant", "1", "1"],
  "webhook create": ["webhook", "create", "--source", "account_status", "--request-url", "https://h.test/x"],
};

function bareArgv(node: Node): string[] {
  const key = node.path.join(" ");
  if (SWEEP_OVERRIDES[key] ?? OVERRIDES[key]) return (SWEEP_OVERRIDES[key] ?? OVERRIDES[key])!;
  const positionals = Object.entries(node.defs)
    .filter(([, d]) => d.type === "positional" && d.required !== false)
    .map(([name]) => (isUrlShaped(name) ? "https://h.test/x" : "1"));
  const required = Object.entries(node.defs)
    .filter(([, d]) => d.type !== "positional" && d.required)
    .flatMap(([name, d]) => [`--${name}`, FLAG_VALUES[name] ?? (isUrlShaped(name) ? "https://h.test/x" : (firstEnumValue(d.description) ?? "x"))]);
  return [...node.path, ...positionals, ...required];
}

/** Every runnable node once bare, and once per own (non-global) boolean flag. */
export async function discoverSweepVariants(): Promise<SweepVariant[]> {
  const out: SweepVariant[] = [];
  for (const node of await allNodes()) {
    if (!node.run) continue;
    const base = bareArgv(node);
    out.push({ path: node.path, argv: base, variant: "read" });
    for (const [name, d] of Object.entries(node.defs)) {
      if (d.type === "boolean" && !GLOBAL_FLAG_NAMES.has(name)) out.push({ path: node.path, argv: [...base, `--${name}`], variant: `+--${name}` });
    }
  }
  return out;
}
