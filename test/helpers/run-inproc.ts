/**
 * Run the CLI IN-PROCESS: the same entry point `src/cli.ts` calls
 * (`dispatch(main, argv)`), with `process.exit`, stdout, stderr, stdin and the
 * environment captured. Replaces the spawn-the-built-bin pattern for everything
 * except the one smoke test (`bin-smoke.test.ts`); a spawn is ~0.3 s of node
 * startup per case and bought nothing the entry point does not already do.
 *
 * `process.exit` throws a marker so control flow stops where the real exit
 * would. The FIRST code wins: `dispatch`'s own catch block (and a handler's
 * catch-all) can swallow the marker and exit again, which a real process never
 * gets to do. Lines they echo about the marker are dropped from the streams.
 */

import { Readable } from "node:stream";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { dispatch } from "../../src/dispatch.js";
import { main } from "../../src/main.js";

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface RunOpts {
  /** Env overrides; `undefined` deletes the key. Every CURVIATE_* key starts unset. */
  env?: Record<string, string | undefined>;
  /** Piped to stdin (default: empty, already ended). */
  stdin?: string;
  /** A config home to use; default: a fresh empty one per run. */
  xdg?: string;
}

const MARK = "__curviate_test_exit__";

/** A fresh XDG_CONFIG_HOME, optionally holding a config with one profile. */
export function configHome(profile?: Record<string, unknown>): string {
  const xdg = mkdtempSync(join(tmpdir(), "curviate-t-"));
  if (profile) {
    mkdirSync(join(xdg, "curviate"), { recursive: true });
    writeFileSync(
      join(xdg, "curviate", "config.json"),
      JSON.stringify({ active: "default", profiles: { default: profile } }),
    );
  }
  return xdg;
}

export async function runCli(args: string[], opts: RunOpts = {}): Promise<RunResult> {
  const savedEnv = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith("CURVIATE_")) delete process.env[k];
  process.env["XDG_CONFIG_HOME"] = opts.xdg ?? configHome();
  process.env["NODE_ENV"] = "production";
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  let out = "";
  let err = "";
  let code: number | undefined;
  const sink = (into: (s: string) => void) => (chunk: unknown, enc?: unknown, cb?: unknown) => {
    into(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
    const done = typeof enc === "function" ? enc : cb;
    if (typeof done === "function") (done as () => void)();
    return true;
  };
  const w1 = vi.spyOn(process.stdout, "write").mockImplementation(sink((s) => (out += s)) as never);
  const w2 = vi.spyOn(process.stderr, "write").mockImplementation(sink((s) => (err += s)) as never);
  const ex = vi.spyOn(process, "exit").mockImplementation(((c?: number | string | null) => {
    code ??= Number(c ?? 0);
    throw new Error(MARK + code);
  }) as never);
  const stdinDesc = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", {
    value: Readable.from(opts.stdin ? [Buffer.from(opts.stdin)] : []),
    configurable: true,
  });

  try {
    await dispatch(main, args);
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith(MARK))) throw e;
  } finally {
    w1.mockRestore();
    w2.mockRestore();
    ex.mockRestore();
    if (stdinDesc) Object.defineProperty(process, "stdin", stdinDesc);
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
  }
  const clean = (s: string) =>
    s
      .split("\n")
      .filter((l) => !l.includes(MARK))
      .join("\n");
  return { status: code ?? 0, stdout: clean(out), stderr: clean(err) };
}
