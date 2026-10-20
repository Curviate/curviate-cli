/**
 * The command tree and help as a contract: the `core` namespace, the hard
 * break of the old paths, full-path references, the fixed help-section order
 * and risk classes, the numbers rule, the flag and verb vocabulary. The rules
 * are pure functions over `commands.json` (the registry as data, held equal to
 * the live registry by commands-manifest.test.ts), so each control feeds the
 * same function a doctored copy; the runtime arms go through the entry point
 * against a recording sink, every refusal paired with a same-path control.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pkgRoot } from "./helpers/pkg.js";
import { literals, walkTs } from "./helpers/literals.js";
import { readManifest, type ManifestCommand as Base } from "./helpers/examples.js";
import { useSink, line } from "./helpers/sink.js";
import { EXIT_CODE_MAP } from "../src/lib/exit-codes.js";
import { SECTION_ORDER } from "../src/lib/examples.js";

type Cmd = Omit<Base, "args"> & { description: string; risk?: string; rules?: Record<string, unknown>; errors?: Record<string, string>; seeAlso?: string[]; document?: string; args: Array<{ name: string; type?: string; required?: boolean; default?: unknown; alias?: string | string[]; description?: string }> };
const read = <T>(f: string) => JSON.parse(readFileSync(join(pkgRoot, f), "utf8")) as T;
const manifest = readManifest() as Cmd[];
const frozen = read<{ commands: Array<{ path: string[]; usageOnly: boolean; args: Array<Record<string, unknown>>; globals: string[] }> }>("test/fixtures/commands-0.47.0.json").commands;
const allowlist = read<{ commands: string[] }>("test/fixtures/help-backfill-allowlist.json").commands;
const limits = read<{ bound: Array<{ command: string; number: number; pointer: string }>; cited: Array<{ command: string; number: number; enforcer: string }> }>("test/fixtures/help-limits.json");
const openapi = read<unknown>("test/fixtures/openapi.json");
const pathOf = (c: { path: string[] }) => c.path.join(" ");
const last = <T>(xs: readonly T[] | undefined): T | undefined => xs?.[xs.length - 1];
const at = (doc: unknown, pointer: string) => pointer.split("/").slice(1).reduce((o, k) => (o as Record<string, unknown>)?.[k.replace(/~1/g, "/").replace(/~0/g, "~")], doc);

const CORE = ["profile", "company", "job", "connect", "search", "inbox", "inboxes", "message", "post", "comment", "sales-nav", "recruiter", "group", "feed", "notification", "draft"];
const ROOT = ["setup", "doctor", "login", "config", "account", "webhook", "core"];
const RESERVED = ["motion", "contact", "unibox", "network", "analytics", "notification", "team"];
const sink = useSink((h) => ({ body: h.method === "GET" ? { object: "list", items: [], cursor: null, id: "x1", provider_id: "p" } : { object: "invitation", id: "inv_1" } }));
const GENERIC = "error: unknown command at argument 1\nRun `curviate --help` for usage.\n";

describe("the tree", () => {
  it("root holds exactly setup, doctor, login, config, account, webhook, core (reserved groups unused until they land); core holds the 16 LinkedIn groups in order", () => {
    const children = (prefix: string[]) => manifest.filter((c) => c.path.length === prefix.length + 1 && prefix.every((p, i) => c.path[i] === p)).map((c) => last(c.path));
    expect(children([])).toEqual(ROOT);
    expect(children(["core"])).toEqual(CORE);
    expect(children([]).filter((k) => !ROOT.includes(k!) && !RESERVED.includes(k!))).toEqual([]);
    expect(children([]).some((k) => k === "contact-list" || k === "tag" || k === "skill")).toBe(false);
    const runnableUnder = (c: Cmd) => manifest.some((d) => !d.usageOnly && d.path.length > c.path.length && pathOf(d).startsWith(`${pathOf(c)} `));
    expect(manifest.filter((c) => c.usageOnly && !runnableUnder(c)).map(pathOf)).toEqual([]);
    expect(manifest.some((c) => pathOf(c) === "core recruiter job create")).toBe(true); // control: the walk reaches depth 4
  });

  it("each moved group equals 0.47.0 in structure with `core` inserted, except the flag renames", () => {
    const RENAMES: Record<string, { removed: string[]; added: string[] }> = {
      "core recruiter job create": { removed: ["body-file", "body"], added: ["file"] },
      "core recruiter project-job create": { removed: ["body-file", "body"], added: ["file"] },
      "core recruiter project-job update": { removed: ["body-file", "body"], added: ["file"] },
      "webhook verify": { removed: ["body"], added: ["file"] },
    };
    const shape = (args: Array<Record<string, unknown>>, drop: string[] = []) =>
      args.filter((a) => !drop.includes(a["name"] as string)).map((a) => JSON.stringify([a["name"], a["type"], a["required"], a["default"], a["alias"]]));
    const now = new Map(manifest.filter((c) => pathOf(c) !== "core").map((c) => [pathOf(c), c]));
    const diff: string[] = [];
    for (const old of frozen) {
      const key = (CORE.includes(old.path[0]!) ? ["core", ...old.path] : old.path).join(" ");
      const cur = now.get(key);
      now.delete(key);
      if (!cur) {
        diff.push(`${key}: missing`);
        continue;
      }
      const r = RENAMES[key];
      if (JSON.stringify([shape(old.args, r?.removed), old.globals, old.usageOnly]) !== JSON.stringify([shape(cur.args, r?.added), cur.globals, cur.usageOnly])) diff.push(`${key}: changed`);
      if (r && (!r.removed.every((n) => old.args.some((a) => a["name"] === n)) || !r.added.every((n) => cur.args.some((a) => a.name === n)))) diff.push(`${key}: rename not applied`);
    }
    expect(frozen.length).toBe(186);
    expect([...now.keys()]).toEqual([]); // no command added beside `core` itself
    expect(diff).toEqual([]);
  });
});

describe("the hard break: old paths exit 2 with the generic error, never a hint, never a request", () => {
  const firstSub = (g: string) => manifest.find((c) => c.path.length === 3 && c.path[1] === g)!.path[2]!;

  it.each(CORE)("%s: bare, with a subcommand, --help and -h", async (g) => {
    for (const argv of [[g], [g, firstSub(g), "x1"], [g, "--help"], [g, firstSub(g), "--help"], [g, "-h"]]) {
      const r = await sink.run([...argv, "--account", "acc_1"]);
      expect([argv.join(" "), r.status, r.stderr, r.requests.length]).toEqual([argv.join(" "), 2, GENERIC, 0]);
    }
    const ok = await sink.run(["core", g, "--help"]);
    expect([ok.status, ok.stdout]).toEqual([0, expect.stringContaining(`curviate core ${g}`)]);
  });

  it("help never rescues an unresolvable token; a bindable positional keeps its help", async () => {
    for (const argv of [["core", "inbx", "--help"], ["core", "profile", "me", "mex", "--help"], ["profilex", "--help"]]) {
      const r = await sink.run(argv);
      expect([argv.join(" "), r.status, r.stderr]).toEqual([argv.join(" "), 2, expect.stringMatching(/^error: (unknown command|unexpected argument)/)]);
      expect(r.stdout).toBe("");
    }
    const bound = await sink.run(["core", "profile", "janesmith", "--help"]);
    expect([bound.status, bound.stdout]).toEqual([0, expect.stringContaining("USAGE `curviate core profile")]);
  });

  it("no command name is ever suggested; `core connect respond` sends nothing; the stray-positional hint names a full path", async () => {
    for (const argv of [["core", "inbox", "sync"], ["core", "post", "list"], ["core", "inbx", "list"], ["inbox", "list"], ["core", "connect", "respond"]]) {
      const r = await sink.run([...argv, "--account", "acc_1"]);
      expect([argv.join(" "), r.status, r.stderr.includes("hint:"), r.requests.length]).toEqual([argv.join(" "), 2, false, 0]);
    }
    const control = await sink.run(["core", "connect", "janesmith", "--account", "acc_1"]);
    expect([control.status, control.requests.map(line)]).toEqual([0, ["POST /v1/acc_1/invites"]]);
    const stray = await sink.run(["core", "profile", "me", "relations"]);
    expect([stray.status, stray.stderr]).toEqual([2, expect.stringContaining("hint: Did you mean `curviate core profile relations`?")]);
  });

  it("the bare forms move whole: one request each, the write guard holds", async () => {
    for (const [argv, request] of [
      [["core", "connect", "janesmith"], "POST /v1/acc_1/invites"],
      [["core", "profile", "https://www.linkedin.com/in/janesmith"], "GET /v1/acc_1/users/janesmith"],
      [["core", "message", "2-abc", "hi"], "POST /v1/acc_1/chats/2-abc/messages"],
    ] as const) {
      const r = await sink.run([...argv, "--account", "acc_1", "--json"]);
      expect([r.status, r.requests.map(line)], r.stderr).toEqual([0, [request]]);
    }
    const guarded = await sink.run(["core", "connect", "snet", "--account", "acc_1"]);
    expect([guarded.status, guarded.requests.length]).toEqual([2, 0]);
  });

  it("global flags before core, between core and the group, and after the leaf send byte-identical requests", async () => {
    const wire = async (argv: string[]) => (await sink.run(argv)).requests.map((q) => [q.method, q.url, q.body, q.headers.authorization]);
    const after = await wire(["core", "profile", "me", "--json", "--account", "acc_1"]);
    expect(after).toEqual([["GET", "/v1/acc_1/users/me", "", "Bearer cvt_test_sink"]]);
    expect(await wire(["--json", "--account", "acc_1", "core", "profile", "me"])).toEqual(after);
    expect(await wire(["core", "--json", "--account", "acc_1", "profile", "me"])).toEqual(after);
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
 * A backticked span that starts with any command name in the tree (a group, a
 * subcommand or a leaf: `notification list`, `checkpoint solve`, `save-lead`)
 * without `curviate`: a relative form, never allowed. The name set is derived
 * from the registry, so a new command is covered the day it lands.
 */
