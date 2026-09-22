/**
 * The readableObject guard's authority, per the exit-code spec's As-built
 * amendment (qa cycle 2): a runtime sweep over the CLI's ACTUAL command
 * registry and ACTUAL wire behaviour, not a source-code pattern. A static
 * AST scan (the prior approach) is fundamentally fragile
 * to how a read happens to be written — inline `--preview` refusal, an
 * inlined `renderSuccess(await ns.x())` with no intermediate variable, a
 * property-access render argument (`renderSuccess(result.data)`), an
 * arrow-function export, render via a shared helper's parameter, or a
 * guard reachable only under a conditional all defeat a syntax check while
 * leaving the actual bug (or actual fix) in place. None of them can hide
 * from this sweep: it invokes the built binary and inspects what actually
 * happened.
 *
 * Two things are derived from the LIVE command tree, never hand-written:
 *   - every leaf command (`allNodes()`, shared with streaming-nodes.ts —
 *     walks the citty registry objects themselves, so it does not care
 *     whether a handler is a `function` declaration or an arrow export);
 *   - every command-specific boolean flag on each leaf, by excluding the
 *     keys of the shared `GLOBAL_FLAGS` object (imported, not retyped) —
 *     the flags every command inherits (`--json`, `--all`, `--preview`,
 *     `--verbose`, `--beta`) are not branch selectors, but a leaf's OWN
 *     boolean flags often are (`--posts`, `--is-company`, `--unread`, ...).
 *     Each gets its own swept variant, alongside the bare one.
 *
 * Classification, per variant: invoke the built CLI against a local stub
 * that answers every request with a `null` 200 body (`runAgainstStub` also
 * takes `EMPTY_200_BODY`/`EMPTY_204_BODY`/`EMPTY_OBJECT_BODY` — see
 * found by qa verifying the prior As-built: an empty or absent 2xx body decodes to `{}` in
 * the SDK, a second unreadable shape `readableObject` now also rejects),
 * and record every HTTP method it sent. A variant that sent ONLY `GET`
 * requests is a read; it
 * MUST exit 7. Any non-GET request means the command can legitimately
 * render a genuine `204`/null body on success (a write) — not constrained
 * here. Zero requests (a usage error, or a bare group that only prints
 * help) means nothing was exercised — MUST be one of the reviewed,
 * enumerated `ZERO_REQUEST_ALLOWLIST` entries below, or the sweep reds on
 * it by name (qa cycle 3: a wrong-argv miss silently landing in "sent
 * nothing, not constrained" is exactly how `profile <id>` and `recruiter
 * applicant <p> <a>` escaped this sweep the first time — see
 * `SWEEP_ARGV_OVERRIDES`'s doc for the argv fix and this file's
 * `ZERO_REQUEST_ALLOWLIST` doc for why each entry that remains is
 * legitimate). `READ_BY_POST` below separately holds the small number of
 * reads that send a non-GET verb to the exit-7 standard, since the
 * GET-only rule cannot see them either.
 */

import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GLOBAL_FLAGS } from "../../src/lib/global-flags.js";
import { allNodes, OVERRIDES as STREAMING_OVERRIDES, FLAG_VALUES, type ArgDef, type Node } from "./streaming-nodes.js";
import { cliPath } from "./built-cli.js";

export type SweepVariant = { path: string[]; argv: string[]; variant: string };

const GLOBAL_FLAG_NAMES = new Set(Object.keys(GLOBAL_FLAGS));

/**
 * A leaf's OWN boolean flags, excluding the inherited global set — derived
 * from the live registry's declared arg types, never a name list.
 */
function ownBooleanFlags(node: Node): string[] {
  return Object.entries(node.defs)
    .filter(([name, d]) => d.type === "boolean" && !GLOBAL_FLAG_NAMES.has(name))
    .map(([name]) => name);
}

/**
 * A required string flag's declared description is the only place this
 * codebase writes down its allowed values (citty's own `ArgDef` has no
 * enum/pattern type) — consistently as a `|`-delimited list somewhere in
 * the prose (`"DRAFT|OPEN|CLOSED..."`, `"messaging | user |
 * account_status"`, `"FREE|PROMOTED|PROMOTED_PLUS"`). Derived from that
 * text at sweep time, not a value hand-picked per flag name.
 */
