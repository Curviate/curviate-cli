/**
 * Help as a contract, held for every command (the backfill allowlist is
 * empty, so there is none): a risk class and the rules it requires, every
 * limit-shaped number bound to the published schema or cited as LinkedIn's,
 * and every command named in copy as a full, live path. The rules are pure
 * functions over `commands.json` (held equal to the live registry by
 * commands-manifest.test.ts); each control feeds the same function a
 * doctored copy.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pkgRoot } from "./helpers/pkg.js";
import { literals, walkTs } from "./helpers/literals.js";
import { readManifest, type ManifestCommand as Base } from "./helpers/examples.js";

type Cmd = Omit<Base, "args"> & { description: string; risk?: string; rules?: Record<string, unknown>; errors?: Record<string, string>; seeAlso?: string[]; document?: string; args: Array<{ name: string; description?: string }> };
const read = <T>(f: string) => JSON.parse(readFileSync(join(pkgRoot, f), "utf8")) as T;
const manifest = readManifest() as Cmd[];
const limits = read<{ bound: Array<{ command: string; number: number; pointer: string }>; cited: Array<{ command: string; number: number; enforcer: string }> }>("test/fixtures/help-limits.json");
const openapi = read<unknown>("test/fixtures/openapi.json");
const pathOf = (c: { path: string[] }) => c.path.join(" ");
const last = <T>(xs: readonly T[] | undefined): T | undefined => xs?.[xs.length - 1];
const at = (doc: unknown, pointer: string) => pointer.split("/").slice(1).reduce((o, k) => (o as Record<string, unknown>)?.[k.replace(/~1/g, "/").replace(/~0/g, "~")], doc);

/** Every rule of the risk-class contract a command breaks (empty when it complies). */
function contract(c: Cmd, budgetRows: Set<string>): string[] {
  const p: string[] = [];
  const r = c.rules ?? {};
  if (!["read", "write", "high"].includes(c.risk ?? "")) return ["declares no risk class"];
  if (c.globals.includes("preview") && c.risk === "read") p.push("declares --preview but is read");
  if ((last(c.path) === "delete" || ["account disconnect", "webhook delete"].includes(pathOf(c))) && c.risk !== "high") p.push("must be high");
  if (c.risk !== "read") {
    for (const k of ["changes", "visible_to", "retry", "undo"]) if (typeof r[k] !== "string" || !r[k]) p.push(`rules.${k}`);
    if (!Array.isArray(r["budget_rows"])) p.push("rules.budget_rows");
    for (const row of (r["budget_rows"] as string[] | undefined) ?? []) if (!budgetRows.has(row)) p.push(`budget row ${row} is not published`);
    if (!c.errors) p.push("ERRORS");
  }
  if (c.risk === "high" && (!r["blast_radius"] || !c.seeAlso?.length)) p.push("blast_radius and SEE ALSO");
  if (!c.examples.length) p.push("EXAMPLES");
  return p;
}

describe("help sections and risk classes", () => {
  const budgetRows = new Set(at(openapi, "/paths/~1v1~1accounts~1{account_id}/get/responses/200/content/application~1json/schema/properties/quotas/items/properties/budget_row/enum") as string[]);
  const runnable = manifest.filter((c) => !c.usageOnly);

  it("every runnable command meets its class", () => {
    expect(budgetRows.has("connection_requests_with_note")).toBe(true);
    expect(runnable.map(pathOf)).toEqual(expect.arrayContaining(["account disconnect", "webhook delete", "core connect"]));
    expect(runnable.flatMap((c) => contract(c, budgetRows).map((m) => `${pathOf(c)}: ${m}`))).toEqual([]);
    // Controls: each rule reds on a doctored copy of a complying command.
    const disconnect = runnable.find((c) => pathOf(c) === "account disconnect")!;
    const doctor = (f: (c: Cmd) => void) => {
      const c = structuredClone(disconnect);
      f(c);
      return contract(c, budgetRows);
    };
    expect(doctor((c) => delete c.rules!["undo"])).toEqual(["rules.undo"]);
    expect(doctor((c) => (c.rules!["budget_rows"] = ["invites"]))).toEqual(["budget row invites is not published"]);
    expect(doctor((c) => (c.risk = "write"))).toEqual(["must be high"]);
    expect(doctor((c) => delete c.seeAlso)).toEqual(["blast_radius and SEE ALSO"]);
  });
});

const NUMBER = /\b(?:up to|at most|at least|max(?:imum)?|min(?:imum)?|within)\s+(\d[\d,]*)|\b(\d[\d,]*)\s*(?:-\s*\d+\s*)?(characters?|chars|items?|ids|rows|bytes|seconds?|minutes?|hours?|days?|[kmg]ib|invitations?|messages?|people|accounts?|requests?|results?|pages?)\b/gi;
const UNIT = /^\s*(?:-\s*\d+\s*)?(characters?|chars|items?|ids|rows|bytes|seconds?|minutes?|hours?|days?|[kmg]ib|invitations?|messages?|people|accounts?|requests?|results?|pages?)\b/i;

