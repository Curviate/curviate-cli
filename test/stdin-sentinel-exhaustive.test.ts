/**
 * Every `-`-accepting argument resolves stdin, and no argument anywhere in the
 * command tree lets the internal stdin sentinel escape the parsing layer.
 *
 * ## What went wrong, and why this guard is shaped the way it is
 *
 * `dispatch.ts` rewrites every bare `-` in the leaf argument list to
 * `STDIN_SENTINEL` before citty/mri parses argv, because mri silently swallows
 * a bare `-`. The substitution is indiscriminate: it applies to flag values
 * (`--api-key -`) exactly as it does to positionals (`post create -`).
 *
 * Any site that hand-rolls `arg === "-"` is therefore dead code in the shipped
 * binary. `login` did, so the sentinel fell through and was written to the
 * config file as the user's API key: exit 0, "Saved to profile", and every
 * later command failing with "Invalid or revoked API key".
 *
 * The defect was one *unenumerated* site, so a fix-list of sites cannot be the
 * guard. Three tests, in increasing cost:
 *
 *   1. Discovery — enumerate the `-`-accepting arguments from the live command
 *      tree, and assert the walk is not silently finding nothing.
 *   2. Shape — no module outside the resolver and the dispatcher may compare an
 *      argument against a bare dash. This is the invariant that makes a *future*
 *      site correct by construction, and it is nearly free to run.
 *   3. Behaviour — drive every discovered argument through the built bin and
 *      prove the piped value reaches the sink, byte for byte.
 *
 * Nothing here is keyed to a command name, so a new `-`-accepting argument
 * joins all three the moment it is declared.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CommandDef } from "citty";
import { cliPath, pkgRoot } from "./helpers/built-cli.js";
import { STDIN_SENTINEL } from "../src/lib/stdin.js";

// ---------------------------------------------------------------------------
// Discovery — derived from the command definitions, never from a list
// ---------------------------------------------------------------------------

interface Site {
  /** Command path as typed, e.g. `search people`. */
  path: string[];
  /** The `-`-accepting argument. */
  argName: string;
  argType: string;
  /** Every argument the leaf declares, in declaration order. */
  args: Record<string, ArgDef>;
}

interface ArgDef {
  type?: string;
  description?: string;
  required?: boolean;
}

/**
 * An argument declares the `-`-means-stdin contract when its description
 * mentions stdin AND contains a bare dash token.
 *
 * The bare-dash requirement is what separates a real site from
 * `account link --password-stdin`, whose description mentions stdin but whose
 * contract is a boolean sibling flag, not a dash. Requiring a *standalone*
 * dash (optionally quoted) also keeps `--password-stdin` and other hyphenated
 * words from matching.
 */
