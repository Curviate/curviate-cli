import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readConfig,
  writeProfile,
  setActiveProfile,
  renameProfile,
  removeProfile,
  updateProfileField,
  getConfigPath,
  type CliConfig,
} from "../../src/lib/config.js";

// Helper: resolve expected config path for a given XDG_CONFIG_HOME
function expectedPath(xdgHome: string) {
  return join(xdgHome, "curviate", "config.json");
}

describe("lib/config — config file", () => {
  let tmpDir: string;
  let origXdg: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "curviate-test-config-"));
    origXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = tmpDir;
  });

  afterEach(async () => {
    if (origXdg === undefined) {
      delete process.env["XDG_CONFIG_HOME"];
    } else {
      process.env["XDG_CONFIG_HOME"] = origXdg;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("getConfigPath returns path under XDG_CONFIG_HOME", () => {
    const p = getConfigPath();
    expect(p).toBe(expectedPath(tmpDir));
  });

  it("readConfig returns null when file does not exist", async () => {
    const cfg = await readConfig();
    expect(cfg).toBeNull();
  });

  it("writeProfile creates config with correct file and dir permissions (POSIX)", async () => {
    await writeProfile("default", {
      apiKey: "rdc_live_TESTKEY",
      account: "acc_1",
    });

    const cfgPath = getConfigPath();
    const dirPath = join(tmpDir, "curviate");

    const fileStat = await stat(cfgPath);
    const dirStat = await stat(dirPath);

    // mode & 0o777: file must be 0600, dir must be 0700
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(dirStat.mode & 0o777).toBe(0o700);

    // content
    const raw = await readFile(cfgPath, "utf8");
    const parsed = JSON.parse(raw) as CliConfig;
    expect(parsed.active).toBe("default");
    expect(parsed.profiles["default"]?.apiKey).toBe("rdc_live_TESTKEY");
    expect(parsed.profiles["default"]?.account).toBe("acc_1");
  });

  it("writeProfile is atomic — reads correct content after write", async () => {
    await writeProfile("default", { apiKey: "rdc_live_FIRST" });
    await writeProfile("default", { apiKey: "rdc_live_SECOND" });

    const cfg = await readConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.profiles["default"]?.apiKey).toBe("rdc_live_SECOND");
  });

  it("writeProfile preserves other profiles", async () => {
    await writeProfile("default", { apiKey: "rdc_live_A" });
    await writeProfile("work", { apiKey: "rdc_live_B" });

    const cfg = await readConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.profiles["default"]?.apiKey).toBe("rdc_live_A");
    expect(cfg!.profiles["work"]?.apiKey).toBe("rdc_live_B");
    // active stays as it was (first profile written)
    expect(cfg!.active).toBe("default");
  });

  it("writeProfile re-asserts 0600 on subsequent writes to existing file", async () => {
    await writeProfile("default", { apiKey: "rdc_live_A" });
    // write again — permissions must still be 0600
    await writeProfile("default", { apiKey: "rdc_live_B" });
    const cfgPath = getConfigPath();
    const fileStat = await stat(cfgPath);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });
});