const COMMAND_NAMES = [...new Set(manifest.flatMap((c) => c.path))].sort((a, b) => b.length - a.length);
const relativeNames = (text: string, names = COMMAND_NAMES) =>
  [...text.matchAll(new RegExp(`([\`'])(?:${names.map((n) => n.replace(/[-]/g, "\\-")).join("|")})(?: [^\`']*)?\\1`, "g"))].map((m) => m[0]);
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
      relativeNames("To list comments on a post, use 'comment list <post_id>'."),
    ]).toEqual([["`notification list`"], ["`checkpoint solve`", "`save-lead`", "`project-job create`", "`update`"], [], ["'comment list <post_id>'"]]);
    // Controls: an old path and an unknown subcommand under a pure group are dead; a positional after a bare form is not.
    expect([["profile", "me"], ["core", "inbox", "sync"], ["account", "bogus"]].map(resolves)).toEqual([false, false, false]);
    expect([["core", "profile", "me"], ["core", "connect", "janesmith"], ["account", "get"]].map(resolves)).toEqual([true, true, true]);
  });
});

describe("group help", () => {
  const CORE_TEXT =
    "Curviate core: LinkedIn building blocks. Each command runs one action now, from one Account, and counts against that Account's budgets. Nothing is queued, paced or retried for you, except a Draft scheduled with `--schedule-at`, which Curviate publishes at that time (`curviate core draft create`).";
  const CORE_RULES = [
    "Writes reach LinkedIn immediately and are seen by the people they touch.",
    "A retry after a timeout can repeat a write: requests carry no idempotency key. Read the current state before retrying.",
    "Budget rows, ceilings and what is left: `curviate account get <account_id>`.",
  ];

  it("root ends with SEE ALSO naming the plugin and the docs; `core` and `core --help` print the same text, the 16 groups in order, exit 0", async () => {
    const root = await sink.run(["--help"]);
    expect(root.status).toBe(0);
    expect(root.stdout.trimEnd()).toMatch(/SEE ALSO\n\n.*https:\/\/github\.com\/curviate\/curviate-plugin\n.*https:\/\/docs\.curviate\.com\/reference\/cli$/);
    const [bare, help] = [await sink.run(["core"]), await sink.run(["core", "--help"])];
    expect([bare.status, help.status, bare.stdout]).toEqual([0, 0, help.stdout]);
    expect(help.stdout).toContain(CORE_TEXT);
    expect(help.stdout).toContain(`RULES\n\n${CORE_RULES.map((l) => `  ${l}`).join("\n")}\n`);
    const listed = [...help.stdout.matchAll(/^\s+`([a-z-]+)`/gm)].map((m) => m[1]);
    expect(listed).toEqual(CORE);
  });
});

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
  const held = runnable.filter((c) => !allowlist.includes(pathOf(c)));
  const frozenPaths = new Set(frozen.map((c) => (CORE.includes(c.path[0]!) ? ["core", ...c.path] : c.path).join(" ")));

  it("every command off the backfill allowlist meets its class; the list only shrinks", () => {
    expect(budgetRows.has("connection_requests_with_note")).toBe(true);
    expect(held.map(pathOf)).toEqual(expect.arrayContaining(["account disconnect", "webhook delete"]));
    expect(held.flatMap((c) => contract(c, budgetRows).map((m) => `${pathOf(c)}: ${m}`))).toEqual([]);
    const live = new Set(runnable.map(pathOf));
    expect(allowlist.filter((p) => !live.has(p) || !frozenPaths.has(p) || p === "account disconnect" || p === "webhook delete")).toEqual([]);
    expect(runnable.filter((c) => allowlist.includes(pathOf(c)) && contract(c, budgetRows).length === 0).map(pathOf)).toEqual([]);
    // Controls: each rule reds on a doctored copy of a complying command.
    const disconnect = held.find((c) => pathOf(c) === "account disconnect")!;
    const doctor = (f: (c: Cmd) => void) => {
      const c = structuredClone(disconnect);
      f(c);
      return contract(c, budgetRows);
    };
    expect(doctor((c) => delete c.rules!["undo"])).toEqual(["rules.undo"]);
    expect(doctor((c) => (c.rules!["budget_rows"] = ["invites"]))).toEqual(["budget row invites is not published"]);
    expect(doctor((c) => (c.risk = "write"))).toEqual(["must be high"]);
    expect(doctor((c) => delete c.seeAlso)).toEqual(["blast_radius and SEE ALSO"]);
    expect(frozenPaths.has("core motion create")).toBe(false); // a command added after 0.47.0 could not be allowlisted
  });

  it("help prints only the sections that apply, in the fixed order, EXAMPLES last; ERRORS exit numbers are EXIT_CODE_MAP's", { timeout: 120_000 }, async () => {
    const bad: string[] = [];
    for (const c of manifest) {
      const r = await sink.run([...c.path, "--help"]);
      const titles = [...r.stdout.matchAll(/^([A-Z][A-Z ]+)\n\n/gm)].map((m) => m[1]!).filter((t) => (SECTION_ORDER as readonly string[]).includes(t));
      const sorted = [...titles].sort((a, b) => SECTION_ORDER.indexOf(a as never) - SECTION_ORDER.indexOf(b as never));
      if (r.status !== 0 || JSON.stringify(titles) !== JSON.stringify(sorted)) bad.push(`${pathOf(c)}: ${titles.join(",")}`);
      if (c.examples.length && last(titles) !== "EXAMPLES") bad.push(`${pathOf(c)}: EXAMPLES not last`);
      for (const m of r.stdout.matchAll(/^ {2}([A-Z][A-Z_]+) \(exit (\d+)\): /gm)) {
        if ((EXIT_CODE_MAP as Record<string, number>)[m[1]!] !== Number(m[2])) bad.push(`${pathOf(c)}: ${m[1]} exit ${m[2]}`);
      }
    }
    expect(bad).toEqual([]);
    const disconnect = await sink.run(["account", "disconnect", "--help"]);
    expect(disconnect.stdout).toMatch(/RULES\n\n {2}Changes: .*\n {2}Visible to: .*\n {2}Budget rows: none\n {2}Retry: .*\n {2}Undo: .*\n {2}Blast radius: .*\n\nERRORS\n\n {2}ACCOUNT_NOT_FOUND \(exit 4\): .*\n\nSEE ALSO\n\n {2}curviate account list\n {2}curviate account link\n\nEXAMPLES\n/);
  });

  it("a multi-line example is only a document command's last one, a `--file -` heredoc; webhook verify carries none", () => {
    const multi = runnable.flatMap((c) => c.examples.filter((e) => e.includes("\n")).map((e) => ({ c, e, last: e === last(c.examples) })));
    expect(multi.map(({ c }) => pathOf(c)).sort()).toEqual(["core recruiter job create", "core recruiter project-job create", "core recruiter project-job update"]);
    expect(multi.filter(({ c, e, last }) => !last || !c.document || !/ --file - <<'EOF'\n[\s\S]+\nEOF$/.test(e))).toEqual([]);
    expect(runnable.find((c) => pathOf(c) === "webhook verify")!.examples.join("\n")).not.toContain("<<");
  });
});