const BARE_DASH = /(^|[\s(`])["'`]?-["'`]?($|[\s).,;`])/;
function declaresDashStdin(def: ArgDef): boolean {
  if (def.type === "boolean") return false; // a boolean cannot carry a value
  const d = def.description ?? "";
  return /stdin/i.test(d) && BARE_DASH.test(d);
}

/**
 * Every command module, resolved by Vite at transform time. A glob, not a list
 * of imports: a new command file joins the guard by existing.
 *
 * `import.meta.glob` is a Vite feature, so it is absent from the Node typings
 * the package compiles against; the cast is the narrowest way to name it.
 */
const commandModules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../src/commands/*.ts");

async function resolveValue<T>(input: T | (() => T) | (() => Promise<T>)): Promise<T> {
  return typeof input === "function" ? (input as () => T | Promise<T>)() : input;
}

async function walk(cmd: CommandDef, path: string[], found: Site[]): Promise<void> {
  const meta = (await resolveValue(cmd.meta as never)) as { name?: string } | undefined;
  const here = [...path.slice(0, -1), meta?.name ?? path[path.length - 1]!];
  const args = ((await resolveValue(cmd.args as never)) ?? {}) as Record<string, ArgDef>;

  for (const [argName, def] of Object.entries(args)) {
    if (declaresDashStdin(def)) {
      found.push({ path: here, argName, argType: def.type ?? "string", args });
    }
  }

  const subs = ((await resolveValue(cmd.subCommands as never)) ?? {}) as Record<string, unknown>;
  for (const [subName, sub] of Object.entries(subs)) {
    await walk((await resolveValue(sub as never)) as CommandDef, [...here, subName], found);
  }
}

async function discoverSites(): Promise<Site[]> {
  const found: Site[] = [];
  for (const load of Object.values(commandModules)) {
    const mod = (await load()) as Record<string, unknown>;
    for (const [exportName, value] of Object.entries(mod)) {
      if (!value || typeof value !== "object" || !("meta" in value)) continue;
      await walk(value as CommandDef, [exportName.replace(/Command$/, "")], found);
    }
  }
  // Stable order, and dedupe a command reachable under two export names.
  const seen = new Set<string>();
  return found
    .filter((s) => {
      const key = `${s.path.join(" ")}::${s.argName}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => `${a.path.join(" ")}${a.argName}`.localeCompare(`${b.path.join(" ")}${b.argName}`));
}

/**
 * The number of `-`-accepting arguments present when this guard was written.
 *
 * The spec's amendment cites ">= 9" from a non-exhaustive grep; the walk over
 * the command definitions finds 23. This floor is the higher, true count: a
 * discovery walk that silently found nothing, or that a refactor quietly
 * narrowed, would otherwise pass vacuously — the exact failure mode this
 * campaign exists to catch. Raise it when arguments are added; never lower it
 * without deleting the corresponding argument.
 */
const KNOWN_SITE_COUNT = 23;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = "whsec_probe_secret";
/** Fixed so run A and run B produce byte-identical signatures. */
const SIGNATURE_TS = Math.floor(Date.now() / 1000);

function signatureFor(body: string): string {
  const mac = createHmac("sha256", WEBHOOK_SECRET).update(`${SIGNATURE_TS}.${body}`).digest("hex");
  return `t=${SIGNATURE_TS},v1=${mac}`;
}

/**
 * The value piped for a given site. Unique per site, so "the consuming site
 * received its exact value" is a real assertion rather than a coincidence.
 *
 * One shape satisfies every site: a JSON object is a valid `--filters` /
 * `--body` payload, a valid webhook body (it carries `event`), and an
 * unremarkable string everywhere a free-text positional is expected.
 */
function payloadFor(site: Site): string {
  const id = `${site.path.join("_")}_${site.argName}`.replace(/[^a-zA-Z0-9_]/g, "");
  return JSON.stringify({ event: "probe.event", probe: `PROBE-${id}` });
}

/**
 * A value for an argument that is not the one under test. It only has to be
 * well-formed enough that the command reaches its stdin resolver rather than
 * bouncing off input validation first.
 *
 * Keyed on argument name, never on command, so it stays a rule rather than a
 * site list. Two cases need more than a placeholder: a chat id is validated
 * for shape before anything else runs, and a webhook signature is only correct
 * for the body it was computed over.
 */
function syntheticValue(argName: string, payload: string): string {
  if (argName === "secret") return WEBHOOK_SECRET;
  if (argName === "header" || argName === "signature") return signatureFor(payload);
  if (/chat/i.test(argName)) return "2-probe";
  return "probe";
}

/**
 * Build argv for a site: every positional in declaration order, every required
 * flag, and the argument under test carrying `value`.
 */
function argvFor(site: Site, value: string, payload: string): string[] {
  const positionals: string[] = [];
  const flags: string[] = [];

  for (const [name, def] of Object.entries(site.args)) {
    const isTarget = name === site.argName;
    if (def.type === "positional") {
      positionals.push(isTarget ? value : syntheticValue(name, payload));
      continue;
    }
    if (isTarget) {
      flags.push(`--${name}`, value);
      continue;
    }
    if (def.required && def.type !== "boolean") {
      flags.push(`--${name}`, syntheticValue(name, payload));
    }
  }
  return [...site.path, ...positionals, ...flags];
}

interface Recorded {
  method: string;
  url: string;
  headers: string;
  body: string;
}

interface Observation {
  status: number | null;
  requests: Recorded[];
  config: string;
  stdout: string;
  stderr: string;
}

let server: Server;
let baseUrl: string;
let recorded: Recorded[] = [];

/** Everything a run could have leaked into, as one searchable string. */
function surfaces(o: Observation): string {
  return [JSON.stringify(o.requests), o.config, o.stdout, o.stderr].join("\n");
}

/**
 * Where a resolved value legitimately ends up: an outbound request (body,
 * headers or URL), the persisted config, or stdout for the commands that are
 * offline by design (`webhook verify` prints the parsed event it verified).
 * stderr is deliberately excluded - a value echoed only in an error message
 * has not reached its consuming site.
 */
function sinks(o: Observation): string {
  return [JSON.stringify(o.requests), o.config, o.stdout].join("\n");
}

/**
 * Run the built bin once in its own config home and report everything
 * observable about it.
 *
 * Async by necessity: `spawnSync` blocks the event loop, so the in-process stub
 * server could never answer the child.
 */
async function runSite(argv: string[], input: string): Promise<Observation> {
  const xdg = mkdtempSync(join(tmpdir(), "curviate-probe-"));
  recorded = [];

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: xdg,
    NODE_ENV: "production",
    CURVIATE_API_KEY: "rdc_live_probe",
    CURVIATE_ACCOUNT: "acc_probe",
    CURVIATE_BASE_URL: baseUrl,
  };

  const { status, stdout, stderr } = await new Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
  }>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath, ...argv], { env });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (out += c));
    child.stderr.on("data", (c: string) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ status: code, stdout: out, stderr: err }));
    child.stdin.end(input);
  });

  const configPath = join(xdg, "curviate", "config.json");
  const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  return { status, requests: [...recorded], config, stdout, stderr };
}

