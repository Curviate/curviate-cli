/**
 * `dispatch.ts` rewrites every bare `-` to an internal placeholder so the arg
 * parser cannot swallow it, then restores it for every argument that did not
 * opt into the stdin contract. Every `-`-accepting argument must read stdin,
 * and the placeholder must never reach a handler, the wire, a stream or disk
 * anywhere else. Swept over the whole registry, never over a hand list.
 */
import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CommandDef } from "citty";
import { dispatch } from "../src/dispatch.js";
import { STDIN_SENTINEL } from "../src/lib/stdin.js";
import { writeProfile, getConfigPath } from "../src/lib/config.js";
import { exitCode } from "./helpers/exit-code.js";
import { pkgRoot } from "./helpers/pkg.js";
import { configHome } from "./helpers/run-inproc.js";
import { useSink } from "./helpers/sink.js";
import { allNodes, type ArgDef, type Node } from "./helpers/tree.js";

const BARE_DASH = /(^|[\s(`])["'`]?-["'`]?($|[\s).,;`])/;
const documentsDash = (d: ArgDef) => d.type !== "boolean" && /stdin/i.test(d.description ?? "") && BARE_DASH.test(d.description ?? "");
const sink = useSink({ body: { id: "probe_stub", data: [], has_more: false } });
const nodes = await allNodes(true);

describe("the whole argument surface, not the documented subset", () => {
  const surface = nodes.filter((n) => n.run).flatMap((n) => Object.entries(n.defs).filter(([, d]) => d.type !== "boolean").map(([name, def]) => ({ n, name, def })));

  /** A tree of the same shape whose handlers only record the parsed args. */
  function recordingRoot(seen: { args: unknown }): CommandDef {
    const clone = (node: Node): CommandDef => {
      const kids = nodes.filter((c) => c.path.length === node.path.length + 1 && c.path.slice(0, node.path.length).join(" ") === node.path.join(" "));
      return {
        meta: node.cmd.meta,
        args: node.defs as never,
        ...(kids.length ? { subCommands: Object.fromEntries(kids.map((k) => [k.path.at(-1)!, clone(k)])) } : {}),
        ...(node.run ? { run: (ctx: { args: unknown }) => void (seen.args = ctx.args) } : {}),
      };
    };
    return { meta: { name: "curviate" }, subCommands: Object.fromEntries(nodes.filter((n) => n.path.length === 1).map((n) => [n.path[0]!, clone(n)])) };
  }

  it("hands no handler the placeholder at an argument that never documented the dash; documented ones keep their marker", { timeout: 180_000 }, async () => {
    const seen: { args: unknown } = { args: null };
    const root = recordingRoot(seen);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__dispatch_exit__");
    }) as never);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const bad: string[] = [];
    let reached = 0;
    try {
      for (const { n, name, def } of surface) {
        const argv = [
          ...n.path,
          ...Object.entries(n.defs).filter(([, d]) => d.type === "positional").map(([k]) => (k === name ? "-" : "probe")),
          ...Object.entries(n.defs).flatMap(([k, d]) => (d.type === "positional" || d.type === "boolean" ? [] : k === name ? [`--${k}`, "-"] : d.required ? [`--${k}`, "probe"] : [])),
        ];
        seen.args = null;
        await dispatch(root, argv).catch(() => undefined);
        if (seen.args === null) continue;
        reached++;
        const value = (seen.args as Record<string, unknown>)[name];
        const label = `${n.path.join(" ")} --${name}`;
        if (documentsDash(def)) {
          if (value !== STDIN_SENTINEL) bad.push(`${label}: documented dash lost its stdin marker (${JSON.stringify(value)})`);
        } else if (JSON.stringify(seen.args).includes(STDIN_SENTINEL)) bad.push(`${label}: LEAK, the handler got the placeholder`);
        else if (value !== "-") bad.push(`${label}: expected a literal "-", got ${JSON.stringify(value)}`);
      }
    } finally {
      exit.mockRestore();
      stderr.mockRestore();
    }
    expect(surface.length).toBeGreaterThan(1000);
    expect(reached, "the probe exercises the surface").toBeGreaterThanOrEqual(surface.length / 2);
    expect(bad).toEqual([]);
  });

  it("only the dispatcher and the shared resolver compare an argument to a bare dash or name the placeholder", () => {
    const DASH = /(?:[!=]=+\s*["'`]-["'`])|(?:["'`]-["'`]\s*[!=]=+)|STDIN_SENTINEL|curviate_stdin|_stdin__/;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !/src\/(lib\/stdin|dispatch)\.ts$/.test(p)) {
          readFileSync(p, "utf8").split("\n").forEach((l, i) => {
            if (!/^\s*(\*|\/\/)/.test(l) && DASH.test(l)) offenders.push(`${p.slice(pkgRoot.length + 1)}:${i + 1}: ${l.trim()}`);
          });
        }
      }
    };
    walk(resolve(pkgRoot, "src"));
    expect(offenders).toEqual([]);
  });
});

