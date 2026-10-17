/**
 * `curviate doctor`, the one command that answers "can I run?". Seam tests inject only the API call (config
 * resolution, precedence and the exit decision are production); the CLI-level arm injects nothing (real version
 * reader, real serialisation) and runs through the entry point against a stub API.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CurviateError } from "@curviate/sdk";
import { runDoctor, resolveDoctorIO, type DoctorIO } from "../../src/commands/doctor.js";
import { useSink } from "../helpers/sink.js";

const err = (code: string, message: string, o: { httpStatus?: number; retry?: boolean } = {}) =>
  new CurviateError({ code: code as never, message, httpStatus: o.httpStatus, userFixable: !o.retry, retryLikelyToSucceed: o.retry ?? false });
/** What the SDK transport throws when nothing reached the API: INTERNAL, no httpStatus, retryable. */
const transportFailure = (m = "Network error.") => err("INTERNAL", m, { retry: true });
const ACCOUNTS = { items: [{ id: "acc_one", status: "OK" }, { id: "acc_two", status: "CREDENTIALS" }], cursor: null };

let xdg: string;
const writeConfig = (config: unknown) => {
  mkdirSync(join(xdg, "curviate"), { recursive: true });
  writeFileSync(join(xdg, "curviate", "config.json"), JSON.stringify(config), { mode: 0o600 });
};
const profileCfg = (p: object) => writeConfig({ active: "default", profiles: { default: { baseUrl: "https://example.test", ...p } } });
const io = (o: Partial<DoctorIO> = {}) =>
  resolveDoctorIO({ stdout: { write: () => {} }, stderr: { write: () => {} }, isOutputTTY: false, version: () => "9.9.9", listAccounts: async () => ACCOUNTS, ...o });
const failing = (e: unknown) => io({ listAccounts: async () => Promise.reject(e) });
const checkOf = (r: Awaited<ReturnType<typeof runDoctor>>, name: string) => r.checks.find((c) => c.name === name);

beforeEach(() => {
  xdg = mkdtempSync(join(tmpdir(), "curviate-doctor-"));
  process.env["XDG_CONFIG_HOME"] = xdg;
  for (const k of ["CURVIATE_API_KEY", "CURVIATE_BASE_URL", "CURVIATE_ACCOUNT"]) delete process.env[k];
});
afterEach(() => {
  delete process.env["XDG_CONFIG_HOME"];
  rmSync(xdg, { recursive: true, force: true });
});

describe("everything green", () => {
  beforeEach(() => profileCfg({ apiKey: "rdc_live_DOCTORFIXTURE", tenant: "Doctor Workspace" }));

  it("reports every promised field and exits 0; the credential VALUE is never carried, only its tier", async () => {
    const r = await runDoctor({}, io());
    expect(r).toMatchObject({
      exit: 0, ok: true, version: "9.9.9", config_path: join(xdg, "curviate", "config.json"), profile: "default", base_url: "https://example.test",
      credential_resolved: true, credential_source: "profile", tenant: "Doctor Workspace", api_reachable: true, credential_valid: true,
      accounts: [{ account_id: "acc_one", status: "OK" }, { account_id: "acc_two", status: "CREDENTIALS" }],
    });
    expect(JSON.stringify(r)).not.toContain("rdc_live_DOCTORFIXTURE");
  });

  it("names the precedence tier that won (env, then flag) without leaking either value; --profile reads that profile", async () => {
    process.env["CURVIATE_API_KEY"] = "rdc_live_FROM_ENV";
    expect((await runDoctor({}, io())).credential_source).toBe("env");
    const flagged = await runDoctor({ "api-key": "rdc_live_FROM_FLAG" }, io());
    expect(flagged.credential_source).toBe("flag");
    expect(JSON.stringify(flagged)).not.toContain("rdc_live_FROM_FLAG");
    delete process.env["CURVIATE_API_KEY"];
    writeConfig({ active: "default", profiles: { default: { apiKey: "rdc_live_A", tenant: "Default Workspace" }, work: { apiKey: "rdc_live_B", tenant: "Work Workspace" } } });
    expect(await runDoctor({ profile: "work" }, io())).toMatchObject({ profile: "work", tenant: "Work Workspace" });
  });

  it("a workspace nobody recorded is null, not a guess, and does not fail the run", async () => {
    profileCfg({ apiKey: "rdc_live_LOGIN_ONLY" });
    expect(await runDoctor({}, io())).toMatchObject({ tenant: null, exit: 0 });
  });
});

