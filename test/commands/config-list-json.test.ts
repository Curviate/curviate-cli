/**
 * `config list --json` must report every profile on disk, including one
 * literally named `__proto__`, matching text mode byte-for-byte in coverage.
 *
 * `config.ts`'s json branch builds a fresh `redacted` object and assigns
 * `redacted[name] = {...}` for each profile. `redacted` starts as a plain
 * `{}`, which has `Object.prototype` in its chain, so `redacted["__proto__"]
 * = value` does not create an own property -- it hits the inherited
 * `__proto__` accessor and reassigns `redacted`'s own prototype instead.
 * `JSON.stringify` only walks own enumerable keys, so the profile silently
 * vanishes from `--json` output while text mode (which iterates
 * `cfg.profiles` directly, never re-keying into a fresh plain object) prints
 * it fine -- exit 0, no warning, an agent branching on `--json` gets an
 * incomplete answer with a success exit code.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeProfile, setActiveProfile } from "../../src/lib/config.js";

/** `defineCommand` is an identity function in citty; cast to reach `.run` directly. */
type SubCommandMap = Record<string, { run?: (ctx: { args: Record<string, unknown> }) => Promise<void> }>;

async function loadConfigListRun() {
  const { configCommand } = await import("../../src/commands/config.js");
  const subCommands = (configCommand as unknown as { subCommands: SubCommandMap }).subCommands;
  const run = subCommands["list"]?.run;
  if (!run) throw new Error("config list has no run()");
  return run;
}

describe("config list --json — every on-disk profile is reported, including __proto__", () => {
  let tmpDir: string;
  let origXdg: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "curviate-test-config-list-"));
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
    vi.restoreAllMocks();
  });

  it("a profile named __proto__ appears in --json output, same as text mode", async () => {
    await writeProfile("default", { apiKey: "rdc_live_A" });
    await writeProfile("__proto__", { apiKey: "rdc_live_POISON" });
    await setActiveProfile("default");

    const run = await loadConfigListRun();
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await run({ args: { json: true } });

    const printed = writeSpy.mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(printed) as { active: string; profiles: Record<string, unknown> };

    expect(Object.keys(parsed.profiles).sort()).toEqual(["__proto__", "default"]);
    expect(parsed.profiles["__proto__"]).toBeDefined();
  });

  it("--json profile count matches text-mode profile count for the same config", async () => {
    await writeProfile("default", { apiKey: "rdc_live_A" });
    await writeProfile("__proto__", { apiKey: "rdc_live_POISON" });
    await writeProfile("work", { apiKey: "rdc_live_B" });
    await setActiveProfile("default");

    const run = await loadConfigListRun();

    const jsonSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await run({ args: { json: true } });
    const jsonPrinted = jsonSpy.mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(jsonPrinted) as { profiles: Record<string, unknown> };
    jsonSpy.mockRestore();

    const textSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await run({ args: { json: false } });
    const textPrinted = textSpy.mock.calls.map((c) => c[0] as string).join("");
    textSpy.mockRestore();

    const textNameCount = (textPrinted.match(/^\S/gm) ?? []).length;
    expect(Object.keys(parsed.profiles)).toHaveLength(textNameCount);
    expect(Object.keys(parsed.profiles).sort()).toEqual(["__proto__", "default", "work"]);
  });
});
