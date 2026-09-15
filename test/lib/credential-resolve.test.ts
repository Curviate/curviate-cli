/**
 * Unit tests for the LinkedIn-account credential resolver: precedence
 * (flag > stdin > env > prompt > fail-fast) and the stdin/flag conflict matrix.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  resolveSecret,
  checkCredentialConflicts,
  type CredentialConflictFlags,
} from "../../src/lib/credential-resolve.js";

function makeOut() {
  return { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
}

function mockExit() {
  return vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new Error(`process.exit(${code})`);
  });
}

// ---------------------------------------------------------------------------
// resolveSecret — tiered precedence
// ---------------------------------------------------------------------------

describe("resolveSecret — flag/env precedence", () => {
  const ENV = "CURVIATE_TEST_SECRET_PRECEDENCE";
  afterEach(() => {
    delete process.env[ENV];
  });

  it("flag beats env", async () => {
    process.env[ENV] = "from-env";
    const value = await resolveSecret({ flagValue: "from-flag", envVar: ENV, out: makeOut() });
    expect(value).toBe("from-flag");
  });

  it("env used when no flag", async () => {
    process.env[ENV] = "from-env";
    const value = await resolveSecret({ envVar: ENV, out: makeOut() });
    expect(value).toBe("from-env");
  });

  it("an explicitly empty flag value falls through to env (never sends an empty secret)", async () => {
    process.env[ENV] = "from-env";
    const value = await resolveSecret({ flagValue: "", envVar: ENV, out: makeOut() });
    expect(value).toBe("from-env");
  });

  it("an explicitly empty env value is treated as absent", async () => {
    process.env[ENV] = "";
    const value = await resolveSecret({ envVar: ENV, out: makeOut() });
    expect(value).toBeUndefined();
  });

  it("optional secret (required not set) with nothing resolved returns undefined, no prompt, no exit", async () => {
    const exitSpy = mockExit();
    try {
      const value = await resolveSecret({ envVar: ENV, out: makeOut() });
      expect(value).toBeUndefined();
    } finally {
      exitSpy.mockRestore();
    }
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("resolveSecret — stdin", () => {
  const ENV = "CURVIATE_TEST_SECRET_STDIN";
  afterEach(() => {
    delete process.env[ENV];
  });

  it("reads the injected stdin reader when stdinRequested, trimming a trailing newline", async () => {
    const value = await resolveSecret({
      stdinRequested: true,
      envVar: ENV,
      readStdin: async () => "secret-value\n",
      out: makeOut(),
    });
    expect(value).toBe("secret-value");
  });

  it("trims a CRLF-terminated pipe (a bare \\n-strip alone would leave a trailing \\r)", async () => {
    const value = await resolveSecret({
      stdinRequested: true,
      envVar: ENV,
      readStdin: async () => "secret-value\r\n",
      out: makeOut(),
    });
    expect(value).toBe("secret-value");
    expect(value).not.toContain("\r");
  });

  it("stdin takes precedence over env", async () => {
    process.env[ENV] = "from-env";
    const value = await resolveSecret({
      stdinRequested: true,
      envVar: ENV,
      readStdin: async () => "from-stdin",
      out: makeOut(),
    });
    expect(value).toBe("from-stdin");
  });
});

describe("resolveSecret — required: masked prompt + non-TTY fail-fast", () => {
  const ENV = "CURVIATE_TEST_SECRET_REQUIRED";
  afterEach(() => {
    delete process.env[ENV];
  });

  it("TTY: resolves via the injected masked readline", async () => {
    const readline = vi.fn(async () => "PROMPTED");
    const value = await resolveSecret({
      envVar: ENV,
      required: true,
      allowInteractive: true,
      failMessage: "no secret",
      prompt: { isTTY: true, readline, promptText: "Enter: " },
      out: makeOut(),
    });
    expect(value).toBe("PROMPTED");
    expect(readline).toHaveBeenCalledWith("Enter: ", { mask: true });
  });

  it("a blank prompt entry falls through to fail-fast (exit 2), not a re-prompt loop", async () => {
    const readline = vi.fn(async () => "");
    const exitSpy = mockExit();
    try {
      await expect(
        resolveSecret({
          envVar: ENV,
          required: true,
          allowInteractive: true,
          failMessage: "no secret",
          prompt: { isTTY: true, readline, promptText: "Enter: " },
          out: makeOut(),
        }),
      ).rejects.toThrow("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(readline).toHaveBeenCalledTimes(1);
  });

  it("non-TTY, no source: fails fast (exit 2) and never invokes the stdin reader (no hang)", async () => {
    const readStdin = vi.fn(async () => "SHOULD_NOT_BE_READ");
    const out = makeOut();
    const exitSpy = mockExit();
    try {
      await expect(
        resolveSecret({
          envVar: ENV,
          required: true,
          allowInteractive: true,
          failMessage: "no password — pass --password, --password-stdin, or set X",
          prompt: { isTTY: false, readline: vi.fn(), promptText: "Enter: " },
          readStdin,
          out,
        }),
      ).rejects.toThrow("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(readStdin).not.toHaveBeenCalled();
    const written = out.stderr.write.mock.calls.map((c) => c[0] as string).join("");
    expect(written).toContain("password");
  });

  it("required + no prompt option at all (e.g. li_at) fails fast on TTY too (no cookie prompt, by design)", async () => {
    const out = makeOut();
    const exitSpy = mockExit();
    try {
      await expect(
        resolveSecret({
          envVar: ENV,
          required: true,
          allowInteractive: true,
          failMessage: "no li_at — pass --li-at, --li-at-stdin, or set X",
          out,
        }),
      ).rejects.toThrow("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    const written = out.stderr.write.mock.calls.map((c) => c[0] as string).join("");
    expect(written).toContain("li_at");
  });

  it("allowInteractive=false skips both prompt and fail-fast, returning undefined", async () => {
    const readline = vi.fn(async () => "SHOULD_NOT_PROMPT");
    const exitSpy = mockExit();
    let value: string | undefined;
    try {
      value = await resolveSecret({
        envVar: ENV,
        required: true,
        allowInteractive: false,
        failMessage: "no secret",
        prompt: { isTTY: true, readline, promptText: "Enter: " },
        out: makeOut(),
      });
    } finally {
      exitSpy.mockRestore();
    }
    expect(value).toBeUndefined();
    expect(readline).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // allowInteractiveStdinRead — tier-1b's own gate, decoupled from
  // allowInteractive (which continues to gate tiers 3/4 only).
  // -------------------------------------------------------------------------

  it("allowInteractiveStdinRead=true still consults the TTY stdin reader even when allowInteractive=false (e.g. credentials with no --email yet)", async () => {
    const readSingleLine = vi.fn(async () => "STDIN_VALUE");
    const readline = vi.fn(async () => "SHOULD_NOT_BE_CALLED");
    const value = await resolveSecret({
      stdinRequested: true,
      isTTY: true,
      envVar: ENV,
      readSingleLine,
      required: true,
      // Tier 3/4 suppressed (mirrors "credentials, no --email yet")...
      allowInteractive: false,
      // ...but tier-1b's own gate is independently true.
      allowInteractiveStdinRead: true,
      failMessage: "no secret",
      prompt: { isTTY: true, readline, promptText: "Enter: " },
      out: makeOut(),
    });
    expect(value).toBe("STDIN_VALUE");
    expect(readSingleLine).toHaveBeenCalledTimes(1);
    expect(readline).not.toHaveBeenCalled();
  });

  it("allowInteractiveStdinRead=false suppresses the TTY stdin reader even when allowInteractive=true (--preview)", async () => {
    const readSingleLine = vi.fn(async () => "SHOULD_NOT_BE_CALLED");
    const value = await resolveSecret({
      stdinRequested: true,
      isTTY: true,
      envVar: ENV,
      readSingleLine,
      required: false,
      allowInteractive: true,
      allowInteractiveStdinRead: false,
      out: makeOut(),
    });
    expect(value).toBeUndefined();
    expect(readSingleLine).not.toHaveBeenCalled();
  });

  it("allowInteractiveStdinRead omitted defaults to allowInteractive (no divergence for callers that don't need it, e.g. li_at)", async () => {
    const readSingleLine = vi.fn(async () => "SHOULD_NOT_BE_CALLED");
    const value = await resolveSecret({
      stdinRequested: true,
      isTTY: true,
      envVar: ENV,
      readSingleLine,
      required: false,
      allowInteractive: false,
      // allowInteractiveStdinRead intentionally omitted.
      out: makeOut(),
    });
    expect(value).toBeUndefined();
    expect(readSingleLine).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resolveSecret — TTY-mode stdin: single line, no EOF wait (regression anchor)
//
// The hang this guards against: on a live terminal, `--password-stdin` used
// to always await the injected `readStdin` to EOF — but a real terminal
// never sends EOF on Enter (only on Ctrl-D), so the read never returned. The
// fix routes an interactive-TTY stdin read through a DEDICATED single-line
// reader seam instead, which resolves on the first line.
//
// Modeled honestly against the actual seam shape: `readStdin` is a plain
// `() => Promise<string>` with no stream/events to fire — so the hang is
// modeled as a promise that never settles, not a fake stream. Both cases
// race the resolveSecret() call against a short timer and assert the
// resolution wins — i.e. the call must settle well inside the bound instead
// of hanging on the never-resolving `readStdin`.
// ---------------------------------------------------------------------------

/** Race a promise against a short timer; reports which one settled first. */
function raceAgainstTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ settled: true; value: T } | { settled: false }> {
  return Promise.race([
    promise.then((value) => ({ settled: true as const, value })),
    new Promise<{ settled: false }>((resolve) => setTimeout(() => resolve({ settled: false }), ms)),
  ]);
}