describe("lib/config — profile management", () => {
  let tmpDir: string;
  let origXdg: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "curviate-test-config-"));
    origXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = tmpDir;
  });

  afterEach(async () => {
    if (origXdg === undefined) {
      delete process.env["XDG_CONFIG_HOME"];
    } else {
      process.env["XDG_CONFIG_HOME"] = origXdg;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("setActiveProfile switches active pointer", async () => {
    await writeProfile("default", { apiKey: "rdc_live_A" });
    await writeProfile("work", { apiKey: "rdc_live_B" });
    await setActiveProfile("work");
    const cfg = await readConfig();
    expect(cfg!.active).toBe("work");
  });

  it("setActiveProfile throws if profile missing", async () => {
    await writeProfile("default", { apiKey: "rdc_live_A" });
    await expect(setActiveProfile("missing")).rejects.toThrow();
  });

  it("renameProfile renames and updates active", async () => {
    await writeProfile("default", { apiKey: "rdc_live_A" });
    await writeProfile("work", { apiKey: "rdc_live_B" });
    await setActiveProfile("work");
    await renameProfile("work", "team");
    const cfg = await readConfig();
    expect(cfg!.profiles["team"]).toBeDefined();
    expect(cfg!.profiles["work"]).toBeUndefined();
    expect(cfg!.active).toBe("team");
  });

  it("renameProfile throws if old missing", async () => {
    await writeProfile("default", { apiKey: "rdc_live_A" });
    await expect(renameProfile("missing", "new")).rejects.toThrow();
  });

  it("renameProfile throws if new already exists", async () => {
    await writeProfile("default", { apiKey: "rdc_live_A" });
    await writeProfile("work", { apiKey: "rdc_live_B" });
    await expect(renameProfile("work", "default")).rejects.toThrow();
  });

  it("removeProfile removes a non-active profile", async () => {
    await writeProfile("default", { apiKey: "rdc_live_A" });
    await writeProfile("work", { apiKey: "rdc_live_B" });
    await removeProfile("work");
    const cfg = await readConfig();
    expect(cfg!.profiles["work"]).toBeUndefined();
    expect(cfg!.active).toBe("default");
  });

  it("removeProfile repoints active to default when removing active profile", async () => {
    await writeProfile("default", { apiKey: "rdc_live_A" });
    await writeProfile("work", { apiKey: "rdc_live_B" });
    await setActiveProfile("work");
    await removeProfile("work");
    const cfg = await readConfig();
    expect(cfg!.profiles["work"]).toBeUndefined();
    expect(cfg!.active).toBe("default");
  });

  it("updateProfileField sets account on active profile", async () => {
    await writeProfile("default", { apiKey: "rdc_live_A" });
    await updateProfileField("default", "account", "acc_9");
    const cfg = await readConfig();
    expect(cfg!.profiles["default"]?.account).toBe("acc_9");
  });
});

// ---------------------------------------------------------------------------
// `cfg.profiles[profileName]` falls through to Object.prototype.
//
// `profileName` is a value the user typed on the command line
// (`curviate config use <name>` / `--profile <name>`). Every function above
// reads `cfg.profiles[profileName]` against `profiles`, which comes straight
// off `JSON.parse` (readConfig) or a fresh `{}` literal (writeProfile's
// no-file fallback) -- both plain objects. `profiles["constructor"]` is a
// live Function inherited from Object.prototype, truthy, so a naive
// existence check (`if (!cfg.profiles[name])`) incorrectly treated
// "constructor" as an EXISTING profile that was never written -- the CLI
// could be told to switch to, or refuse to create, a profile that does not
// exist. Every assertion below drives the real on-disk config through the
// real exported functions, never the internal map.
// ---------------------------------------------------------------------------
describe("lib/config — profile names never fall through to Object.prototype", () => {
  let tmpDir: string;
  let origXdg: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "curviate-test-config-990-"));
    origXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = tmpDir;
  });

  afterEach(async () => {
    if (origXdg === undefined) {
      delete process.env["XDG_CONFIG_HOME"];
    } else {
      process.env["XDG_CONFIG_HOME"] = origXdg;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  const PROTO_KEYS = ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"];

  it.each(PROTO_KEYS)(
    "setActiveProfile(%j) throws 'not found' -- it was never written",
    async (name) => {
      await writeProfile("default", { apiKey: "rdc_live_A" });
      await expect(setActiveProfile(name)).rejects.toThrow(/not found/);
      const cfg = await readConfig();
      // active must be unchanged -- the polluted call must not have "succeeded".
      expect(cfg!.active).toBe("default");
    },
  );

  it.each(PROTO_KEYS)(
    "renameProfile(\"work\", %j) does NOT throw 'already exists' -- it was never written",
    async (name) => {
      await writeProfile("default", { apiKey: "rdc_live_A" });
      await writeProfile("work", { apiKey: "rdc_live_B" });
      await expect(renameProfile("work", name)).resolves.toBeUndefined();
      const cfg = await readConfig();
      expect(cfg!.profiles[name]).toBeDefined();
      expect(cfg!.profiles[name]?.apiKey).toBe("rdc_live_B");
    },
  );

  it.each(PROTO_KEYS)(
    "a profile actually named %j can be written, read back, and switched to (round-trip)",
    async (name) => {
      await writeProfile(name, { apiKey: "rdc_live_POISON" });
      await setActiveProfile(name);
      const cfg = await readConfig();
      expect(cfg!.active).toBe(name);
      expect(cfg!.profiles[name]?.apiKey).toBe("rdc_live_POISON");
    },
  );

  it("an ordinary profile name still round-trips through every function unaffected", async () => {
    await writeProfile("default", { apiKey: "rdc_live_A" });
    await writeProfile("work", { apiKey: "rdc_live_B" });
    await setActiveProfile("work");
    await renameProfile("work", "team");
    await updateProfileField("team", "account", "acc_9");
    const cfg = await readConfig();
    expect(cfg!.active).toBe("team");
    expect(cfg!.profiles["team"]?.account).toBe("acc_9");
    await removeProfile("team");
    const after = await readConfig();
    expect(after!.profiles["team"]).toBeUndefined();
  });

  it("an unknown-but-ordinary profile name (widget_exploded) still throws 'not found', unchanged behaviour", async () => {
    await writeProfile("default", { apiKey: "rdc_live_A" });
    await expect(setActiveProfile("widget_exploded")).rejects.toThrow(/not found/);
  });
});
