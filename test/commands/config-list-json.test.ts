/** `config list --json` must report every profile on disk, including one named `__proto__` (a fresh `{}` re-key would drop it), matching text mode. */
import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeProfile, setActiveProfile } from "../../src/lib/config.js";
import { configCommand } from "../../src/commands/config.js";

let tmpDir: string;
let origXdg: string | undefined;
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "curviate-test-config-list-"));
  origXdg = process.env["XDG_CONFIG_HOME"];
  process.env["XDG_CONFIG_HOME"] = tmpDir;
});
afterEach(async () => {
  if (origXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = origXdg;
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function list(json: boolean) {
  const run = (configCommand as unknown as { subCommands: Record<string, { run: (c: { args: object }) => Promise<void> }> }).subCommands["list"]!.run;
  const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await run({ args: { json } });
  const printed = spy.mock.calls.map((c) => c[0] as string).join("");
  spy.mockRestore();
  return printed;
}

it("a profile named __proto__ appears in --json, and the --json profile count equals the text-mode count", async () => {
  for (const name of ["default", "__proto__", "work"]) await writeProfile(name, { apiKey: `rdc_live_${name}` });
  await setActiveProfile("default");
  const parsed = JSON.parse(await list(true)) as { profiles: Record<string, unknown> };
  expect(Object.keys(parsed.profiles).sort()).toEqual(["__proto__", "default", "work"]);
  expect(((await list(false)).match(/^\S/gm) ?? []).length).toBe(3);
});
