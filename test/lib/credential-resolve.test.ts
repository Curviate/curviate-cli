/**
 * The credential resolver's own gates. Flag/env/stdin precedence, CRLF trimming, the conflict matrix and the
 * non-TTY fail-fast are pinned at the command seam (commands/account-credentials.test.ts); what is here is what only
 * the resolver exposes: the prompt-tier gates and the live-terminal EOF hang.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveSecret, checkCredentialConflicts, STDIN_TTY_CUE, type CredentialConflictFlags } from "../../src/lib/credential-resolve.js";
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

describe("checkCredentialConflicts: the five conflicts, each alone", () => {
  // Each row sets only the flags that trigger ITS rule (auth-method omitted where another rule would fire first), so the
  // message names the rule that fired and a removed check cannot hide behind a neighbour.
  it.each<[string, CredentialConflictFlags, RegExp]>([
    ["--password + --password-stdin", { password: "x", "password-stdin": true }, /--password and --password-stdin cannot both/],
    ["--li-at + --li-at-stdin", { "li-at": "x", "li-at-stdin": true }, /--li-at and --li-at-stdin cannot both/],
    ["--password-stdin + --li-at-stdin", { "password-stdin": true, "li-at-stdin": true }, /stdin can feed only one secret/],
    ["--li-at-stdin with --auth-method credentials", { "li-at-stdin": true, "auth-method": "credentials" }, /--li-at-stdin requires --auth-method cookie/],
    ["--password-stdin with --auth-method cookie", { "password-stdin": true, "auth-method": "cookie" }, /--password-stdin requires --auth-method credentials/],
  ])("%s: exit 2 naming the rule", async (_l, flags, message) => {
    const o = out();
    expect(await exitCode(() => checkCredentialConflicts(flags, o))).toBe(2);
    expect(o.stderr.write.mock.calls.map(([m]) => m).join("")).toMatch(message);
  });

  it.each<[string, CredentialConflictFlags]>([
    ["a value flag with its own method", { password: "x", "auth-method": "credentials" }],
    ["--li-at-stdin with cookie", { "li-at-stdin": true, "auth-method": "cookie" }],
    ["--password-stdin with credentials", { "password-stdin": true, "auth-method": "credentials" }],
    ["nothing at all", {}],
  ])("control, no conflict: %s does not exit", async (_l, flags) => {
    const o = out();
    expect(await exitCode(() => checkCredentialConflicts(flags, o))).toBeUndefined();
    expect(o.stderr.write).not.toHaveBeenCalled();
  });
});
