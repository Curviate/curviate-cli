/**
 * Paste ergonomics: the four shapes a code actually arrives in, and the one
 * property that makes them work.
 *
 * ## The regression this file exists for
 *
 * The obvious way to write a "type your secret here" prompt is the masked
 * one, and this package already has that reader: `login` uses
 * `readlineSync(prompt, { mask: true })`. Reaching for it here is the shipped
 * failure in this class of tool, because a masked widget swallows bracketed
 * paste and the code is a paste, not something anyone types.
 *
 * ## Two assertions, because one of them is not enough
 *
 *  1. STRUCTURAL. The production default prompt is exercised directly and the
 *     options it hands the shared reader are captured. A prompt that asks for
 *     masking fails here. This is the arm with teeth: the shared reader's
 *     masked branch and its plain branch happen to produce the same string
 *     for a scripted in-process stream, so a purely behavioural test would
 *     stay green on the defect. Saying so here rather than pretending
 *     otherwise.
 *
 *  2. BEHAVIOURAL. The four paste shapes are driven end to end through the
 *     REAL reader over a scripted stream, and the value that reaches the
 *     exchange request is asserted. This proves normalisation is wired into
 *     the flow rather than merely unit-tested next to it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup, resolveSetupIO, type SetupIO } from "../../src/commands/setup.js";
import type { ReadlineStdin } from "../../src/lib/readline.js";

const API_KEY = "rdc_live_PASTEFIXTUREKEY0001";
const BASE_URL = "http://127.0.0.1:9/api";

function seal(plaintext: string, cliPublicKeyB64: string) {
  const ephemeral = createECDH("prime256v1");
  ephemeral.generateKeys();
  const shared = ephemeral.computeSecret(Buffer.from(cliPublicKeyB64, "base64url"));
  const key = Buffer.from(
    hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from("curviate-cli-setup-v1", "utf8"), 32),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    alg: "ECDH-P256-HKDF-SHA256-A256GCM",
    epk: ephemeral.getPublicKey().toString("base64url"),
    iv: iv.toString("base64url"),
    ciphertext: Buffer.concat([body, cipher.getAuthTag()]).toString("base64url"),
  };
}

/**
 * A scripted terminal: a real stream, pre-loaded, wearing a `setRawMode`.
 *
 * `setRawMode` is present deliberately. The shared reader takes its MASKED
 * branch only when the stream offers one, so a stub without it would make a
 * masked implementation silently fall back to the plain path, and this file
 * would be unable to fail in the direction that matters.
 *
 * The script is written before the reader attaches, so it sits in the
 * stream's own buffer and is delivered whichever branch does the reading.
 */
function scriptedStream(text: string): ReadlineStdin {
  const stream = new PassThrough();
  stream.write(text);
  stream.end();
  const withRawMode = stream as unknown as ReadlineStdin & { isTTY: boolean };
  withRawMode.isTTY = true;
  withRawMode.setRawMode = () => {};
  return withRawMode;
}

let xdg: string;

beforeEach(() => {
  xdg = mkdtempSync(join(tmpdir(), "curviate-paste-"));
  process.env["XDG_CONFIG_HOME"] = xdg;
  delete process.env["CURVIATE_API_KEY"];
  delete process.env["CURVIATE_BASE_URL"];
});

afterEach(() => {
  delete process.env["XDG_CONFIG_HOME"];
  rmSync(xdg, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// 1. Structural: the default prompt does not ask for masking
// ---------------------------------------------------------------------------

describe("the code prompt is a plain visible input", () => {
  it("the production default prompt never asks the shared reader to mask", async () => {
    vi.resetModules();
    const calls: Array<{ prompt: string; opts: unknown }> = [];
    vi.doMock("../../src/lib/readline.js", () => ({
      readlineSync: async (prompt: string, opts?: unknown) => {
        calls.push({ prompt, opts });
        return "WDJB-MJHT";
      },
    }));

    const mod = (await import("../../src/commands/setup.js")) as typeof import("../../src/commands/setup.js");
    const io = mod.resolveSetupIO({});
    await io.prompt("Paste the code: ");

    expect(calls, "the default prompt did not reach the shared reader").toHaveLength(1);
    const opts = (calls[0]!.opts ?? {}) as { mask?: boolean };
    expect(
      opts.mask,
      "the code prompt asked for masked input; a masked widget swallows bracketed paste",
    ).not.toBe(true);
  });

  it("`login`'s masked prompt is untouched, so this is a difference and not a sweep", async () => {
    // Stated as a contrast: the two prompts are deliberately different, and a
    // future edit that unifies them would be the regression, not a cleanup.
    const source = await import("node:fs/promises").then((m) =>
      m.readFile(new URL("../../src/commands/login.ts", import.meta.url), "utf8"),
    );
    expect(source).toContain("mask: true");
  });
});

// ---------------------------------------------------------------------------
// 2. Behavioural: four paste shapes, through the real reader
// ---------------------------------------------------------------------------

const PASTES: Array<[label: string, typed: string]> = [
  ["a plain paste", "WDJB-MJHT\n"],
  ["a lowercase paste", "wdjb-mjht\n"],
  ["a paste with the hyphen dropped", "WDJBMJHT\n"],
  ["a paste with a trailing space", "WDJB-MJHT \n"],
  // Bracketed paste, which a terminal switches on over a remote shell: the
  // pasted text arrives wrapped in the two escape sequences.
  ["a bracketed paste", "\x1b[200~WDJB-MJHT\x1b[201~\n"],
];

describe("every shape a real paste arrives in is accepted", () => {
  for (const [label, typed] of PASTES) {
    it(`${label} submits WDJBMJHT`, async () => {
      const material = (await import("../../src/commands/setup.js")).generateSessionMaterial();
      const requests: Array<{ verification_code: string }> = [];

      const io: SetupIO = resolveSetupIO({
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        isTTY: true,
        isOutputTTY: true,
        env: { CI: "1" },
        platform: "linux",
        stdinStream: scriptedStream(typed),
        fetch: (async (_url: string, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as { verification_code: string };
          requests.push(body);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              sealed_key: seal(API_KEY, material.publicKey),
              tenant_name: "Paste Workspace",
            }),
          } as unknown as Response;
        }) as unknown as typeof fetch,
        verify: async () => {},
        generate: () => material,
      });

      const exit = await runSetup({ "base-url": BASE_URL }, io);

      expect(requests.map((r) => r.verification_code)).toEqual(["WDJBMJHT"]);
      expect(exit).toBe(0);
    });
  }
});