/**
 * Fallback proof that a site really consumed stdin, for the commands whose
 * domain validation rejects the probe payload before it can reach a sink
 * (`recruiter job create` wants a `job_title` in the body, and the probe is a
 * generic object).
 *
 * Re-run the same argv with empty stdin. A command that reads stdin reacts to
 * the change; a command that ignores it produces exactly the same run, which is
 * precisely the defect under test. No knowledge of the command is needed, so
 * this stays a rule rather than an exemption list.
 */
async function consumedStdin(site: Site, payload: string, withPayload: Observation): Promise<boolean> {
  const withEmpty = await runSite(argvFor(site, "-", payload), "");
  const shape = (o: Observation) => `${o.status}\n${o.stdout}\n${o.stderr}\n${o.requests.length}`;
  return shape(withEmpty) !== shape(withPayload);
}

let sites: Site[] = [];

beforeAll(async () => {
  sites = await discoverSites();

  server = createServer((req, res) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (data += c));
    req.on("end", () => {
      recorded.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: JSON.stringify(req.headers),
        body: data,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "probe_stub", data: [], has_more: false }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

// ---------------------------------------------------------------------------
// 1. Discovery
// ---------------------------------------------------------------------------

describe("discovery — the enumeration comes from the command tree", () => {
  it(`finds at least the ${KNOWN_SITE_COUNT} arguments known to accept a dash`, () => {
    expect(sites.length).toBeGreaterThanOrEqual(KNOWN_SITE_COUNT);
  });

  it("finds the argument whose failure prompted this guard", () => {
    const login = sites.find((s) => s.path.join(" ") === "login" && s.argName === "api-key");
    expect(login, `discovered: ${sites.map((s) => s.path.join(" ")).join(", ")}`).toBeDefined();
  });

  it("does not mistake a --*-stdin boolean sibling for a dash-accepting argument", () => {
    // `account link --password-stdin` mentions stdin but takes no value; a walk
    // that swept it in would drive a nonsense case and blunt the real guard.
    expect(sites.some((s) => s.argName.endsWith("-stdin"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Shape — the invariant that makes future sites correct by construction
// ---------------------------------------------------------------------------

/**
 * Only two modules may mention a bare dash as a value: the dispatcher that
 * substitutes it, and the resolver that recognises both spellings. Anywhere
 * else, an equality test against `"-"` alone is unreachable in the shipped
 * binary, because the sentinel arrives instead.
 */
const DASH_COMPARISON = /(?:[!=]==\s*["'`]-["'`])|(?:["'`]-["'`]\s*[!=]==)/;
const SENTINEL_REFERENCE = /STDIN_SENTINEL/;
const RESOLVER_MODULES = new Set(["src/lib/stdin.ts", "src/dispatch.ts"]);

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (entry.name.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

describe("shape — no site hand-rolls the dash comparison", () => {
  it("only the dispatcher and the shared resolver compare an argument to a bare dash", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(resolve(pkgRoot, "src"))) {
      const rel = file.slice(pkgRoot.length + 1);
      if (RESOLVER_MODULES.has(rel)) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) return;
        if (DASH_COMPARISON.test(line) || SENTINEL_REFERENCE.test(line)) {
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    expect(
      offenders,
      "each of these tests a raw argument itself instead of delegating to " +
        "resolveTextOrStdin / isStdinToken, so it is unreachable in the built " +
        "binary and the sentinel falls through as user data:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Behaviour — drive every discovered argument through the built bin
// ---------------------------------------------------------------------------

describe("behaviour — every dash-accepting argument reads stdin", () => {
  it(
    "each site receives its exact piped value, and no site leaks the sentinel",
    async () => {
      // One list, so a run reports every broken argument at once rather than
      // stopping at the first and hiding the rest behind a re-run.
      const problems: string[] = [];

      for (const site of sites) {
        const label = `${site.path.join(" ")} --${site.argName}`;
        const payload = payloadFor(site);
        const probeId = (JSON.parse(payload) as { probe: string }).probe;

        // The value arrives on stdin; the argument itself is a bare dash, which
        // the dispatcher has already turned into the sentinel by the time the
        // consuming site sees it.
        const run = await runSite(argvFor(site, "-", payload), payload);

        // Positively: the piped value must arrive at the consuming
        // sink. This is the assertion that catches a site which never reads
        // stdin at all -- `--filters` failed here while leaking nothing, so a
        // sentinel-absence check on its own would have called it clean.
        if (!sinks(run).includes(probeId) && !(await consumedStdin(site, payload, run))) {
          problems.push(
            `${label}: NOT RESOLVED - the piped value never reached a request, ` +
              `the config file, or stdout, and the command behaved identically ` +
              `on empty stdin` +
              `\n    exit ${run.status}, ${run.requests.length} request(s)` +
              `\n    stderr: ${run.stderr.trim().slice(0, 200) || "(none)"}`,
          );
        }

        // Negatively: the sentinel must never reach a persisted file,
        // an outbound body, or an outbound header. Nor a stream: a diagnostic
        // quoting it back is how a user gets told their own key is at fault.
        if (surfaces(run).includes(STDIN_SENTINEL)) {
          problems.push(
            `${label}: LEAK - the sentinel reached a sink or a stream` +
              `\n    ${surfaces(run).split("\n").find((l) => l.includes(STDIN_SENTINEL))?.slice(0, 200)}`,
          );
        }
      }

      expect(
        problems,
        `${problems.length} problem(s) across ${sites.length} dash-accepting arguments:\n` +
          problems.join("\n"),
      ).toEqual([]);
    },
    180_000,
  );
});