function firstEnumValueFromDescription(description: string | undefined): string | null {
  if (!description) return null;
  const m = description.match(/\b([A-Za-z][\w-]*)\s*\|\s*[A-Za-z]/);
  return m ? m[1]! : null;
}

/**
 * A flag/positional NAMED `url` (exactly, not merely mentioning the word
 * in prose — this codebase's `id`-style positionals routinely accept "a
 * URL, slug, or bare id" in their description, where a plain numeric value
 * already reaches the read on the fast path, so matching on description
 * text alone false-positived on `job get`'s "Job URL or a bare numeric job
 * id"). `request-url`, and the `url` positional on
 * `search`/`recruiter search`/`sales-nav search` (though those three are
 * already covered by `STREAMING_OVERRIDES` with their real, host-specific
 * shape) both end in this exact word. A plain `https://h.test/x` passes
 * only a basic scheme/well-formedness check — a defensive fallback for a
 * future URL-shaped arg this sweep hasn't been taught to override yet, not
 * a replacement for a real override once one is needed.
 */
function isUrlShaped(name: string): boolean {
  return name === "url" || name.endsWith("-url");
}

function valueFor(name: string, d: ArgDef & { description?: string }): string {
  if (FLAG_VALUES[name]) return FLAG_VALUES[name];
  if (isUrlShaped(name)) return "https://h.test/x";
  return firstEnumValueFromDescription(d.description) ?? "x";
}

function positionalValueFor(name: string): string {
  if (isUrlShaped(name)) return "https://h.test/x";
  // Numeric, not "x1": several id-shaped positionals take a resolver's
  // fast path only for a numeric-looking value (see
  // `streaming-nodes.ts`'s `argvFor` for the same reasoning) — "1" stays
  // the default for anything not URL-shaped.
  return "1";
}

/**
 * Where a generic fill (required-only, "1"/first-enum-value/"x") would not
 * reach the leaf's own read behaviour, restored per-command (qa cycle 3 —
 * dropped when this file was first written, re-derived from the proven
 * `streaming-nodes.ts` table plus two corrections this sweep needs that
 * table doesn't):
 *   - reused verbatim from `streaming-nodes.ts`'s own `OVERRIDES` for
 *     `search`/`recruiter search`/`sales-nav search` (a URL-shaped
 *     optional positional the generic fill skips: `required: false`, and a
 *     generic placeholder URL would fail each command's own host/path
 *     validation before any request), `inbox search` (a positional with an
 *     undocumented-in-metadata 3-character minimum — "1" is one char),
 *     `search groups`, `company search-chats`;
 *   - `profile` / `profile me` corrected AWAY from that same table's
 *     choice: `streaming-nodes.ts` forces `--posts` on them (it needs the
 *     PAGINATED branch for ITS sweep); this sweep needs the PLAIN branch
 *     bare, since `--posts` is already its own separately-swept variant
 *     (`ownBooleanFlags`) — forcing it into the base would make that
 *     variant redundant and leave the plain branch untested;
 *   - `recruiter project-job` / `recruiter applicant`: bare groups whose
 *     positional(s) are explicitly `required: false` so the SAME command
 *     can print multi-subcommand usage when omitted, rather than a hard
 *     usage error — the generic fill skips an optional positional
 *     entirely, so the bare invocation never reaches the read at all.
 */
const SWEEP_ARGV_OVERRIDES: Record<string, string[]> = {
  profile: ["profile", "1"],
  "profile me": ["profile", "me"],
  "recruiter project-job": ["recruiter", "project-job", "1"],
  "recruiter applicant": ["recruiter", "applicant", "1", "1"],
};

/** Minimal required positionals/flags, no branch-selecting booleans. */
function bareArgv(node: Node): string[] {
  const key = node.path.join(" ");
  if (SWEEP_ARGV_OVERRIDES[key]) return SWEEP_ARGV_OVERRIDES[key];
  if (STREAMING_OVERRIDES[key]) return STREAMING_OVERRIDES[key];
  const positionals = Object.entries(node.defs)
    .filter(([, d]) => d.type === "positional" && d.required !== false)
    .map(([name]) => positionalValueFor(name));
  const required = Object.entries(node.defs)
    .filter(([, d]) => d.type !== "positional" && d.required)
    .flatMap(([name, d]) => [`--${name}`, valueFor(name, d)]);
  return [...node.path, ...positionals, ...required];
}