describe("every dash-accepting argument reads stdin", () => {
  const SECRET = "whsec_probe_secret";
  const t = Math.floor(Date.now() / 1000);
  const sign = (body: string) => `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex")}`;
  const sites = nodes.flatMap((n) => Object.entries(n.defs).filter(([, d]) => documentsDash(d)).map(([name]) => ({ n, name })));

  it("finds at least the 24 known sites, including login --api-key, and no --*-stdin boolean", () => {
    expect(sites.length).toBeGreaterThanOrEqual(24);
    expect(sites.some((s) => s.n.path.join(" ") === "login" && s.name === "api-key")).toBe(true);
    expect(sites.some((s) => s.name.endsWith("-stdin"))).toBe(false);
  });

  it("each site receives its exact piped value and leaks no placeholder to a request, the config, or either stream", { timeout: 180_000 }, async () => {
    const problems: string[] = [];
    for (const { n, name } of sites) {
      const id = `${n.path.join("_")}_${name}`.replace(/[^a-zA-Z0-9_]/g, "");
      const payload = JSON.stringify({ event: "probe.event", probe: `PROBE-${id}` });
      const value = (k: string) => (k === "secret" ? SECRET : k === "header" || k === "signature" ? sign(payload) : /chat/i.test(k) ? "2-probe" : "probe");
      const argv = [
        ...n.path,
        ...Object.entries(n.defs).filter(([, d]) => d.type === "positional").map(([k]) => (k === name ? "-" : value(k))),
        ...Object.entries(n.defs).flatMap(([k, d]) => (d.type === "positional" || d.type === "boolean" ? [] : k === name ? [`--${k}`, "-"] : d.required ? [`--${k}`, value(k)] : [])),
      ];
      const observe = async (stdin: string) => {
        const xdg = configHome();
        const r = await sink.run(argv, { xdg, stdin, env: { CURVIATE_API_KEY: "rdc_live_probe", CURVIATE_ACCOUNT: "acc_probe" } });
        const cfg = join(xdg, "curviate", "config.json");
        return { ...r, config: existsSync(cfg) ? readFileSync(cfg, "utf8") : "" };
      };
      const run = await observe(payload);
      const label = `${n.path.join(" ")} --${name}`;
      const sinks = [JSON.stringify(run.requests), run.config, run.stdout].join("\n");
      if (!sinks.includes(`PROBE-${id}`)) {
        const empty = await observe("");
        const shape = (o: typeof run) => `${o.status}\n${o.stdout}\n${o.stderr}\n${o.requests.length}`;
        if (shape(empty) === shape(run)) problems.push(`${label}: NOT RESOLVED, the piped value never reached a sink and the command behaved identically on empty stdin`);
      }
      if ((sinks + run.stderr).includes(STDIN_SENTINEL)) problems.push(`${label}: LEAK, the placeholder reached a sink or a stream`);
    }
    expect(problems).toEqual([]);
  });
});

describe("no placeholder reaches the wire for any argument shape", () => {
  const CASES: Array<[string, string[], ((b: Record<string, unknown>) => void)?]> = [
    ["flag: account link --password -", ["account", "link", "--seat-id", "seat_probe", "--auth-method", "credentials", "--country", "US", "--email", "probe@example.com", "--password", "-"]],
    ["flag: search people --keywords -", ["search", "people", "--keywords", "-"]],
    ["positional: message send - hello", ["message", "send", "-", "hello"]],
    ["flag: connect <id> --note -", ["connect", "probe-person", "--note", "-"]],
    ["flag: search people --location - (a literal dash)", ["search", "people", "--location", "-"], (b) => expect(b["location"]).toEqual(["-"])],
    ["array element: company follow-invite --invitee x --invitee -", ["company", "follow-invite", "12345", "--invitee", "x", "--invitee", "-"], (b) => expect(b["invitee_ids"]).toEqual(["x", "-"])],
  ];

  it.each(CASES)("%s reaches the wire with a literal dash, never the placeholder", async (_label, argv, assertBody) => {
    const xdg = configHome();
    const r = await sink.run(argv, { xdg, env: { CURVIATE_API_KEY: "rdc_live_probe", CURVIATE_ACCOUNT: "acc_probe" } });
    const wire = JSON.stringify(r.requests);
    expect(r.requests.length, r.stderr).toBeGreaterThan(0);
    expect(wire).not.toContain(STDIN_SENTINEL);
    expect(wire).toContain("-");
    if (assertBody) assertBody(JSON.parse(r.requests[0]!.body) as Record<string, unknown>);
  });

  it("the egress backstop refuses a placeholder the dispatcher never saw, and normal traffic passes without it", async () => {
    const bad = await sink.run(["inbox", "list"], { env: { CURVIATE_ACCOUNT: STDIN_SENTINEL } });
    expect(bad.requests).toEqual([]);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr.toLowerCase()).toMatch(/stdin/);
    const ok = await sink.run(["inbox", "list"], { env: { CURVIATE_ACCOUNT: "acc_probe" } });
    expect(ok.requests.length).toBeGreaterThan(0);
    expect(JSON.stringify(ok.requests)).not.toContain(STDIN_SENTINEL);
  });
});

describe("the persistence backstop refuses to write a placeholder to disk", () => {
  it("refuses the write, leaves no file behind, and lets a clean write through", async () => {
    const previous = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = mkdtempSync(join(tmpdir(), "curviate-persist-"));
    const errors: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((c) => (errors.push(String(c)), true));
    try {
      const path = getConfigPath();
      expect(await exitCode(() => writeProfile("default", { apiKey: STDIN_SENTINEL }))).toBeDefined();
      expect(existsSync(path), "nothing may be persisted").toBe(false);
      expect(errors.join("")).toContain("stdin");
      await writeProfile("default", { apiKey: "rdc_live_real" });
      expect(readFileSync(path, "utf8")).toContain("rdc_live_real");
    } finally {
      stderr.mockRestore();
      if (previous === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = previous;
    }
  });
});
