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
 * that answers every request with a `null` 200 body, and record every HTTP
 * method it sent. A variant that sent ONLY `GET` requests is a read; it
 * MUST exit 7. Zero requests (a usage error, or a bare group that only
 * prints help) means nothing was exercised — not constrained, skipped. Any
 * non-GET request means the command can legitimately render a genuine
 * `204`/null body on success (a write) — not constrained here either;
 * `test/lib/paginate.test.ts` and `test/readable-object-guard-source.test.ts`
 * (the house-pattern lint) cover the guard function and the common
 * call-site shape directly.
 */

import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GLOBAL_FLAGS } from "../../src/lib/global-flags.js";
import { allNodes, FLAG_VALUES, type Node } from "./streaming-nodes.js";
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

/** Minimal required positionals/flags, no branch-selecting booleans. */
function bareArgv(node: Node): string[] {
  const positionals = Object.values(node.defs)
    .filter((d) => d.type === "positional" && d.required !== false)
    .map(() => "1");
  const required = Object.entries(node.defs)
    .filter(([, d]) => d.type !== "positional" && d.required)
    .flatMap(([name]) => [`--${name}`, FLAG_VALUES[name] ?? "x"]);
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

/** One shared xdg dir for every spawn in a sweep run (no login state needed against a stub). */
const sweepXdg = mkdtempSync(join(tmpdir(), "curviate-sweep-"));

/**
 * Run one CLI invocation against a fresh local stub that answers every
 * request with a 200 `null` JSON body, and report which HTTP methods it
 * sent. One request-serving server per call, torn down before returning —
 * sequential by construction (the caller awaits each), which is also the
 * RAM discipline this sweep needs on this host (`test-runtime` skill): one
 * child process at a time, never fanned out.
 */
export async function runAgainstNullStub(argv: string[]): Promise<SweepResult> {
  const methods: string[] = [];
  const server: Server = createServer((req, res) => {
    methods.push(req.method ?? "?");
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("null");
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
      const child = spawn(
        process.execPath,
        [cliPath, ...argv, "--json", "--beta", "--api-key", "cvt_test_x", "--account", "acc_1", "--base-url", `http://127.0.0.1:${port}`],
        { env },
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