/**
 * Every leaf command, as its bare invocation plus one variant per own
 * boolean flag (added individually — QA's own reference sweep swept each
 * flag alone, not in combination, and that is what reaches a command's
 * different branches one at a time, e.g. `profile <id>` bare vs.
 * `profile <id> --posts` vs. `profile <id> --comments`).
 */
export async function discoverSweepVariants(): Promise<SweepVariant[]> {
  const nodes = await allNodes();
  const out: SweepVariant[] = [];
  for (const node of nodes) {
    if (!node.run) continue;
    const base = bareArgv(node);
    out.push({ path: node.path, argv: base, variant: "read" });
    for (const flag of ownBooleanFlags(node)) {
      out.push({ path: node.path, argv: [...base, `--${flag}`], variant: `+--${flag}` });
    }
  }
  return out;
}

export type SweepResult = { status: number | null; methods: string[]; stdout: string; stderr: string };

/** A stub HTTP response shape: a status and a raw body text (`null` text = no body written at all). */
export type StubBody = { status: 200 | 204; text: string | null };

/** A literal JSON `null` (the original single-object-read shape: valid JSON, decodes to the JS value `null`). */
export const NULL_BODY: StubBody = { status: 200, text: "null" };
/** A 200 with a genuinely empty body (0 bytes) — the SDK decodes this to `{}`. */
export const EMPTY_200_BODY: StubBody = { status: 200, text: "" };
/** A 204, which by convention never carries a body — same empty-decodes-to-`{}` path as EMPTY_200_BODY. */
export const EMPTY_204_BODY: StubBody = { status: 204, text: null };
/** A literal JSON `{}` — valid JSON, decodes to a real but zero-key object. */
export const EMPTY_OBJECT_BODY: StubBody = { status: 200, text: "{}" };

/** One shared xdg dir for every spawn in a sweep run (no login state needed against a stub). */
const sweepXdg = mkdtempSync(join(tmpdir(), "curviate-sweep-"));

/**
 * Run one CLI invocation against a fresh local stub that answers every
 * request with the given body, and report which HTTP methods it sent. One
 * request-serving server per call, torn down before returning — sequential
 * by construction (the caller awaits each), which is also the RAM
 * discipline this sweep needs on this host (`test-runtime` skill): one
 * child process at a time, never fanned out.
 */
