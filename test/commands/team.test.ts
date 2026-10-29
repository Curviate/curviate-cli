/** Teams: which Team a call acts in, and the `team` commands, as the requests they send. */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { useSink, line } from "../helpers/sink.js";
import { configHome } from "../helpers/run-inproc.js";
import { pkgRoot } from "../helpers/pkg.js";
import { seal } from "../helpers/f2-seal.js";
import { generateSessionMaterial, resolveSetupIO, runSetup } from "../../src/commands/setup.js";
import { setTeamFlag } from "../../src/lib/global-flags.js";

const sink = useSink();

describe("the Team a call acts in: --team > CURVIATE_TEAM > profile team", () => {
  it.each([
    ["profile only", [], {}, "tnt_profile"],
    ["env beats profile", [], { CURVIATE_TEAM: "tnt_env" }, "tnt_env"],
    ["flag beats env and profile", ["--team", "tnt_flag"], { CURVIATE_TEAM: "tnt_env" }, "tnt_flag"],
    ["an empty env var is unset", [], { CURVIATE_TEAM: "" }, "tnt_profile"],
  ] as const)("%s", async (_l, flags, env, sent) => {
    const r = await sink.run(["account", "list", "--json", ...flags], { xdg: configHome({ team: "tnt_profile" }), env });
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests.map((q) => q.headers["x-curviate-team"])).toEqual([sent]);
  });

  it("no Team anywhere sends no header; --team '' exits 2 before any request", async () => {
    const none = await sink.run(["account", "list", "--json"]);
    expect([none.status, none.requests.length, none.requests[0]?.headers["x-curviate-team"]]).toEqual([0, 1, undefined]);
    const empty = await sink.run(["account", "list", "--json", "--team", ""], { xdg: configHome({ team: "tnt_profile" }) });
    expect([empty.status, empty.requests.length]).toEqual([2, 0]);
  });
});

describe("--team is a global flag", () => {
  it("every command that takes a key takes --team (login only saves a key)", () => {
    type Cmd = { path: string[]; globals: string[]; args: Array<{ name: string }> };
    const { commands } = JSON.parse(readFileSync(resolve(pkgRoot, "commands.json"), "utf8")) as { commands: Cmd[] };
    const has = (c: Cmd, n: string) => c.globals.includes(n) || c.args.some((a) => a.name === n);
    const keyed = commands.filter((c) => has(c, "api-key") && c.path.join(" ") !== "login");
    expect(keyed.length).toBeGreaterThan(0);
    expect(keyed.filter((c) => !has(c, "team")).map((c) => c.path.join(" "))).toEqual([]);
  });
});

// Fake keys only: an all-teams key is told apart by its prefix.
const ALL = "cvt_all_FAKEFIXTUREKEY000000000";
const TEAMS = { object: "team_list", cursor: null, items: [
  { object: "team", team_id: "tnt_a", name: "Agency A", is_current: true },
  { object: "team", team_id: "tnt_b", name: "Client B", is_current: false },
] };
const DENIED = { code: "TEAM_ACCESS_DENIED", message: "x", user_fixable: true, retry_likely_to_succeed: false };

describe("doctor reports the key's scope and the Team, checked against GET /v1/teams", () => {
  it.each([
    ["all-teams key, profile Team of theirs", ALL, { team: "tnt_b" }, 0, "all_teams", { team_id: "tnt_b", name: "Client B", source: "profile" }, ["GET /v1/accounts tnt_b", "GET /v1/teams -"], [true]],
    ["all-teams key, no Team: refused before any call", ALL, {}, 2, "all_teams", null, [], [false]],
    ["all-teams key, a Team they left", ALL, { team: "tnt_gone" }, 3, "all_teams", { team_id: "tnt_gone", name: null, source: "profile" }, ["GET /v1/accounts tnt_gone", "GET /v1/teams -"], [false]],
    ["Team key, no Team named: its own", "cvt_live_FAKEFIXTURE0000000000", {}, 0, "team", { team_id: "tnt_a", name: "Agency A", source: "key" }, ["GET /v1/accounts -", "GET /v1/teams -"], []],
  ] as const)("%s", async (_l, key, profile, exit, scope, team, sent, teamCheck) => {
    sink.reply = (h) =>
      h.url.startsWith("/v1/teams") ? { body: TEAMS }
      : h.headers["x-curviate-team"] === "tnt_gone" ? { status: 403, body: DENIED }
      : { body: { object: "list", items: [], cursor: null } };
    const r = await sink.run(["doctor", "--json"], { xdg: configHome(profile), env: { CURVIATE_API_KEY: key } });
    const report = JSON.parse(r.stdout) as { key_scope: string; team: unknown; checks: Array<{ name: string; ok: boolean }> };
    expect([r.status, report.key_scope, report.team]).toEqual([exit, scope, team]);
    expect(report.checks.filter((c) => c.name === "team").map((c) => c.ok)).toEqual(teamCheck);
    expect(r.requests.map((q) => `${line(q)} ${q.headers["x-curviate-team"] ?? "-"}`)).toEqual(sent);
    expect(r.stdout).not.toContain(key);
  });
});

describe("setup asks for the Team picker and stores the exchange's Team", () => {
  afterEach(() => setTeamFlag(undefined));

  async function exchangeWith(body: Record<string, unknown>, teams: unknown, xdg: string) {
    process.env["XDG_CONFIG_HOME"] = xdg;
    const material = generateSessionMaterial();
    const out: string[] = [];
    const verified: Array<string | undefined> = [];
    const io = resolveSetupIO({
      stdout: { write: (s) => void out.push(s) }, stderr: { write: () => {} }, isTTY: false, isOutputTTY: false, env: {}, platform: "linux",
      fetch: (async () => new Response(JSON.stringify({ sealed_key: seal(ALL, material.publicKey), tenant_name: "Agency A", ...body }), { status: 200 })) as typeof fetch,
      verify: async (_k, _u, team) => void verified.push(team),
      listTeams: async () => teams,
      generate: () => material,
    });
    setTeamFlag("tnt_pre");
    const start = await runSetup({ json: true, "base-url": "http://127.0.0.1:9" }, io);
    const url = new URL((JSON.parse(out[0]!) as { authorize_url: string }).authorize_url);
    const exit = await runSetup({ json: true, code: "WDJBMJHT" }, io);
    const cfg = JSON.parse(readFileSync(join(xdg, "curviate", "config.json"), "utf8")) as { profiles: { default: { team?: string } } };
    delete process.env["XDG_CONFIG_HOME"];
    return { start, exit, url, team: cfg.profiles.default.team, verified };
  }

  it.each([
    ["an all-teams key: its Team is stored and verified in", { team_id: "tnt_b" }, TEAMS, {}, "tnt_b"],
    ["a Team the person left meanwhile: not stored", { team_id: "tnt_gone" }, TEAMS, {}, undefined],
    ["a Team key replaces an all-teams profile: the old Team is cleared", {}, TEAMS, { team: "tnt_old" }, undefined],
  ] as const)("%s", async (_l, body, teams, profile, stored) => {
    const r = await exchangeWith(body, teams, configHome(profile));
    expect([r.start, r.exit, r.url.searchParams.get("picker"), r.url.searchParams.get("team")]).toEqual([0, 0, "1", "tnt_pre"]);
    expect([r.team, r.verified]).toEqual([stored, [stored]]);
  });
});
