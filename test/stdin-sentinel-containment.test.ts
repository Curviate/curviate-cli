/**
 * Containment: the internal stdin placeholder must not escape the argument
 * parsing layer at ANY argument, and must not reach the wire even if it does.
 *
 * ## What this covers that the exhaustive suite does not
 *
 * The sibling suite proves the ~23 arguments that DOCUMENT `-` read stdin
 * correctly. That is accurate but not complete. `dispatch.ts` rewrites a bare
 * `-` to the placeholder indiscriminately, across every argument in the tree,
 * so an argument that never advertised the stdin contract still receives the
 * placeholder as if the user had typed it. Observed on the built binary before
 * this guard existed:
 *
 *     account link ... --password -   ->  {"credentials":{"password":"<placeholder>"}}
 *     search people --keywords -      ->  {"keywords":"<placeholder>"}
 *     message send - hello            ->  POST /v1/{acc}/chats/<placeholder>/messages
 *
 * Sending the placeholder as a LinkedIn password is the same failure shape as
 * the original defect: exit 0, a success-shaped response, and the fault
 * deferred to a later step that blames the user's credentials.
 *
 * ## Three layers, deliberately different in kind
 *
 *   1. SURFACE (the whole tree). Every non-boolean argument, driven through the
 *      real dispatcher, asserting on what the consuming handler is handed. A
 *      guard that only inspects the documented arguments is structurally blind
 *      to a leak at an argument nobody enumerated, which is the entire defect.
 *      Cheap enough to run over the full surface because the terminal handler
 *      is the observation point rather than a real network round trip.
 *
 *   2. BINARY (the four arguments observed leaking). The same four commands
 *      through the built bin against a recording server, so the fix is proven
 *      on the shipped artifact and not only in process.
 *
 *   3. BACKSTOP (injection, not inspection). A placeholder is injected at a
 *      source the dispatcher never sees, and the request must be refused rather
 *      than sent. A backstop that has never been observed rejecting anything is
 *      indistinguishable from one that was never wired up.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandDef } from "citty";
import { cliPath } from "./helpers/built-cli.js";
import { STDIN_SENTINEL } from "../src/lib/stdin.js";
import { dispatch } from "../src/dispatch.js";

// ---------------------------------------------------------------------------
// Discovery — the full argument surface, from the command definitions
// ---------------------------------------------------------------------------

interface ArgDef {
  type?: string;
  description?: string;
  required?: boolean;
  alias?: string | string[];
}

/**
 * Written here independently of the production predicate on purpose.
 *
 * Production decides from an explicit `stdinArg` marker on the argument
 * definition; this decides from the argument's own documentation. If the two
 * ever disagree, an argument either advertises a contract it does not honour or
 * honours one it never advertised, and this suite fails rather than papering
 * over it. A shared predicate could not tell the difference.
 */