const NUMBER = /\b(?:up to|at most|at least|max(?:imum)?|min(?:imum)?|within)\s+(\d[\d,]*)|\b(\d[\d,]*)\s*(?:-\s*\d+\s*)?(characters?|chars|items?|ids|rows|bytes|seconds?|minutes?|hours?|days?|invitations?|people|accounts?|requests?|results?|pages?)\b/gi;
const UNIT = /^\s*(?:-\s*\d+\s*)?(characters?|chars|items?|ids|rows|bytes|seconds?|minutes?|hours?|days?|invitations?|people|accounts?|requests?|results?|pages?)\b/i;

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

  it("each limit-shaped number off the allowlist is bound or cited, with a unit; bound ones equal the schema, cited ones are LinkedIn's", () => {
    expect(manifest.filter((c) => !allowlist.includes(pathOf(c))).flatMap((c) => problems(c))).toEqual([]);
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

describe("facts in help, judgement in skills", () => {
  const NOTE =
    "Note shown with the invitation. Up to 300 characters on LinkedIn Premium; LinkedIn allows 200 on a free account and a note on about 5 invitations a month (budget row `connection_requests_with_note`, see `curviate account get`). Omit it to send the invitation without a note.";
  const claimsOutcome = (s: string) => s.split(/(?<=[.!?])\s+/).some((x) => /\b(increase|improve|boost|raise|lift)s?\b/i.test(x) && /\b(acceptance|reply|replies|response)\b/i.test(x));

  it("`core connect --note` states the mechanics; no help sentence claims an outcome; no skill command", async () => {
    expect(manifest.find((c) => pathOf(c) === "core connect")!.args.find((a) => a.name === "note")!.description).toBe(NOTE);
    const help = await sink.run(["core", "connect", "--help"]);
    expect(help.stdout.replace(/\s+/g, " ")).toContain(NOTE.slice(0, 60));
    const all = manifest.flatMap((c) => [c.description, ...c.args.map((a) => a.description ?? "")]);
    expect(all.filter(claimsOutcome)).toEqual([]);
    expect(manifest.some((c) => c.path.includes("skill"))).toBe(false);
    expect([claimsOutcome("Notes increase acceptance."), claimsOutcome("Shows the acceptance rate.")]).toEqual([true, false]);
  });
});

describe("one vocabulary", () => {
  const DENY = ["out", "body", "body-file", "input", "in", "fmt", "outfile", "json-file", "team", "dry-run", "idempotency-key"];
  const VERBS = new Set(["list", "get", "create", "update", "delete", "start", "pause", "resume", "archive", "import", "export", "add", "remove", "lint", "init",
    "preview", "signal", "stop", "enroll", "reply", "mark", "tag", "refresh", "consent", "count", "read", "read-all", "unarchive", "cancel", "enrich", "invite", "resend", "revoke", "role", "leave", "switch", "unread", "status",
    "members", "invites", "messages", "accounts", "connections"]);
  const FROZEN_LEAVES = new Set(frozen.filter((c) => ["account", "webhook", "config"].includes(c.path[0]!) && c.path.length > 1).map((c) => last(c.path)!));
  const flagNames = (c: Cmd) => [...c.args.flatMap((a) => [a.name, ...([] as string[]).concat(a.alias ?? [])]), ...c.globals];
  const denied = (cs: Cmd[]) => cs.flatMap((c) => flagNames(c).filter((f) => DENY.includes(f) && !(f === "team" && pathOf(c) === "setup")).map((f) => `${pathOf(c)} --${f}`));
  const strayLeaves = (cs: Cmd[]) => cs.filter((c) => !c.usageOnly && c.path.length > 1 && c.path[0] !== "core" && !VERBS.has(last(c.path)!) && !FROZEN_LEAVES.has(last(c.path)!)).map(pathOf);

  it("no command declares a denylisted flag (--team only on setup); every leaf under a non-core group is an approved verb or a frozen 0.47.0 leaf", () => {
    expect(denied(manifest)).toEqual([]);
    expect(strayLeaves(manifest)).toEqual([]);
    const fake = { ...manifest.find((c) => pathOf(c) === "webhook list")!, path: ["contact", "add-contacts"] };
    expect([denied([{ ...fake, globals: ["out"] }]), strayLeaves([fake])]).toEqual([["contact add-contacts --out"], ["contact add-contacts"]]);
  });

  it("a mistyped flag exits 2 with no request and names the one close declared flag; a far one names none", async () => {
    const typo = await sink.run(["core", "connect", "janesmith", "--not", "x", "--account", "acc_1"]);
    expect([typo.status, typo.requests.length, typo.stderr]).toEqual([2, 0, expect.stringContaining("hint: did you mean --note?")]);
    const far = await sink.run(["core", "connect", "janesmith", "--zzzzzz", "x", "--account", "acc_1"]);
    expect([far.status, far.requests.length, far.stderr.includes("hint:")]).toEqual([2, 0, false]);
    const control = await sink.run(["core", "connect", "janesmith", "--note", "x", "--account", "acc_1"]);
    expect([control.status, control.requests.length]).toEqual([0, 1]);
  });
});

describe("the release", () => {
  it("is the next minor after 0.47.0 with the SDK pin unchanged; its CHANGELOG section lists every move, the notification change, each rename, the removed hints and the no-hint rule", () => {
    const pkg = read<{ version: string; dependencies: Record<string, string> }>("package.json");
    expect([pkg.version, pkg.dependencies["@curviate/sdk"]]).toEqual(["0.48.0", "0.42.0"]);
    const changelog = readFileSync(join(pkgRoot, "CHANGELOG.md"), "utf8");
    const section = changelog.slice(changelog.indexOf("## [0.48.0]"), changelog.indexOf("## [0.47.0]"));
    const breaking = section.slice(section.indexOf("### Changed (breaking)"), section.indexOf("### Added"));
    expect(CORE.filter((g) => !breaking.includes(`- \`curviate ${g} ...\` is now \`curviate core ${g} ...\`.`))).toEqual([]);
    for (const s of ["`notification` changes meaning", "`--body-file <path>` and `--body -` are\n  now `--file <path|->`", "`webhook verify`: `--body <inline|path|->` is now `--file <path|->`", "successor hints are removed", "names no\nsuccessor: no hint"]) {
      expect(breaking, s).toContain(s);
    }
  });
});