describe("resolveSecret — TTY-mode stdin (single line, no EOF wait)", () => {
  const ENV = "CURVIATE_TEST_SECRET_TTY_STDIN";
  afterEach(() => {
    delete process.env[ENV];
  });

  it("password: on an interactive TTY the call resolves via the single-line reader well inside a short bound, never waiting on the EOF reader", async () => {
    const readSingleLine = vi.fn(async () => "TTY_PWD");
    const outcome = await raceAgainstTimeout(
      resolveSecret({
        stdinRequested: true,
        envVar: ENV,
        isTTY: true,
        readSingleLine,
        // Models the live-terminal EOF hang honestly: a promise that never
        // settles, against the real `readStdin` seam shape (no stream to
        // emit events on).
        readStdin: () => new Promise(() => {}),
        required: true,
        failMessage: "no secret",
        out: makeOut(),
      }),
      200,
    );
    expect(outcome).toEqual({ settled: true, value: "TTY_PWD" });
    expect(readSingleLine).toHaveBeenCalledTimes(1);
  });

  it("li_at: same TTY behavior with NO prompt config supplied at all — the top-level TTY signal alone routes to the single-line reader, independent of the password-only masked-prompt fallback", async () => {
    const readSingleLine = vi.fn(async () => "TTY_LIAT");
    const outcome = await raceAgainstTimeout(
      resolveSecret({
        stdinRequested: true,
        envVar: ENV,
        isTTY: true,
        readSingleLine,
        readStdin: () => new Promise(() => {}),
        required: true,
        failMessage: "no li_at",
        out: makeOut(),
        // Deliberately no `prompt` — li_at never gets a masked-fallback
        // prompt tier, by design.
      }),
      200,
    );
    expect(outcome).toEqual({ settled: true, value: "TTY_LIAT" });
    expect(readSingleLine).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// checkCredentialConflicts — the 5-way conflict matrix
// ---------------------------------------------------------------------------

describe("checkCredentialConflicts", () => {
  function expectConflictExit(flags: CredentialConflictFlags) {
    const exitSpy = mockExit();
    try {
      expect(() => checkCredentialConflicts(flags, makeOut())).toThrow("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  }

  it("--password + --password-stdin -> exit 2", () => {
    expectConflictExit({ password: "x", "password-stdin": true, "auth-method": "credentials" });
  });

  it("--li-at + --li-at-stdin -> exit 2", () => {
    expectConflictExit({ "li-at": "x", "li-at-stdin": true, "auth-method": "cookie" });
  });

  it("--password-stdin + --li-at-stdin together -> exit 2", () => {
    expectConflictExit({ "password-stdin": true, "li-at-stdin": true, "auth-method": "credentials" });
  });

  it("--li-at-stdin with --auth-method credentials (mismatch) -> exit 2", () => {
    expectConflictExit({ "li-at-stdin": true, "auth-method": "credentials" });
  });

  it("--password-stdin with --auth-method cookie (mismatch) -> exit 2", () => {
    expectConflictExit({ "password-stdin": true, "auth-method": "cookie" });
  });

  it("no conflict: does not exit", () => {
    const exitSpy = mockExit();
    try {
      expect(() => checkCredentialConflicts({ password: "x", "auth-method": "credentials" }, makeOut())).not.toThrow();
    } finally {
      exitSpy.mockRestore();
    }
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