const BARE_DASH = /(^|[\s(`])["'`]?-["'`]?($|[\s).,;`])/;
function documentsDashStdin(def: ArgDef): boolean {
  if (def.type === "boolean") return false;
  const d = def.description ?? "";
  return /stdin/i.test(d) && BARE_DASH.test(d);
}

interface Arg {
  path: string[];
  argName: string;
  def: ArgDef;
  args: Record<string, ArgDef>;
  documented: boolean;
}

const commandModules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../src/commands/*.ts");

async function resolveValue<T>(input: T | (() => T) | (() => Promise<T>)): Promise<T> {
  return typeof input === "function" ? (input as () => T | Promise<T>)() : input;
}

/**
 * Every command node reachable from a module export, keyed by the command path
 * a user would type. Rebuilt into a root below so the dispatcher under test
 * walks the same tree the binary walks.
 */
interface Node {
  path: string[];
  cmd: CommandDef;
  args: Record<string, ArgDef>;
}

async function walk(cmd: CommandDef, path: string[], out: Node[]): Promise<void> {
  const meta = (await resolveValue(cmd.meta as never)) as { name?: string } | undefined;
  const here = [...path.slice(0, -1), meta?.name ?? path[path.length - 1]!];
  const args = ((await resolveValue(cmd.args as never)) ?? {}) as Record<string, ArgDef>;
  out.push({ path: here, cmd, args });

  const subs = ((await resolveValue(cmd.subCommands as never)) ?? {}) as Record<string, unknown>;
  for (const [subName, sub] of Object.entries(subs)) {
    await walk((await resolveValue(sub as never)) as CommandDef, [...here, subName], out);
  }
}

async function discoverNodes(): Promise<Node[]> {
  const out: Node[] = [];
  for (const load of Object.values(commandModules)) {
    const mod = (await load()) as Record<string, unknown>;
    for (const [exportName, value] of Object.entries(mod)) {
      if (!value || typeof value !== "object" || !("meta" in value)) continue;
      await walk(value as CommandDef, [exportName.replace(/Command$/, "")], out);
    }
  }
  const seen = new Set<string>();
  return out.filter((n) => {
    const key = n.path.join(" ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The full surface: every non-boolean argument on every node that has a
 * handler. Boolean flags carry no value, so a dash can never bind to one.
 */
function argumentSurface(nodes: Node[]): Arg[] {
  const out: Arg[] = [];
  for (const node of nodes) {
    if (typeof node.cmd.run !== "function") continue;
    for (const [argName, def] of Object.entries(node.args)) {
      if (def.type === "boolean") continue;
      out.push({
        path: node.path,
        argName,
        def,
        args: node.args,
        documented: documentsDashStdin(def),
      });
    }
  }
  return out.sort((a, b) =>
    `${a.path.join(" ")}::${a.argName}`.localeCompare(`${b.path.join(" ")}::${b.argName}`),
  );
}

/**
 * The measured surface when this guard was written: 1726 non-boolean arguments
 * against 23 that document the dash. The floor is set near the true count, not
 * near 23, because the whole point of this suite is that a run over the
 * documented subset is a false green. A refactor that quietly narrows the walk
 * to the documented arguments fails here instead of passing vacuously.
 */
const ARGUMENT_SURFACE_FLOOR = 1700;
const DOCUMENTED_FLOOR = 23;

// ---------------------------------------------------------------------------
// Layer 1 — the whole argument surface, through the real dispatcher
// ---------------------------------------------------------------------------

/** A value for a non-target argument: well-formed, and never a subcommand name. */
const FILLER = "probe";

function argvFor(arg: Arg): string[] {
  const positionals: string[] = [];
  const flags: string[] = [];
  for (const [name, def] of Object.entries(arg.args)) {
    const isTarget = name === arg.argName;
    if (def.type === "positional") {
      positionals.push(isTarget ? "-" : FILLER);
      continue;
    }
    if (isTarget) {
      flags.push(`--${name}`, "-");
      continue;
    }
    if (def.required && def.type !== "boolean") flags.push(`--${name}`, FILLER);
  }
  return [...arg.path, ...positionals, ...flags];
}

/**
 * A root whose leaves are the real command definitions with their handlers
 * replaced by a recorder. The dispatcher, its dash substitution, citty's
 * parser, and every argument definition are the production ones; only the
 * terminal handler is swapped, and that handler is exactly the consuming site
 * whose input is under test.
 */
function recordingRoot(nodes: Node[], seen: { args: unknown }): CommandDef {
  const clone = (node: Node, children: Node[]): CommandDef => {
    const subCommands: Record<string, CommandDef> = {};
    for (const child of children) {
      if (child.path.length !== node.path.length + 1) continue;
      if (child.path.slice(0, node.path.length).join(" ") !== node.path.join(" ")) continue;
      subCommands[child.path[child.path.length - 1]!] = clone(child, children);
    }
    const def: CommandDef = {
      meta: node.cmd.meta,
      args: node.args as never,
      ...(Object.keys(subCommands).length > 0 ? { subCommands } : {}),
      ...(typeof node.cmd.run === "function"
        ? {
            run: (ctx: { args: unknown }) => {
              seen.args = ctx.args;
            },
          }
        : {}),
    };
    return def;
  };

  const roots = nodes.filter((n) => n.path.length === 1);
  const subCommands: Record<string, CommandDef> = {};
  for (const root of roots) subCommands[root.path[0]!] = clone(root, nodes);
  return { meta: { name: "curviate" }, subCommands };
}

let nodes: Node[] = [];
let surface: Arg[] = [];

beforeAll(async () => {
  nodes = await discoverNodes();
  surface = argumentSurface(nodes);
}, 60_000);

describe("the whole argument surface, not the documented subset", () => {
  it(`walks at least ${ARGUMENT_SURFACE_FLOOR} non-boolean arguments`, () => {
    expect(surface.length).toBeGreaterThanOrEqual(ARGUMENT_SURFACE_FLOOR);
    expect(surface.filter((a) => a.documented).length).toBeGreaterThanOrEqual(DOCUMENTED_FLOOR);
  });

  it(
    "hands no handler the placeholder at an argument that never documented the dash",
    async () => {
      const seen: { args: unknown } = { args: null };
      const root = recordingRoot(nodes, seen);

      // The dispatcher exits the process on a usage error; make that observable
      // instead of fatal so one malformed probe cannot end the run.
      const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
        throw new Error("__dispatch_exit__");
      }) as never);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const leaks: string[] = [];
      const unreached: string[] = [];
      let reached = 0;

      try {
        for (const arg of surface) {
          seen.args = null;
          try {
            await dispatch(root, argvFor(arg));
          } catch {
            // Usage error or a missing-argument bounce: nothing reached a
            // handler, so nothing could have leaked. Counted, not asserted on.
          }
          const label = `${arg.path.join(" ")} --${arg.argName}`;
          if (seen.args === null) {
            unreached.push(label);
            continue;
          }
          reached++;
          const parsed = seen.args as Record<string, unknown>;
          const value = parsed[arg.argName];

          if (arg.documented) {
            // A documented argument keeps the placeholder: its handler resolves
            // it from stdin. That end of the contract is proven end to end by
            // the sibling suite, through the built binary.
            if (value !== STDIN_SENTINEL) {
              leaks.push(`${label}: documented dash argument lost its stdin marker (got ${JSON.stringify(value)})`);
            }
            continue;
          }

          if (JSON.stringify(parsed).includes(STDIN_SENTINEL)) {
            leaks.push(
              `${label}: LEAK, the handler was handed the internal placeholder ` +
                `instead of a literal dash (${arg.argName}=${JSON.stringify(value)})`,
            );
            continue;
          }
          if (value !== "-") {
            leaks.push(`${label}: expected a literal "-", got ${JSON.stringify(value)}`);
          }
        }
      } finally {
        exit.mockRestore();
        stderr.mockRestore();
      }

      // The probe must actually reach handlers, or an all-green run means only
      // that every argv bounced off validation.
      expect(
        reached,
        `only ${reached} of ${surface.length} arguments reached a handler ` +
          `(${unreached.length} bounced); the probe is not exercising the surface`,
      ).toBeGreaterThanOrEqual(ARGUMENT_SURFACE_FLOOR / 2);

      expect(
        leaks,
        `${leaks.length} leaking argument(s) out of ${surface.length}:\n${leaks.slice(0, 40).join("\n")}`,
      ).toEqual([]);
    },
    180_000,
  );
});

// ---------------------------------------------------------------------------
// Layer 2 + 3 — the built binary against a recording server
// ---------------------------------------------------------------------------

interface Recorded {
  method: string;
  url: string;
  headers: string;
  body: string;
}

let server: Server;
let baseUrl: string;
let recorded: Recorded[] = [];

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  requests: Recorded[];
  config: string;
}

async function runBin(argv: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<Run> {
  const xdg = mkdtempSync(join(tmpdir(), "curviate-contain-"));
  recorded = [];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: xdg,
    NODE_ENV: "production",
    CURVIATE_API_KEY: "rdc_live_probe",
    CURVIATE_ACCOUNT: "acc_probe",
    CURVIATE_BASE_URL: baseUrl,
    ...extraEnv,
  };
  const { status, stdout, stderr } = await new Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
  }>((res, rej) => {
    const child = spawn(process.execPath, [cliPath, ...argv], { env });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (out += c));
    child.stderr.on("data", (c: string) => (err += c));
    child.on("error", rej);
    child.on("close", (code) => res({ status: code, stdout: out, stderr: err }));
    child.stdin.end("");
  });
  const configPath = join(xdg, "curviate", "config.json");
  return {
    status,
    stdout,
    stderr,
    requests: [...recorded],
    config: existsSync(configPath) ? readFileSync(configPath, "utf8") : "",
  };
}

beforeAll(async () => {
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
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

/** The four arguments observed sending the placeholder to the wire. */
const OBSERVED_LEAKS: Array<{ label: string; argv: string[] }> = [
  {
    label: "account link --password -",
    argv: [
      "account",
      "link",
      "--seat-id",
      "seat_probe",
      "--auth-method",
      "credentials",
      "--email",
      "probe@example.com",
      "--password",
      "-",
    ],
  },
  { label: "search people --keywords -", argv: ["search", "people", "--keywords", "-"] },
  { label: "message send - hello", argv: ["message", "send", "-", "hello"] },
  { label: "connect <id> --note -", argv: ["connect", "probe-person", "--note", "-"] },
];

describe("the built binary sends no placeholder at the arguments observed leaking", () => {
  for (const { label, argv } of OBSERVED_LEAKS) {
    it(
      `${label} reaches the wire with a literal dash, never the placeholder`,
      async () => {
        const run = await runBin(argv);
        const wire = JSON.stringify(run.requests);
        expect(
          wire.includes(STDIN_SENTINEL),
          `outbound request carried the placeholder:\n${wire.slice(0, 400)}`,
        ).toBe(false);
        expect(run.config.includes(STDIN_SENTINEL)).toBe(false);
        // A request has to have been attempted, or "no placeholder on the wire"
        // is true only because nothing was sent.
        expect(run.requests.length, `no request was made: ${run.stderr.slice(0, 300)}`).toBeGreaterThan(0);
        expect(wire).toContain("-");
      },
      60_000,
    );
  }
});

describe("the egress backstop refuses a placeholder the dispatcher never saw", () => {
  it(
    "refuses the request, sends nothing, and says what to do about it",
    async () => {
      // Injected through the environment: a source the argv layer cannot reach,
      // standing in for any future path that lets the placeholder through.
      const run = await runBin(["inbox", "list"], { CURVIATE_ACCOUNT: STDIN_SENTINEL });

      expect(run.requests, "the request must not be transmitted").toEqual([]);
      expect(run.status, "a refused request must not exit 0").not.toBe(0);
      expect(run.stderr.toLowerCase()).toMatch(/stdin/);
      expect(run.stderr).toMatch(/-/);
    },
    60_000,
  );

  it(
    "lets normal traffic through once the injection is removed",
    async () => {
      const run = await runBin(["inbox", "list"]);
      expect(run.requests.length).toBeGreaterThan(0);
      expect(JSON.stringify(run.requests).includes(STDIN_SENTINEL)).toBe(false);
    },
    60_000,
  );
});

describe("the persistence backstop refuses to write a placeholder to disk", () => {
  it("refuses the write, leaves no file behind, and lets a clean write through", async () => {
    const home = mkdtempSync(join(tmpdir(), "curviate-persist-"));
    const previous = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = home;

    const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("__refused__");
    }) as never);
    const errors: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errors.push(String(chunk));
      return true;
    });

    try {
      const { writeProfile, getConfigPath } = await import("../src/lib/config.js");
      const configPath = getConfigPath();

      // Injected past the argument layer entirely, the way a future code path
      // or a config-file edit would deliver it.
      await expect(writeProfile("default", { apiKey: STDIN_SENTINEL })).rejects.toThrow(
        "__refused__",
      );
      expect(existsSync(configPath), "nothing may be persisted").toBe(false);
      expect(errors.join("")).toContain("stdin");

      errors.length = 0;
      await writeProfile("default", { apiKey: "rdc_live_real" });
      expect(readFileSync(configPath, "utf8")).toContain("rdc_live_real");
    } finally {
      exit.mockRestore();
      stderr.mockRestore();
      if (previous === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = previous;
    }
  });
});
