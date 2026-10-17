/**
 * Paste ergonomics: the code prompt must be a plain visible input (a masked widget swallows bracketed paste),
 * and every shape a real paste arrives in reaches the exchange as WDJBMJHT through the REAL reader.
 * The structural arm has the teeth: the masked and plain branches yield the same string for a scripted stream.
 */
import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup, resolveSetupIO, generateSessionMaterial } from "../../src/commands/setup.js";
import type { ReadlineStdin } from "../../src/lib/readline.js";
import { seal } from "../helpers/f2-seal.js";

/** A real stream with `setRawMode` present, so a masked implementation could not silently fall back to the plain path. */
function scriptedStream(text: string): ReadlineStdin {
  const stream = new PassThrough();
  stream.write(text);
  stream.end();
  return Object.assign(stream, { isTTY: true, setRawMode: () => {} }) as unknown as ReadlineStdin;
}

let xdg: string;
beforeEach(() => {
  xdg = mkdtempSync(join(tmpdir(), "curviate-paste-"));
  process.env["XDG_CONFIG_HOME"] = xdg;
});
afterEach(() => {
  delete process.env["XDG_CONFIG_HOME"];
  rmSync(xdg, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

it("the production default prompt never asks the shared reader to mask", async () => {
  vi.resetModules();
  const calls: Array<{ opts?: { mask?: boolean } }> = [];
  vi.doMock("../../src/lib/readline.js", () => ({
    readlineSync: async (_p: string, opts?: { mask?: boolean }) => (calls.push({ opts }), "WDJB-MJHT"),
  }));
  const mod = await import("../../src/commands/setup.js");
  await mod.resolveSetupIO({}).prompt("Paste the code: ");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.opts?.mask).not.toBe(true);
});

it.each([
  ["a plain paste", "WDJB-MJHT\n"],
  ["a lowercase paste", "wdjb-mjht\n"],
  ["a paste with the hyphen dropped", "WDJBMJHT\n"],
  ["a paste with a trailing space", "WDJB-MJHT \n"],
  ["a bracketed paste", "\x1b[200~WDJB-MJHT\x1b[201~\n"],
])("%s submits WDJBMJHT", async (_l, typed) => {
  const material = generateSessionMaterial();
  const requests: Array<{ verification_code: string }> = [];
  const io = resolveSetupIO({
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    isTTY: true,
    isOutputTTY: true,
    env: { CI: "1" },
    platform: "linux",
    stdinStream: scriptedStream(typed),
    fetch: (async (_u: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return { ok: true, status: 200, json: async () => ({ sealed_key: seal("rdc_live_PASTEFIXTUREKEY0001", material.publicKey), tenant_name: "Paste Workspace" }) } as unknown as Response;
    }) as unknown as typeof fetch,
    verify: async () => {},
    generate: () => material,
  });
  const exit = await runSetup({ "base-url": "http://127.0.0.1:9/api" } as never, io);
  expect(requests.map((r) => r.verification_code)).toEqual(["WDJBMJHT"]);
  expect(exit).toBe(0);
});