describe("failure classification", () => {
  beforeEach(() => profileCfg({ apiKey: "rdc_live_X" }));

  it("a credential the API rejects fails the auth check by name and exits 3 (the API answered, so reachability is not what failed)", async () => {
    const r = await runDoctor({}, failing(err("UNAUTHORIZED", "Invalid or revoked API key.", { httpStatus: 401 })));
    expect(r).toMatchObject({ exit: 3, ok: false, credential_valid: false, api_reachable: true });
    expect(r.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["credential valid"]);
    expect(checkOf(r, "credential valid")?.detail).toContain("UNAUTHORIZED");
  });

  it.each([["a transport failure", transportFailure()], ["a timeout", transportFailure("Request timed out.")]])("%s: unreachable, exit 7, and the credential is not blamed", async (_l, e) => {
    const r = await runDoctor({}, failing(e));
    expect([r.api_reachable, r.exit]).toEqual([false, 7]);
    expect(r.checks.map((c) => [c.name, c.ok])).toEqual([["credential", true], ["api reachable", false], ["credential valid", false]]);
    expect(checkOf(r, "credential valid")?.detail).not.toContain("rejected");
    expect(checkOf(r, "credential valid")?.detail).toContain("could not be reached");
  });

  it("a request the client refuses to build (no httpStatus, not retryable) is a usage error, exit 2, not a network fault", async () => {
    const r = await runDoctor({}, failing(err("INVALID_REQUEST", "An apiKey is required to construct a Curviate client.")));
    expect([r.api_reachable, r.exit]).toEqual([false, 2]);
    expect(checkOf(r, "api reachable")?.detail).not.toContain("could not reach");
    expect(checkOf(r, "api reachable")?.detail).toContain("refused before it was sent");
  });

  it.each([["PLATFORM_ERROR", 503, 7], ["NO_ACTIVE_SEAT", 402, 5]])("an API that answered with %s (%i) counts as reached and maps to exit %i", async (code, httpStatus, exit) => {
    const r = await runDoctor({}, failing(err(code, "x", { httpStatus })));
    expect([r.api_reachable, checkOf(r, "api reachable")?.ok, r.exit]).toEqual([true, true, exit]);
  });
});

describe("no credential anywhere", () => {
  it("says so, names `curviate setup`, exits 3 without calling the API, and still reports config path, profile and base URL", async () => {
    let called = 0;
    const r = await runDoctor({}, io({ listAccounts: async () => (called++, ACCOUNTS) }));
    expect(r).toMatchObject({ credential_resolved: false, credential_source: "none", exit: 3, config_path: join(xdg, "curviate", "config.json"), profile: "default", base_url: "https://api.curviate.com" });
    expect(called).toBe(0);
    expect(r.checks[0]?.detail).toContain("curviate setup");
  });
});

describe("through the CLI entry point (nothing injected)", () => {
  const sink = useSink({ body: { items: [{ id: "acc_bin", status: "OK" }], cursor: null } });
  const noKey = { CURVIATE_API_KEY: undefined };
  const report = (stdout: string) => JSON.parse(stdout.trim()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  it("runs, emits the real package version and the stub's accounts, and never prints the key", async () => {
    writeConfig({ active: "default", profiles: { default: { apiKey: "rdc_live_DOCTORBIN_PROFILE", baseUrl: sink.url, tenant: "Profile Workspace" }, loginonly: { apiKey: "rdc_live_LOGINONLY", baseUrl: sink.url } } });
    const r = await sink.run(["doctor", "--json"], { xdg, env: noKey });
    expect(r.status, r.stderr).toBe(0);
    const declared = (JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as { version: string }).version;
    expect(report(r.stdout)).toMatchObject({ version: declared, credential_resolved: true, api_reachable: true, accounts: [{ account_id: "acc_bin", status: "OK" }], credential_source: "profile", tenant: "Profile Workspace" });
    expect(r.stdout + r.stderr).not.toContain("rdc_live_DOCTORBIN_PROFILE");
  });

  it("an env or flag credential reports no workspace, never the profile's", async () => {
    writeConfig({ active: "default", profiles: { default: { apiKey: "rdc_live_P", baseUrl: sink.url, tenant: "Profile Workspace" } } });
    const env = await sink.run(["doctor", "--json", "--base-url", sink.url], { xdg, env: { CURVIATE_API_KEY: "rdc_live_DOCTORBIN_ENV" } });
    const flag = await sink.run(["doctor", "--json", "--base-url", sink.url, "--api-key", "rdc_live_DOCTORBIN_FLAG"], { xdg, env: noKey });
    expect([report(env.stdout), report(flag.stdout)]).toMatchObject([{ credential_source: "env", tenant: null }, { credential_source: "flag", tenant: null }]);
    expect(env.stdout).not.toContain("Profile Workspace");
  });

  it("a login-written profile emits `tenant` as an explicit null key on the wire (unknown is not absent), every other check passing, and says 'unknown' in human mode", async () => {
    writeConfig({ active: "default", profiles: { loginonly: { apiKey: "rdc_live_LOGINONLY", baseUrl: sink.url } } });
    const r = await sink.run(["doctor", "--json", "--profile", "loginonly"], { xdg, env: noKey });
    expect(r.status, r.stderr).toBe(0);
    const rep = report(r.stdout);
    expect(Object.prototype.hasOwnProperty.call(rep, "tenant"), r.stdout).toBe(true);
    expect(rep).toMatchObject({ tenant: null, ok: true, exit: 0, credential_source: "profile" });
    expect(rep.checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      const human = await sink.run(["doctor", "--profile", "loginonly"], { xdg, env: noKey });
      const line = human.stdout.split("\n").find((l) => l.startsWith("workspace"));
      expect(line).toMatch(/unknown/);
    } finally {
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });
});