export async function runAgainstStub(argv: string[], body: StubBody = NULL_BODY): Promise<SweepResult> {
  const methods: string[] = [];
  const server: Server = createServer((req, res) => {
    methods.push(req.method ?? "?");
    req.resume();
    req.on("end", () => {
      if (body.text === null) {
        res.writeHead(body.status);
        res.end();
        return;
      }
      res.writeHead(body.status, { "content-type": "application/json" });
      res.end(body.text);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: sweepXdg, NODE_ENV: "production" };
    delete env["CURVIATE_API_KEY"];
    delete env["CURVIATE_ACCOUNT"];
    delete env["CURVIATE_BASE_URL"];
    const result = await new Promise<SweepResult>((resolve, reject) => {
      // A defensive kill-after-timeout, not a normal path: a `--wait`
      // command whose malformed-body guard regressed in the future would
      // fall through to a real 10-minute default wait-window instead of
      // throwing immediately (found the hard way — mutation-probing this
      // exact fix with a `--wait` variant in the mix hung a real child
      // process for minutes before it was caught and killed by hand). 10s
      // is generous for every real invocation in this sweep (the slowest
      // observed is ~1.1s, a `--wait` command's fixed initial poll delay).
      const signal = AbortSignal.timeout(10_000);
      const child = spawn(
        process.execPath,
        [cliPath, ...argv, "--json", "--beta", "--api-key", "cvt_test_x", "--account", "acc_1", "--base-url", `http://127.0.0.1:${port}`],
        { env, signal },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, methods: [...methods], stdout, stderr }));
      child.stdin.end("");
    });
    return result;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Back-compat name: the original single-shape entry point, now a thin wrapper. */
export const runAgainstNullStub = (argv: string[]): Promise<SweepResult> => runAgainstStub(argv, NULL_BODY);

/**
 * Commands whose GET(s) are correctly exempt from the exit-7 contract:
 * binary downloads save any 2xx body verbatim (the exit-code spec's As-built note), so a
 * `null` "body" is 4 literal bytes written to the output file/stdout, not a
 * platform fault. Named, not inferred — the sweep cannot see "this is a
 * download" from HTTP methods alone.
 */
export const BINARY_DOWNLOAD_ALLOWLIST = new Set([
  "job applicant resume",
  "message attachment",
  "recruiter applicant resume",
]);

/**
 * Every `{path, variant}` this sweep's generated argv sends ZERO requests
 * for — reviewed, not inferred (qa cycle 3: a leaf that sends nothing is
 * "not constrained" by construction, which silently hid a real miss when
 * the argv generating it was simply wrong; failing closed on this exact
 * set means a FUTURE wrong-argv miss reds here by name instead of
 * vanishing into "not constrained"). Two shapes, both reviewed by reading
 * each command's own source, not guessed from the error text alone:
 *
 * 1. A bare group with no `args` of its own (`accountCommand`,
 *    `feedCommand`, ... — `async run()` takes no `{ args }` at all): citty
 *    rejects this sweep's blanket `--json` as an unknown flag before the
 *    handler runs. These commands have no single-object read of their own;
 *    every real command under them is a distinct swept leaf.
 * 2. A write whose real validation lives in application code, not citty's
 *    `required`/positional metadata — a reaction enum checked against a
 *    fixed list (`comment react`, `post react`, ...), a "give me at least
 *    one of X/Y" cross-field rule (`company follow-invite`, `job create`,
 *    `profile update`, ...), or a flag-pair exclusivity rule (`account
 *    link --li-at-stdin` needs `--auth-method cookie`, and this sweep's
 *    per-flag-alone variant generation tests it against the bare
 *    invocation's own `--auth-method credentials`). Writes are never
 *    constrained by this sweep regardless of whether a request went out,
 *    so under-supplying their argv costs nothing but sweep coverage of an
 *    already-out-of-scope command.
 */
export const ZERO_REQUEST_ALLOWLIST = new Set([
  "account read",
  "account link +--li-at-stdin",
  "account connect-session read",
  "account checkpoint read",
  "comment read",
  "comment react read",
  "comment unreact read",
  "company follow-invite read",
  "connect read",
  "feed read",
  "group read",
  "inbox read",
  "inboxes read",
  "job read",
  "job create read",
  "job applicant read",
  "message read",
  "message react read",
  "notification read",
  "post read",
  "post react read",
  "post unreact read",
  "profile update read",
  "recruiter read",
  "recruiter message read",
  "recruiter project-job create read",
  "recruiter job read",
  "recruiter job create read",
  "sales-nav read",
  "sales-nav message read",
  "webhook read",
  "webhook verify read",
]);

/**
 * Reads that send a non-GET verb (qa cycle 2 named exceptions in
 * `read-guard-nodes.ts`'s house-pattern lint: `client.auth.pollCheckpoint`/
 * `solveCheckpoint`, POST; `recruiter.searchParameters`, POST) — invisible
 * to the GET-only classification, so held to the exit-7 standard here by
 * name instead. Verified NOT already covered by the GET-only sweep (each
 * entry's own methods are checked to include a non-GET), so this list
 * cannot silently duplicate or go stale without the coverage check below
 * catching it.
 */
export const READ_BY_POST: Array<{ key: string; argv: string[] }> = [
  { key: "account checkpoint poll", argv: ["account", "checkpoint", "poll", "1"] },
  { key: "account checkpoint poll +--wait", argv: ["account", "checkpoint", "poll", "1", "--wait"] },
  { key: "account checkpoint solve", argv: ["account", "checkpoint", "solve", "1", "--code", "x"] },
  {
    key: "recruiter search parameters",
    argv: ["recruiter", "search", "parameters", "--source", "messaging", "--type", "LOCATION"],
  },
];