describe("every number in help is the enforced one", () => {
  const text = (c: Cmd) => [c.description, ...c.args.map((a) => a.description ?? ""), ...Object.values(c.rules ?? {}).flat(), ...Object.values(c.errors ?? {}), ...(c.requires ?? [])].join("\n");
  const numbers = (s: string) => [...s.matchAll(NUMBER)].map((m) => ({ n: Number((m[1] ?? m[2])!.replace(/,/g, "")), unit: m[2] !== undefined || UNIT.test(s.slice(m.index! + m[0].length)) }));
  const tableProblems = (table: typeof limits, spec: unknown) => [
    ...table.bound.filter((b) => at(spec, b.pointer) !== b.number).map((b) => `${b.command}: ${b.number} is not the schema's`),
    ...table.cited.filter((c) => c.enforcer !== "LinkedIn").map((c) => `${c.command}: ${c.number} is cited but not LinkedIn's`),
  ];
  const problems = (c: Cmd, table = limits) =>
    numbers(text(c)).flatMap(({ n, unit }) => {
      const known = [...table.bound, ...table.cited].some((e) => e.command === pathOf(c) && e.number === n);
      return [...(known ? [] : [`${pathOf(c)}: ${n} is neither bound nor cited`]), ...(unit ? [] : [`${pathOf(c)}: ${n} has no unit`])];
    });

  it("each limit-shaped number is bound or cited, with a unit; bound ones equal the schema, cited ones are LinkedIn's", () => {
    expect(manifest.flatMap((c) => problems(c))).toEqual([]);
    expect(tableProblems(limits, openapi)).toEqual([]);
    const connect = manifest.find((c) => pathOf(c) === "core connect")!;
    expect(problems(connect)).toEqual([]);
    // Controls: an unlisted number, a number with no unit, a citation of a server limit, a schema drifted under a binding.
    expect(problems({ ...connect, description: "Sends up to 99 items." })).toEqual(["core connect: 99 is neither bound nor cited"]);
    expect(problems({ ...connect, description: "Up to 300." }).some((p) => p.endsWith("has no unit"))).toBe(true);
    const drifted = structuredClone(openapi);
    (at(drifted, limits.bound[0]!.pointer.replace(/\/maxLength$/, "")) as Record<string, number>)["maxLength"] = 301;
    expect(tableProblems(limits, drifted)).toEqual(["core connect: 300 is not the schema's"]);
    expect(tableProblems({ ...limits, cited: [{ command: "core x", number: 50, enforcer: "Curviate" }] }, openapi)).toEqual(["core x: 50 is cited but not LinkedIn's"]);
  });
});

/** Does `curviate <words>` name a live path? Words run until the first one that is not a command word. */
function resolves(words: string[]): boolean {
  const byPath = new Map(manifest.map((c) => [pathOf(c), c]));
  let here: string[] = [];
  for (const w of words) {
    if (!/^[a-z][a-z0-9-]*$/.test(w)) break;
    const next = [...here, w].join(" ");
    if (byPath.has(next)) here = [...here, w];
    else if (here.length === 0) return false;
    else if (byPath.get(here.join(" "))!.usageOnly) return false;
    else break;
  }
  return here.length > 0 || words.length === 0 || !/^[a-z]/.test(words[0]!);
}
/**
 * A quoted span that starts with any command name in the tree (a group, a
 * subcommand or a leaf: `notification list`, `checkpoint solve`, `save-lead`)
 * without `curviate`: a relative form, never allowed. The name set is derived
 * from the registry, so a new command is covered the day it lands.
 */
const COMMAND_NAMES = [...new Set(manifest.flatMap((c) => c.path))].sort((a, b) => b.length - a.length);
const relativeNames = (text: string, names = COMMAND_NAMES) =>
  [...text.matchAll(new RegExp(`\`(?:${names.map((n) => n.replace(/[-]/g, "\\-")).join("|")})(?: [^\`]*)?\`|'(?:${names.map((n) => n.replace(/[-]/g, "\\-")).join("|")}) [^']*'`, "g"))].map((m) => m[0]);
const mentions = (text: string) => [...text.matchAll(/(?<![\w/.@-])curviate((?: [a-z][a-z0-9-]*)*)/g)].map((m) => m[1]!.trim().split(" ").filter(Boolean));

describe("every command named in copy is a full, live path", () => {
  it("in src string literals, commands.json and README.md: every `curviate ...` resolves, and no command is named relatively", () => {
    const sources: Array<[string, string]> = [
      ...walkTs(resolve(pkgRoot, "src")).flatMap((f) => literals(f, readFileSync(f, "utf8")).map((l): [string, string] => [`${relative(pkgRoot, f)}:${l.line}`, l.text])),
      ["commands.json", readFileSync(join(pkgRoot, "commands.json"), "utf8")],
      ["README.md", readFileSync(join(pkgRoot, "README.md"), "utf8")],
    ];
    const dead = sources.flatMap(([where, text]) => mentions(text).filter((w) => !resolves(w)).map((w) => `${where}: curviate ${w.join(" ")}`));
    expect(sources.flatMap(([, t]) => mentions(t)).length).toBeGreaterThan(400);
    expect(dead).toEqual([]);
    expect(sources.flatMap(([where, text]) => relativeNames(text).map((r) => `${where}: ${r}`))).toEqual([]);
    expect(COMMAND_NAMES).toEqual(expect.arrayContaining(["checkpoint", "save-candidate", "project-job", "show-less", "solve"]));
    expect([
      relativeNames("The card_urn of a `notification list` item."),
      relativeNames("Solve it with `checkpoint solve`; write commands (`save-lead`, `project-job create`/`update`)."),
      relativeNames("`curviate core company chats`, `--company`, `primary`, `company_id`, `saved-leads`"),
      relativeNames("To list comments on a post, use 'comment list <post_id>'. Pass 'me' for yourself."),
    ]).toEqual([["`notification list`"], ["`checkpoint solve`", "`save-lead`", "`project-job create`", "`update`"], [], ["'comment list <post_id>'"]]);
    // Controls: an old path and an unknown subcommand under a pure group are dead; a positional after a bare form is not.
    expect([["profile", "me"], ["core", "inbox", "sync"], ["account", "bogus"]].map(resolves)).toEqual([false, false, false]);
    expect([["core", "profile", "me"], ["core", "connect", "janesmith"], ["account", "get"]].map(resolves)).toEqual([true, true, true]);
  });
});
