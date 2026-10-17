/**
 * The credential resolver's own gates. Flag/env/stdin precedence, CRLF trimming, the conflict matrix and the
 * non-TTY fail-fast are pinned at the command seam (commands/account-credentials.test.ts); what is here is what only
 * the resolver exposes: the prompt-tier gates and the live-terminal EOF hang.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveSecret, STDIN_TTY_CUE } from "../../src/lib/credential-resolve.js";
import { exitCode } from "../helpers/exit-code.js";

const ENV = "CURVIATE_TEST_SECRET";
afterEach(() => {
  delete process.env[ENV];
});
const out = () => ({ stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });
const base = { envVar: ENV, required: true, failMessage: "no secret" } as const;

describe("resolveSecret", () => {
  it("an empty env value is absent; an optional secret with nothing resolved is undefined with no prompt and no exit", async () => {
    process.env[ENV] = "";
    expect(await exitCode(async () => expect(await resolveSecret({ envVar: ENV, out: out() })).toBeUndefined())).toBeUndefined();
  });

  it("stdin takes precedence over env", async () => {
    process.env[ENV] = "from-env";
    expect(await resolveSecret({ stdinRequested: true, envVar: ENV, readStdin: async () => "from-stdin", out: out() })).toBe("from-stdin");
  });

  it("required on a TTY: the masked readline resolves it; a blank entry fails fast (exit 2) rather than re-prompting", async () => {
    const readline = vi.fn(async () => "PROMPTED");
    const prompt = { isTTY: true, readline, promptText: "Enter: " };
    expect(await resolveSecret({ ...base, allowInteractive: true, prompt, out: out() })).toBe("PROMPTED");
    expect(readline).toHaveBeenCalledWith("Enter: ", { mask: true });
    readline.mockClear().mockResolvedValue("" as never);
    expect(await exitCode(() => resolveSecret({ ...base, allowInteractive: true, prompt, out: out() }))).toBe(2);
    expect(readline).toHaveBeenCalledTimes(1);
  });

  it("allowInteractive=false skips both the prompt and the fail-fast", async () => {
    const readline = vi.fn(async () => "NO");
    expect(await resolveSecret({ ...base, allowInteractive: false, prompt: { isTTY: true, readline, promptText: "x" }, out: out() })).toBeUndefined();
    expect(readline).not.toHaveBeenCalled();
  });

  it("tier 1b has its own gate: allowInteractiveStdinRead=true reads the TTY even when allowInteractive=false; =false suppresses it; omitted follows allowInteractive", async () => {
    const readSingleLine = vi.fn(async () => "STDIN_VALUE");
    const common = { stdinRequested: true, isTTY: true, envVar: ENV, readSingleLine, out: out() };
    expect(await resolveSecret({ ...common, required: true, failMessage: "x", allowInteractive: false, allowInteractiveStdinRead: true })).toBe("STDIN_VALUE");
    readSingleLine.mockClear();
    expect(await resolveSecret({ ...common, allowInteractive: true, allowInteractiveStdinRead: false })).toBeUndefined();
    expect(await resolveSecret({ ...common, allowInteractive: false })).toBeUndefined();
    expect(readSingleLine).not.toHaveBeenCalled();
  });

  it("on a live terminal the single-line reader settles well inside a bound while the EOF reader never would (password, and li_at with no prompt config)", async () => {
    for (const label of ["TTY_PWD", "TTY_LIAT"]) {
      const settled = await Promise.race([
        resolveSecret({ ...base, stdinRequested: true, isTTY: true, readSingleLine: async () => label, readStdin: () => new Promise(() => {}), out: out() }),
        new Promise((r) => setTimeout(() => r("HUNG"), 200)),
      ]);
      expect(settled).toBe(label);
    }
  });

  it("with no reader injected the default one is masked: raw mode on, no echo, the cue written once (not again by the reader)", async () => {
    const stdin = process.stdin as unknown as NodeJS.ReadStream & { setRawMode?: (m: boolean) => void };
    const had = stdin.setRawMode;
    const setRawMode = vi.fn();
    stdin.setRawMode = setRawMode;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const o = out();
      const pending = resolveSecret({ ...base, stdinRequested: true, isTTY: true, out: o });
      await new Promise((r) => setImmediate(r));
      stdin.emit("data", "hunter2\r");
      expect(await pending).toBe("hunter2");
      expect(setRawMode.mock.calls).toEqual([[true], [false]]);
      expect(o.stderr.write.mock.calls.filter(([s]) => s === STDIN_TTY_CUE)).toHaveLength(1);
      expect(stderr.mock.calls.map(([s]) => s)).not.toContain(STDIN_TTY_CUE);
    } finally {
      stderr.mockRestore();
      stdin.setRawMode = had;
    }
  });
});
