import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readConfig, writeProfile, setActiveProfile, renameProfile, removeProfile, updateProfileField, getConfigPath, type CliConfig } from "../../src/lib/config.js";
import { resolveEffectiveConfig } from "../../src/lib/resolve.js";

let tmpDir: string;
const ENV_KEYS = ["XDG_CONFIG_HOME", "CURVIATE_API_KEY", "CURVIATE_BASE_URL", "CURVIATE_ACCOUNT"];
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "curviate-test-config-"));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS.slice(1)) delete process.env[k];
  process.env["XDG_CONFIG_HOME"] = tmpDir;
});
afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(tmpDir, { recursive: true, force: true });
});
const key = (k: string) => ({ apiKey: `rdc_live_${k}` });
const cfg = async () => (await readConfig())!;

describe("config file", () => {
  it("lives under XDG_CONFIG_HOME and reads as null when absent", async () => {
    expect(getConfigPath()).toBe(join(tmpDir, "curviate", "config.json"));
    expect(await readConfig()).toBeNull();
  });

  it("writeProfile creates the file 0600 in a 0700 dir, re-asserts 0600 on rewrite, keeps other profiles and the active pointer", async () => {
    await writeProfile("default", { apiKey: "rdc_live_TESTKEY", account: "acc_1" });
    expect((await stat(getConfigPath())).mode & 0o777).toBe(0o600);
    expect((await stat(join(tmpDir, "curviate"))).mode & 0o777).toBe(0o700);
    const parsed = JSON.parse(await readFile(getConfigPath(), "utf8")) as CliConfig;
    expect([parsed.active, parsed.profiles["default"]]).toEqual(["default", { apiKey: "rdc_live_TESTKEY", account: "acc_1" }]);
    await writeProfile("default", key("SECOND"));
    await writeProfile("work", key("B"));
    expect((await stat(getConfigPath())).mode & 0o777).toBe(0o600);
    const c = await cfg();
    expect([c.profiles["default"]?.apiKey, c.profiles["work"]?.apiKey, c.active]).toEqual(["rdc_live_SECOND", "rdc_live_B", "default"]);
  });
});

describe("profile management", () => {
  beforeEach(async () => {
    await writeProfile("default", key("A"));
    await writeProfile("work", key("B"));
  });

  it("setActiveProfile switches the pointer and throws on a missing profile", async () => {
    await setActiveProfile("work");
    expect((await cfg()).active).toBe("work");
    await expect(setActiveProfile("missing")).rejects.toThrow(/not found/);
  });

  it("renameProfile moves the profile and the active pointer; throws if old is missing or new exists", async () => {
    await setActiveProfile("work");
    await renameProfile("work", "team");
    const c = await cfg();
    expect([c.profiles["team"]?.apiKey, c.profiles["work"], c.active]).toEqual(["rdc_live_B", undefined, "team"]);
    await expect(renameProfile("missing", "new")).rejects.toThrow();
    await expect(renameProfile("team", "default")).rejects.toThrow();
  });

  it("removeProfile removes one, repointing active to default when it was active; updateProfileField sets a field", async () => {
    await setActiveProfile("work");
    await removeProfile("work");
    expect([(await cfg()).profiles["work"], (await cfg()).active]).toEqual([undefined, "default"]);
    await updateProfileField("default", "account", "acc_9");
    expect((await cfg()).profiles["default"]?.account).toBe("acc_9");
  });

  it.each(["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"])(
    "profile name %j never falls through to Object.prototype: not found when never written, renamable to, and round-trips when written",
    async (name) => {
      await expect(setActiveProfile(name)).rejects.toThrow(/not found/);
      expect((await cfg()).active).toBe("default");
      await renameProfile("work", name);
      expect((await cfg()).profiles[name]?.apiKey).toBe("rdc_live_B");
      await writeProfile(name, key("POISON"));
      await setActiveProfile(name);
      expect([(await cfg()).active, (await cfg()).profiles[name]?.apiKey]).toEqual([name, "rdc_live_POISON"]);
    },
  );
});

describe("effective config precedence: flag > env > profile > default", () => {
  const profile = { apiKey: "rdc_live_P", baseUrl: "https://p.test", account: "acc_p" };

  it("flag beats env beats profile, per field", async () => {
    await writeProfile("default", profile);
    process.env["CURVIATE_API_KEY"] = "rdc_live_E";
    expect(await resolveEffectiveConfig({ apiKey: "rdc_live_F", baseUrl: "https://f.test", account: "acc_f" })).toMatchObject({ apiKey: "rdc_live_F", baseUrl: "https://f.test", account: "acc_f" });
    expect(await resolveEffectiveConfig({})).toMatchObject({ apiKey: "rdc_live_E", baseUrl: "https://p.test", account: "acc_p" });
    process.env["CURVIATE_ACCOUNT"] = "acc_env";
    process.env["CURVIATE_BASE_URL"] = "https://env.test";
    expect(await resolveEffectiveConfig({})).toMatchObject({ baseUrl: "https://env.test", account: "acc_env" });
    for (const k of ENV_KEYS.slice(1)) delete process.env[k];
    expect(await resolveEffectiveConfig({})).toMatchObject(profile);
  });

  it("defaults: SDK base URL, 30000 ms timeout (a numeric flag string is parsed), no key anywhere is undefined", async () => {
    expect(await resolveEffectiveConfig({})).toMatchObject({ apiKey: undefined, baseUrl: "https://api.curviate.com", timeout: 30000 });
    expect((await resolveEffectiveConfig({ timeout: "5000" })).timeout).toBe(5000);
  });

  it("--profile selects a non-active profile", async () => {
    await writeProfile("default", key("DEFAULT"));
    await writeProfile("work", key("WORK"));
    expect((await resolveEffectiveConfig({ profile: "work" })).apiKey).toBe("rdc_live_WORK");
  });
});
