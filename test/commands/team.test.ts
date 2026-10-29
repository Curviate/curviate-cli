/** Teams: which Team a call acts in, and the `team` commands, as the requests they send. */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
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

describe("team commands: the request each sends", () => {
  const png = join(configHome(), "logo.png");
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  it.each([
    [["team", "list", "--counts"], "GET /v1/teams?include=counts", ""],
    [["team", "get"], "GET /v1/teams/current", ""],
    [["team", "update", "--name", "Acme", "--billing-owner", "usr_1"], "PATCH /v1/teams/current", { name: "Acme", billing_owner_user_id: "usr_1" }],
    [["team", "create", "Acme (client)"], "POST /v1/teams", { name: "Acme (client)" }],
    [["team", "members", "--limit", "5"], "GET /v1/teams/current/members?limit=5", ""],
    [["team", "role", "usr_1", "manager"], "PATCH /v1/teams/current/members/usr_1", { role: "manager" }],
    [["team", "remove", "usr_1"], "DELETE /v1/teams/current/members/usr_1", ""],
    [["team", "leave"], "DELETE /v1/teams/current/members/me", ""],
    [["team", "invites", "create", "a@example.com,b@example.com", "--role", "manager"], "POST /v1/teams/current/invites", { invites: [{ email: "a@example.com", role: "manager" }, { email: "b@example.com", role: "manager" }] }],
    [["team", "invites", "list", "--status", "pending"], "GET /v1/teams/current/invites?status=pending", ""],
    [["team", "invites", "resend", "inv_1"], "POST /v1/teams/current/invites/inv_1/resend", ""],
    [["team", "invites", "revoke", "inv_1"], "DELETE /v1/teams/current/invites/inv_1", ""],
    [["team", "logo", "set", png], "PUT /v1/teams/current/logo", "PNG\u0001\u0002\u0003"],
    [["team", "logo", "remove"], "DELETE /v1/teams/current/logo", ""],
    [["team", "seats", "lend", "--to", "tnt_b", "--seat", "seat_1"], "POST /v1/billing/seats/lend", { team_id: "tnt_b", seat_id: "seat_1" }],
    [["team", "seats", "return", "seat_1"], "POST /v1/billing/seats/seat_1/return", ""],
  ] as const)("%j", async (args, sent, body) => {
    // Readable as an object and as a list page, so one reply serves every row.
    sink.reply = { body: { object: "team", team_id: "tnt_a", items: [], cursor: null } };
    const r = await sink.run([...args, "--json", "--team", "tnt_a"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests.map((q) => [`${q.method} ${q.url}`, q.headers["x-curviate-team"]])).toEqual([[sent, "tnt_a"]]);
    const got = r.requests[0]!.body;
    if (typeof body === "string") expect(body === "" ? got : got.endsWith(body)).toBe(body === "" ? "" : true);
    else expect(JSON.parse(got)).toEqual(body);
    expect(JSON.parse(r.stdout)).toMatchObject({ team_id: "tnt_a" });
  });

  it("a refusal keeps its exit class: SEAT_LENT exits 11 with its message", async () => {
    sink.reply = { status: 409, body: { code: "SEAT_LENT", message: "That seat is lent to another of your Teams.", user_fixable: true, retry_likely_to_succeed: false } };
    const r = await sink.run(["team", "seats", "lend", "--to", "tnt_b"]);
    expect([r.status, r.stderr]).toEqual([11, expect.stringContaining("lent")]);
  });

  it("human output names no vendor", async () => {
    sink.reply = { body: TEAMS };
    const r = await sink.run(["team", "list"]);
    expect(r.status).toBe(0);
    expect((r.stdout + r.stderr).toLowerCase()).not.toContain(["uni", "pile"].join("")); // spelled apart: the source scan forbids the name
  });
});

describe("team switch rewrites the profile's team", () => {
  it.each([
    ["by id, all-teams key", ALL, "tnt_b", 0, "tnt_b"],
    ["by exact name", ALL, "Client B", 0, "tnt_b"],
    ["not one of theirs: exit 2, unchanged", ALL, "tnt_x", 2, "tnt_old"],
    ["a Team key and another Team: exit 3, unchanged", "cvt_live_FAKEFIXTURE0000000000", "tnt_b", 3, "tnt_old"],
  ] as const)("%s", async (_l, key, target, exit, stored) => {
    sink.reply = { body: TEAMS };
    const xdg = configHome({ team: "tnt_old" });
    const r = await sink.run(["team", "switch", target, "--json"], { xdg, env: { CURVIATE_API_KEY: key } });
    expect(r.status, r.stderr).toBe(exit);
    expect(r.requests.map((q) => `${line(q)} ${q.headers["x-curviate-team"] ?? "-"}`)).toEqual(["GET /v1/teams -"]);
    const cfg = JSON.parse(readFileSync(join(xdg, "curviate", "config.json"), "utf8")) as { profiles: { default: { team?: string } } };
    expect(cfg.profiles.default.team).toBe(stored);
    const next = await sink.run(["team", "get", "--json"], { xdg, env: { CURVIATE_API_KEY: key } });
    expect(next.requests[0]?.headers["x-curviate-team"]).toBe(stored);
  });
});

const TIER = {
  object: "tier", tier: "automate", bought_tier: "build", period: "monthly",
  trial: { tier: "automate", expires_at: "2026-11-05T00:00:00Z" }, override: null, pending: null,
  features: ["drafts", "motions"], early_access: [{ tier: "enhance", requested_at: null }],
};

/** Human mode: the CLI renders for a person only when stdout is a terminal. */
async function asHuman<T>(run: () => Promise<T>): Promise<T> {
  const was = process.stdout.isTTY;
  process.stdout.isTTY = true;
  try {
    return await run();
  } finally {
    process.stdout.isTTY = was;
  }
}

describe("the Tier", () => {
  it("`tier` reads GET /v1/billing/tier: JSON verbatim, every field in human output", async () => {
    sink.reply = { body: TIER };
    const json = await sink.run(["tier", "--json"]);
    expect([json.status, json.requests.map(line), JSON.parse(json.stdout)]).toEqual([0, ["GET /v1/billing/tier"], TIER]);
    const human = await asHuman(() => sink.run(["tier"]));
    expect(human.status).toBe(0);
    for (const v of ["automate", "build (monthly)", "2026-11-05T00:00:00Z", "drafts, motions", "enhance (not requested)"]) expect(human.stdout).toContain(v);
  });

  it.each([
    ["an Owner gets the upgrade link", { upgrade_url: "https://app.curviate.com/settings/billing" }, "Upgrade: https://app.curviate.com/settings/billing"],
    ["anyone else is sent to an Owner", {}, "Ask an Owner"],
  ])("TIER_REQUIRED exits 5 naming the feature, the Tier and the remedy: %s", async (_l, extra, remedy) => {
    sink.reply = { status: 403, body: { code: "TIER_REQUIRED", message: "Motions are part of Automate.", user_fixable: true, retry_likely_to_succeed: false, feature: "motions", required_tier: "automate", current_tier: "build", ...extra } };
    const r = await asHuman(() => sink.run(["motion", "start", "mot_1"]));
    expect(r.status).toBe(5);
    expect(r.stderr).toContain("motions is part of automate; this Team has build.");
    expect(r.stderr).toContain(remedy);
    expect(r.stderr.toLowerCase()).not.toContain(["uni", "pile"].join(""));
  });

  // The served OpenAPI marks each operation a Tier gates (`x-curviate-tier`); each command sending one says so in its help.
  it.each([
    ["motion create", "post", "/v1/motions"], ["motion update", "patch", "/v1/motions/{id}"], ["motion start", "post", "/v1/motions/{id}/start"],
    ["motion resume", "post", "/v1/motions/{id}/resume"], ["motion add", "post", "/v1/motions/{id}/contacts"],
    ["enrollment resume", "post", "/v1/enrollments/{id}/resume"], ["enrollment event", "post", "/v1/enrollments/{id}/events"],
    ["enrollment signal", "post", "/v1/enrollments/{id}/signal"], ["enrollment reassign", "post", "/v1/enrollments/{id}/reassign"],
    ["network resync", "post", "/v1/network/resync"], ["unibox refresh", "post", "/v1/unibox/refresh"],
    ["unibox tag", "post", "/v1/unibox/chats/{account_id}/{chat_id}/contact"], ["unibox enroll", "post", "/v1/unibox/chats/{account_id}/{chat_id}/enrollments"],
    ["incoming create", "post", "/v1/incoming-events"], ["incoming rotate", "post", "/v1/incoming-events/{id}/rotate"], ["incoming capture", "post", "/v1/incoming-events/{id}/capture"],
    ["core draft create", "post", "/v1/drafts"], ["core draft update", "patch", "/v1/drafts/{id}"], ["core draft publish", "post", "/v1/drafts/{id}/publish"],
  ])("%s (%s %s) says it needs Automate", (cmd, method, path) => {
    const api = JSON.parse(readFileSync(resolve(pkgRoot, "test/fixtures/openapi.json"), "utf8")) as { paths: Record<string, Record<string, Record<string, unknown>>> };
    expect(api.paths[path]?.[method]?.["x-curviate-tier"]).toBe("automate");
    const { commands } = JSON.parse(readFileSync(resolve(pkgRoot, "commands.json"), "utf8")) as { commands: Array<{ path: string[]; description: string }> };
    expect(commands.find((c) => c.path.join(" ") === cmd)?.description).toContain("Needs Automate.");
  });
});
