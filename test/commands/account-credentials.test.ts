/**
 * LinkedIn-account credential-input safety: env-var fallbacks, the
 * `--*-stdin` flags, the stdin/flag conflict matrix, the masked TTY prompt +
 * non-TTY fail-fast, the `ps`/shell-history warnings on the value flags, and
 * the invariant that a resolved secret reaches only the SDK request body
 * (never stdout/stderr/`--json`/`--preview`/error output).
 *
 * Covers `account link`, `account update`.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { Mock } from "vitest";

function makeClient() {
  return {
    accounts: {
      update: vi.fn(),
    },
    auth: {
      intent: vi.fn(),
    },
  };
}

function makeOut() {
  return { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };
}

function mockExit() {
  return vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new Error(`process.exit(${code})`);
  });
}

const ENV_PASSWORD = "CURVIATE_LINKEDIN_PASSWORD";
const ENV_LI_AT = "CURVIATE_LINKEDIN_LI_AT";
const ENV_LI_A = "CURVIATE_LINKEDIN_LI_A";
const ENV_PROXY_PW = "CURVIATE_PROXY_PASSWORD";

function clearSecretEnv() {
  delete process.env[ENV_PASSWORD];
  delete process.env[ENV_LI_AT];
  delete process.env[ENV_LI_A];
  delete process.env[ENV_PROXY_PW];
}

// ---------------------------------------------------------------------------
// env-var precedence (flag > env), optional flag>env>omitted
// ---------------------------------------------------------------------------

describe("account credentials — env-var precedence", () => {
  afterEach(clearSecretEnv);

  it("password: flag beats env", async () => {
    process.env[ENV_PASSWORD] = "FROM_ENV";
    const { runAccountLink } = await import("../../src/commands/account.js");
    const client = makeClient();
    (client.auth.intent as Mock).mockResolvedValue({ object: "account", account_id: "acc_1" });
    const out = makeOut();
    await runAccountLink(
      client as never,
      { "seat-id": "seat_1", "auth-method": "credentials", country: "US", email: "a@b.c", password: "FROM_FLAG", json: true } as never,
      out,
    );
    expect(client.auth.intent).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: { email: "a@b.c", password: "FROM_FLAG" } }),
    );
  });

  it("password: env used when no flag", async () => {
    process.env[ENV_PASSWORD] = "FROM_ENV";
    const { runAccountLink } = await import("../../src/commands/account.js");
    const client = makeClient();
    (client.auth.intent as Mock).mockResolvedValue({ object: "account", account_id: "acc_1" });
    const out = makeOut();
    await runAccountLink(
      client as never,
      { "seat-id": "seat_1", "auth-method": "credentials", country: "US", email: "a@b.c", json: true } as never,
      out,
    );
    expect(client.auth.intent).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: { email: "a@b.c", password: "FROM_ENV" } }),
    );
  });

  it("password: an explicitly empty flag falls through to env, never sends an empty secret", async () => {
    process.env[ENV_PASSWORD] = "ENV_FALLBACK";
    const { runAccountLink } = await import("../../src/commands/account.js");
    const client = makeClient();
    (client.auth.intent as Mock).mockResolvedValue({ object: "account" });
    const out = makeOut();
    await runAccountLink(
      client as never,
      { "seat-id": "seat_1", "auth-method": "credentials", country: "US", email: "a@b.c", password: "", json: true } as never,
      out,
    );
    expect(client.auth.intent).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: { email: "a@b.c", password: "ENV_FALLBACK" } }),
    );
  });

  it("li_a (optional): flag > env > omitted — flag wins when both set", async () => {
    process.env[ENV_LI_A] = "ENV_LIA";
    const { runAccountLink } = await import("../../src/commands/account.js");
    const client = makeClient();
    (client.auth.intent as Mock).mockResolvedValue({ object: "account" });
    const out = makeOut();
    await runAccountLink(
      client as never,
      { "seat-id": "seat_1", "auth-method": "cookie", country: "US", "user-agent": "UA", "li-at": "AT", "li-a": "FLAG_LIA", json: true } as never,
      out,
    );
    expect(client.auth.intent).toHaveBeenCalledWith(
      expect.objectContaining({ cookie: { li_at: "AT", li_a: "FLAG_LIA" } }),
    );
  });

  it("li_a (optional): omitted entirely (not an empty field) when neither flag nor env set", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const client = makeClient();
    (client.auth.intent as Mock).mockResolvedValue({ object: "account" });
    const out = makeOut();
    await runAccountLink(
      client as never,
      { "seat-id": "seat_1", "auth-method": "cookie", country: "US", "user-agent": "UA", "li-at": "AT", json: true } as never,
      out,
    );
    const body = (client.auth.intent as Mock).mock.calls[0]?.[0] as { cookie: Record<string, unknown> };
    expect(body.cookie).toEqual({ li_at: "AT" });
    expect(body.cookie).not.toHaveProperty("li_a");
  });

  it("proxy password (optional): flag > env > omitted, on account update", async () => {
    process.env[ENV_PROXY_PW] = "ENV_PROXY";
    const { runAccountUpdate } = await import("../../src/commands/account.js");
    const client = makeClient();
    (client.accounts.update as Mock).mockResolvedValue({ object: "account" });
    const out = makeOut();
    await runAccountUpdate(
      client as never,
      { "account-id": "acc_1", "proxy-host": "proxy.example.com", json: true } as never,
      out,
    );
    expect(client.accounts.update).toHaveBeenCalledWith(
      "acc_1",
      expect.objectContaining({ proxy: expect.objectContaining({ password: "ENV_PROXY" }) }),
    );
  });

  it("proxy password (optional): omitted entirely when neither flag nor env set", async () => {
    const { runAccountUpdate } = await import("../../src/commands/account.js");
    const client = makeClient();
    (client.accounts.update as Mock).mockResolvedValue({ object: "account" });
    const out = makeOut();
    await runAccountUpdate(
      client as never,
      { "account-id": "acc_1", "proxy-host": "proxy.example.com", json: true } as never,
      out,
    );
    const body = (client.accounts.update as Mock).mock.calls[0]?.[1] as { proxy: Record<string, unknown> };
    expect(body.proxy).not.toHaveProperty("password");
  });
});

// ---------------------------------------------------------------------------
// stdin secrets, off argv, CRLF trimmed
// ---------------------------------------------------------------------------

describe("account credentials — --password-stdin / --li-at-stdin", () => {
  it("--password-stdin resolves the piped secret and trims a trailing newline", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const client = makeClient();
    (client.auth.intent as Mock).mockResolvedValue({ object: "account" });
    const out = makeOut();
    const flags = { "seat-id": "seat_1", "auth-method": "credentials", country: "US", email: "a@b.c", "password-stdin": true, json: true };
    await runAccountLink(client as never, flags as never, out, { readStdin: async () => "PWD_S\n" });
    expect(client.auth.intent).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: { email: "a@b.c", password: "PWD_S" } }),
    );
    // The secret itself never lands anywhere in the parsed flags (the argv-equivalent) — only the trigger boolean does.
    expect(JSON.stringify(flags)).not.toContain("PWD_S");
  });

  it("--password-stdin trims a CRLF-terminated pipe (not just a bare trailing \\n)", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const client = makeClient();
    (client.auth.intent as Mock).mockResolvedValue({ object: "account" });
    const out = makeOut();
    await runAccountLink(
      client as never,
      { "seat-id": "seat_1", "auth-method": "credentials", country: "US", email: "a@b.c", "password-stdin": true, json: true } as never,
      out,
      { readStdin: async () => "PWD_S\r\n" },
    );
    const body = (client.auth.intent as Mock).mock.calls[0]?.[0] as { credentials: { password: string } };
    expect(body.credentials.password).toBe("PWD_S");
    expect(body.credentials.password).not.toContain("\r");
  });

  it("--li-at-stdin resolves the piped cookie", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const client = makeClient();
    (client.auth.intent as Mock).mockResolvedValue({ object: "account" });
    const out = makeOut();
    await runAccountLink(
      client as never,
      { "seat-id": "seat_1", "auth-method": "cookie", country: "US", "user-agent": "UA", "li-at-stdin": true, json: true } as never,
      out,
      { readStdin: async () => "LIAT_S\n" },
    );
    expect(client.auth.intent).toHaveBeenCalledWith(expect.objectContaining({ cookie: { li_at: "LIAT_S" } }));
  });
});

// ---------------------------------------------------------------------------
// conflict matrix -> exit 2, no SDK call
// ---------------------------------------------------------------------------

describe("account credentials — conflict matrix (exit 2, zero SDK calls)", () => {
  const combos: Array<{ name: string; flags: Record<string, unknown> }> = [
    { name: "--password + --password-stdin", flags: { password: "x", "password-stdin": true, "auth-method": "credentials", country: "US", email: "a@b.c" } },
    { name: "--li-at + --li-at-stdin", flags: { "li-at": "x", "li-at-stdin": true, "auth-method": "cookie" } },
    { name: "--password-stdin + --li-at-stdin", flags: { "password-stdin": true, "li-at-stdin": true, "auth-method": "credentials", country: "US", email: "a@b.c" } },
    { name: "--li-at-stdin with --auth-method credentials", flags: { "li-at-stdin": true, "auth-method": "credentials", country: "US", email: "a@b.c" } },
    { name: "--password-stdin with --auth-method cookie", flags: { "password-stdin": true, "auth-method": "cookie" } },
  ];

  for (const combo of combos) {
    it(`${combo.name} -> exit 2, auth.intent never called`, async () => {
      const { runAccountLink } = await import("../../src/commands/account.js");
      const client = makeClient();
      const out = makeOut();
      const exitSpy = mockExit();
      try {
        await expect(
          runAccountLink(client as never, { "seat-id": "seat_1", ...combo.flags } as never, out),
        ).rejects.toThrow("process.exit(2)");
      } finally {
        exitSpy.mockRestore();
      }
      expect(client.auth.intent).not.toHaveBeenCalled();
    });
  }
});

// ---------------------------------------------------------------------------
// masked TTY prompt, non-TTY fail-fast, cookie has no prompt
// ---------------------------------------------------------------------------

describe("account credentials — masked TTY prompt + non-TTY fail-fast", () => {
  it("TTY: masked prompt resolves the password; stderr never echoes it", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const client = makeClient();
    (client.auth.intent as Mock).mockResolvedValue({ object: "account" });
    const out = makeOut();
    await runAccountLink(
      client as never,
      { "seat-id": "seat_1", "auth-method": "credentials", country: "US", email: "a@b.c", json: true } as never,
      out,
      { isTTY: true, readline: async () => "PROMPTED" },
    );
    expect(client.auth.intent).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: { email: "a@b.c", password: "PROMPTED" } }),
    );
    const stderrOut = out.stderr.write.mock.calls.map((c) => c[0] as string).join("");
    expect(stderrOut).not.toContain("PROMPTED");
  });

  it("non-TTY, no --password-stdin: exit 2, message names password, never reads stdin (no hang)", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const client = makeClient();
    const out = makeOut();
    const readStdin = vi.fn(async () => "SHOULD_NOT_READ");
    const exitSpy = mockExit();
    try {
      await expect(
        runAccountLink(
          client as never,
          { "seat-id": "seat_1", "auth-method": "credentials", country: "US", email: "a@b.c", json: true } as never,
          out,
          { isTTY: false, readStdin },
        ),
      ).rejects.toThrow("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    expect(client.auth.intent).not.toHaveBeenCalled();
    expect(readStdin).not.toHaveBeenCalled();
    const stderrOut = out.stderr.write.mock.calls.map((c) => c[0] as string).join("");
    expect(stderrOut).toContain("password");
  });

  it("cookie method, no li_at source: exit 2 on TTY too (no cookie prompt, by design)", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const client = makeClient();
    const out = makeOut();
    const exitSpy = mockExit();
    try {
      await expect(
        runAccountLink(
          client as never,
          { "seat-id": "seat_1", "auth-method": "cookie", country: "US", "user-agent": "UA", json: true } as never,
          out,
          { isTTY: true },
        ),
      ).rejects.toThrow("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    const stderrOut = out.stderr.write.mock.calls.map((c) => c[0] as string).join("");
    expect(stderrOut).toContain("li_at");
  });

  it("cookie method, no li_at source: exit 2 on non-TTY too", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const client = makeClient();
    const out = makeOut();
    const exitSpy = mockExit();
    try {
      await expect(
        runAccountLink(
          client as never,
          { "seat-id": "seat_1", "auth-method": "cookie", country: "US", "user-agent": "UA", json: true } as never,
          out,
          { isTTY: false },
        ),
      ).rejects.toThrow("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
    const stderrOut = out.stderr.write.mock.calls.map((c) => c[0] as string).join("");
    expect(stderrOut).toContain("li_at");
  });
});

// ---------------------------------------------------------------------------
// --preview must never prompt / never fail-fast (qa amendment 7)
// ---------------------------------------------------------------------------

describe("account credentials — --preview skips prompt/fail-fast entirely", () => {
  it("--preview, credentials method, no password source, non-TTY: renders preview, does not exit", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const client = makeClient();
    const out = makeOut();
    const exitSpy = mockExit();
    try {
      await runAccountLink(
        client as never,
        { "seat-id": "seat_1", "auth-method": "credentials", country: "US", email: "a@b.c", preview: true } as never,
        out,
        { isTTY: false },
      );
    } finally {
      exitSpy.mockRestore();
    }
    expect(exitSpy).not.toHaveBeenCalled();
    expect(client.auth.intent).not.toHaveBeenCalled();
    const written = out.stdout.write.mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(written) as { body: { credentials: Record<string, unknown> } };
    expect(parsed.body.credentials).toEqual({ email: "a@b.c" });
  });

  it("--preview, cookie method, no li_at source: renders preview, does not exit", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const client = makeClient();
    const out = makeOut();
    const exitSpy = mockExit();
    try {
      await runAccountLink(
        client as never,
        { "seat-id": "seat_1", "auth-method": "cookie", country: "US", preview: true } as never,
        out,
        { isTTY: false },
      );
    } finally {
      exitSpy.mockRestore();
    }
    expect(exitSpy).not.toHaveBeenCalled();
    expect(client.auth.intent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ps/shell-history warnings
// ---------------------------------------------------------------------------

describe("account credentials — ps/shell-history warnings on secret value flags", () => {
  type ArgDef = { description?: string };
  type SubCmd = { args?: Record<string, ArgDef> };

  async function loadArgs(command: string): Promise<Record<string, ArgDef>> {
    const { accountCommand } = await import("../../src/commands/account.js");
    const subCmds = (accountCommand as unknown as { subCommands: Record<string, SubCmd> }).subCommands;
    return subCmds[command]?.args ?? {};
  }

  it("link --help: --password/--li-at/--li-a/--proxy-password each warn and name their alternative; -stdin flags do not warn", async () => {
    const args = await loadArgs("link");
    expect(args["password"]?.description).toMatch(/ps|shell history/i);
    expect(args["password"]?.description).toContain("CURVIATE_LINKEDIN_PASSWORD");
    expect(args["li-at"]?.description).toMatch(/ps|shell history/i);
    expect(args["li-at"]?.description).toContain("CURVIATE_LINKEDIN_LI_AT");
    expect(args["li-a"]?.description).toMatch(/ps|shell history/i);
    expect(args["li-a"]?.description).toContain("CURVIATE_LINKEDIN_LI_A");
    expect(args["proxy-password"]?.description).toMatch(/ps|shell history/i);
    expect(args["proxy-password"]?.description).toContain("CURVIATE_PROXY_PASSWORD");

    expect(args["password-stdin"]?.description).not.toMatch(/ps|shell history/i);
    expect(args["li-at-stdin"]?.description).not.toMatch(/ps|shell history/i);
  });

  it("update --help: only --proxy-password warns; update has no --password/--li-at flags at all", async () => {
    const args = await loadArgs("update");
    expect(args["proxy-password"]?.description).toMatch(/ps|shell history/i);
    expect(args["proxy-password"]?.description).toContain("CURVIATE_PROXY_PASSWORD");
    expect(args).not.toHaveProperty("password");
    expect(args).not.toHaveProperty("li-at");
  });
});

// ---------------------------------------------------------------------------
// TTY-mode stdin: single line, no EOF wait, no echo (regression anchor)
//
// The bug: on a live terminal, --password-stdin/--li-at-stdin always read
// to EOF — which a real terminal never sends on Enter (only Ctrl-D) — so
// the command hung after a paste. It also risked echoing the pasted text.
// The fix reads one line (paste + Enter resolves immediately) through a
// masked, no-echo reader whenever stdin is an interactive TTY, leaving the
// piped/redirected (non-TTY) path and the env-var path untouched.
// ---------------------------------------------------------------------------

describe("account credentials — TTY-mode stdin (paste + Enter, no EOF wait, no echo)", () => {
  it("password: --password-stdin on a TTY resolves the typed value; stderr shows the cue, never the secret", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const client = makeClient();
    (client.auth.intent as Mock).mockResolvedValue({ object: "account" });
    const out = makeOut();
    const readSingleLine = vi.fn(async () => "TTY_PWD");
    await runAccountLink(
      client as never,
      { "seat-id": "seat_1", "auth-method": "credentials", country: "US", email: "a@b.c", "password-stdin": true, json: true } as never,
      out,
      { isTTY: true, readSingleLine },
    );
    expect(client.auth.intent).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: { email: "a@b.c", password: "TTY_PWD" } }),
    );
    expect(readSingleLine).toHaveBeenCalledTimes(1);
    const stderrOut = out.stderr.write.mock.calls.map((c) => c[0] as string).join("");
    expect(stderrOut).not.toContain("TTY_PWD");
    expect(stderrOut).toMatch(/paste/i);
  });

  it("li_at: --li-at-stdin on a TTY resolves the typed value; stderr shows the cue, never the secret", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const client = makeClient();
    (client.auth.intent as Mock).mockResolvedValue({ object: "account" });
    const out = makeOut();
    const readSingleLine = vi.fn(async () => "TTY_LIAT");
    await runAccountLink(
      client as never,
      { "seat-id": "seat_1", "auth-method": "cookie", country: "US", "user-agent": "UA", "li-at-stdin": true, json: true } as never,
      out,
      { isTTY: true, readSingleLine },
    );
    expect(client.auth.intent).toHaveBeenCalledWith(expect.objectContaining({ cookie: { li_at: "TTY_LIAT" } }));
    expect(readSingleLine).toHaveBeenCalledTimes(1);
    const stderrOut = out.stderr.write.mock.calls.map((c) => c[0] as string).join("");
    expect(stderrOut).not.toContain("TTY_LIAT");
    expect(stderrOut).toMatch(/paste/i);
  });

  it("guard: piped (non-TTY) --password-stdin is unaffected — still reads to EOF, never touches the single-line reader", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const client = makeClient();
    (client.auth.intent as Mock).mockResolvedValue({ object: "account" });
    const out = makeOut();
    const readSingleLine = vi.fn(async () => "SHOULD_NOT_BE_CALLED");
    await runAccountLink(
      client as never,
      { "seat-id": "seat_1", "auth-method": "credentials", country: "US", email: "a@b.c", "password-stdin": true, json: true } as never,
      out,
      { readStdin: async () => "PIPED_PW\n", readSingleLine }, // isTTY omitted -> defaults non-TTY
    );
    expect(client.auth.intent).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: { email: "a@b.c", password: "PIPED_PW" } }),
    );
    expect(readSingleLine).not.toHaveBeenCalled();
  });

  it("guard: env path is unaffected — no stdin flag passed at all, no TTY reader/prompt/stdin stub consulted", async () => {
    process.env[ENV_PASSWORD] = "envpw";
    try {
      const { runAccountLink } = await import("../../src/commands/account.js");
      const client = makeClient();
      (client.auth.intent as Mock).mockResolvedValue({ object: "account" });
      const out = makeOut();
      const readSingleLine = vi.fn(async () => "SHOULD_NOT_BE_CALLED");
      const readline = vi.fn(async () => "SHOULD_NOT_BE_CALLED");
      const readStdin = vi.fn(async () => "SHOULD_NOT_BE_CALLED");
      await runAccountLink(
        client as never,
        { "seat-id": "seat_1", "auth-method": "credentials", country: "US", email: "a@b.c", json: true } as never,
        out,
        { isTTY: true, readSingleLine, readline, readStdin },
      );
      expect(client.auth.intent).toHaveBeenCalledWith(
        expect.objectContaining({ credentials: { email: "a@b.c", password: "envpw" } }),
      );
      expect(readSingleLine).not.toHaveBeenCalled();
      expect(readline).not.toHaveBeenCalled();
      expect(readStdin).not.toHaveBeenCalled();
    } finally {
      delete process.env[ENV_PASSWORD];
    }
  });

  describe("empty TTY line falls through the full precedence order (env, then prompt/fail-fast) — not a shortcut to the prompt", () => {
    afterEach(clearSecretEnv);

    it("password: empty line, no env set -> falls to the masked-prompt tier (not straight to fail-fast, not a silently-empty secret)", async () => {
      const { runAccountLink } = await import("../../src/commands/account.js");
      const client = makeClient();
      (client.auth.intent as Mock).mockResolvedValue({ object: "account" });
      const out = makeOut();
      const readSingleLine = vi.fn(async () => "");
      const readline = vi.fn(async () => "PROMPTED_AFTER_EMPTY_LINE");
      await runAccountLink(
        client as never,
        { "seat-id": "seat_1", "auth-method": "credentials", country: "US", email: "a@b.c", "password-stdin": true, json: true } as never,
        out,
        { isTTY: true, readSingleLine, readline },
      );
      expect(readSingleLine).toHaveBeenCalledTimes(1);
      expect(readline).toHaveBeenCalledTimes(1);
      expect(client.auth.intent).toHaveBeenCalledWith(
        expect.objectContaining({ credentials: { email: "a@b.c", password: "PROMPTED_AFTER_EMPTY_LINE" } }),
      );
    });

    it("li_at: empty line, no env set -> exits 2 immediately (no prompt tier for li_at)", async () => {
      const { runAccountLink } = await import("../../src/commands/account.js");
      const client = makeClient();
      const out = makeOut();
      const readSingleLine = vi.fn(async () => "");
      const exitSpy = mockExit();
      try {
        await expect(
          runAccountLink(
            client as never,
            { "seat-id": "seat_1", "auth-method": "cookie", country: "US", "user-agent": "UA", "li-at-stdin": true, json: true } as never,
            out,
            { isTTY: true, readSingleLine },
          ),
        ).rejects.toThrow("process.exit(2)");
      } finally {
        exitSpy.mockRestore();
      }
      expect(client.auth.intent).not.toHaveBeenCalled();
      expect(readSingleLine).toHaveBeenCalledTimes(1);
      const stderrOut = out.stderr.write.mock.calls.map((c) => c[0] as string).join("");
      expect(stderrOut).toContain("li_at");
    });

    it("password: empty line, WITH env set -> resolves from env (tier 2); the masked prompt is never consulted", async () => {
      process.env[ENV_PASSWORD] = "envpw";
      const { runAccountLink } = await import("../../src/commands/account.js");
      const client = makeClient();
      (client.auth.intent as Mock).mockResolvedValue({ object: "account" });
      const out = makeOut();
      const readSingleLine = vi.fn(async () => "");
      const readline = vi.fn(async () => "SHOULD_NOT_BE_CALLED");
      await runAccountLink(
        client as never,
        { "seat-id": "seat_1", "auth-method": "credentials", country: "US", email: "a@b.c", "password-stdin": true, json: true } as never,
        out,
        { isTTY: true, readSingleLine, readline },
      );
      expect(client.auth.intent).toHaveBeenCalledWith(
        expect.objectContaining({ credentials: { email: "a@b.c", password: "envpw" } }),
      );
      expect(readSingleLine).toHaveBeenCalledTimes(1);
      expect(readline).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Tier-1b's gate is preview-only, decoupled from tier 3/4's email-inclusive
// gate (qa corner B). --password-stdin on a TTY with no --email and no
// --preview must still consult the reader — the email gate only applies to
// the masked-prompt (tier 3) and fail-fast (tier 4) tiers, never to an
// explicit --*-stdin read the user asked for.
// ---------------------------------------------------------------------------

describe("account credentials — tier-1b TTY stdin read is gated by preview only, not --email", () => {
  it("password: --password-stdin on a TTY with NO --email, not preview -> the reader IS consulted (cue written, stub called)", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const client = makeClient();
    (client.auth.intent as Mock).mockResolvedValue({ object: "account" });
    const out = makeOut();
    const readSingleLine = vi.fn(async () => "TTY_PWD_NO_EMAIL");
    await runAccountLink(
      client as never,
      { "seat-id": "seat_1", "auth-method": "credentials", country: "US", "password-stdin": true, json: true } as never,
      out,
      { isTTY: true, readSingleLine },
    );
    // The reader was consulted despite no --email — tier-1b is gated by
    // preview only.
    expect(readSingleLine).toHaveBeenCalledTimes(1);
    const stderrOut = out.stderr.write.mock.calls.map((c) => c[0] as string).join("");
    expect(stderrOut).toMatch(/paste/i);
    // The resolved password still reaches the body — downstream/server-side
    // validation is what would reject an email-less credentials body, not
    // this resolver silently dropping the read.
    expect(client.auth.intent).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: { password: "TTY_PWD_NO_EMAIL" } }),
    );
  });
});

// ---------------------------------------------------------------------------
// --preview suppresses the TTY-mode stdin read entirely — no cue, no block,
// no reader call. The piped (non-TTY) --preview path is unaffected.
// ---------------------------------------------------------------------------

describe("account credentials — --preview suppresses the TTY-mode stdin read entirely", () => {
  it("password: --preview + --password-stdin on a TTY never calls the reader, never writes a cue, renders masked", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const client = makeClient();
    const out = makeOut();
    const readSingleLine = vi.fn(async () => "SHOULD_NOT_BE_CALLED");
    await runAccountLink(
      client as never,
      { "seat-id": "seat_1", "auth-method": "credentials", country: "US", email: "a@b.c", "password-stdin": true, preview: true } as never,
      out,
      { isTTY: true, readSingleLine },
    );
    expect(readSingleLine).not.toHaveBeenCalled();
    expect(client.auth.intent).not.toHaveBeenCalled();
    expect(out.stderr.write).not.toHaveBeenCalled();
    const written = out.stdout.write.mock.calls.map((c) => c[0] as string).join("");
    expect(written).not.toContain("SHOULD_NOT_BE_CALLED");
  });

  it("cookie: --preview + --li-at-stdin on a TTY never calls the reader, never blocks", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const client = makeClient();
    const out = makeOut();
    const readSingleLine = vi.fn(async () => "SHOULD_NOT_BE_CALLED");
    await runAccountLink(
      client as never,
      { "seat-id": "seat_1", "auth-method": "cookie", country: "US", "user-agent": "UA", "li-at-stdin": true, preview: true } as never,
      out,
      { isTTY: true, readSingleLine },
    );
    expect(readSingleLine).not.toHaveBeenCalled();
    expect(client.auth.intent).not.toHaveBeenCalled();
    expect(out.stderr.write).not.toHaveBeenCalled();
  });

  it("guard: --preview + piped (non-TTY) --password-stdin is unaffected — still reads to EOF and masks the result", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const client = makeClient();
    const out = makeOut();
    await runAccountLink(
      client as never,
      { "seat-id": "seat_1", "auth-method": "credentials", country: "US", email: "a@b.c", "password-stdin": true, preview: true } as never,
      out,
      { isTTY: false, readStdin: async () => "PIPED_PREVIEW_PW\n" },
    );
    const written = out.stdout.write.mock.calls.map((c) => c[0] as string).join("");
    expect(written).toContain("••••");
    expect(written).not.toContain("PIPED_PREVIEW_PW");
  });
});

// ---------------------------------------------------------------------------
// sentinel never leaks; --preview masks per-secret; masking
// runs on a copy (a later non-preview call still sends the real secret).
// ---------------------------------------------------------------------------

describe("account credentials — sentinel never leaks to stdout/stderr", () => {
  const SENTINEL = "LI_SENTINEL_MUST_NOT_LEAK";

  it("flag-sourced password sentinel never appears in captured output (success path)", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const client = makeClient();
    (client.auth.intent as Mock).mockResolvedValue({ object: "account", account_id: "acc_1" });
    const out = makeOut();
    await runAccountLink(
      client as never,
      { "seat-id": "seat_1", "auth-method": "credentials", country: "US", email: "a@b.c", password: SENTINEL, json: true } as never,
      out,
    );
    const combined =
      out.stdout.write.mock.calls.map((c) => c[0] as string).join("") +
      out.stderr.write.mock.calls.map((c) => c[0] as string).join("");
    expect(combined).not.toContain(SENTINEL);
    expect(client.auth.intent).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: expect.objectContaining({ password: SENTINEL }) }),
    );
  });

  it("stdin-sourced sentinel never appears in output", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const client = makeClient();
    (client.auth.intent as Mock).mockResolvedValue({ object: "account" });
    const out = makeOut();
    await runAccountLink(
      client as never,
      { "seat-id": "seat_1", "auth-method": "credentials", country: "US", email: "a@b.c", "password-stdin": true, json: true } as never,
      out,
      { readStdin: async () => SENTINEL },
    );
    const combined =
      out.stdout.write.mock.calls.map((c) => c[0] as string).join("") +
      out.stderr.write.mock.calls.map((c) => c[0] as string).join("");
    expect(combined).not.toContain(SENTINEL);
  });

  it("env-sourced sentinel never appears in output", async () => {
    process.env[ENV_PASSWORD] = SENTINEL;
    try {
      const { runAccountLink } = await import("../../src/commands/account.js");
      const client = makeClient();
      (client.auth.intent as Mock).mockResolvedValue({ object: "account" });
      const out = makeOut();
      await runAccountLink(
        client as never,
        { "seat-id": "seat_1", "auth-method": "credentials", country: "US", email: "a@b.c", json: true } as never,
        out,
      );
      const combined =
        out.stdout.write.mock.calls.map((c) => c[0] as string).join("") +
        out.stderr.write.mock.calls.map((c) => c[0] as string).join("");
      expect(combined).not.toContain(SENTINEL);
    } finally {
      delete process.env[ENV_PASSWORD];
    }
  });

  it("--preview masks the credentials.password sentinel", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const client = makeClient();
    const out = makeOut();
    await runAccountLink(
      client as never,
      { "seat-id": "seat_1", "auth-method": "credentials", country: "US", email: "a@b.c", password: SENTINEL, preview: true } as never,
      out,
    );
    const written = out.stdout.write.mock.calls.map((c) => c[0] as string).join("");
    expect(written).not.toContain(SENTINEL);
    expect(written).toContain("••••");
  });

  it("--preview masks the cookie.li_at and cookie.li_a sentinels (link, cookie method)", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const client = makeClient();
    const out = makeOut();
    await runAccountLink(
      client as never,
      { "seat-id": "seat_1", "auth-method": "cookie", country: "US", "user-agent": "UA", "li-at": SENTINEL, "li-a": `${SENTINEL}_A`, preview: true } as never,
      out,
    );
    const written = out.stdout.write.mock.calls.map((c) => c[0] as string).join("");
    expect(written).not.toContain(SENTINEL);
    expect(written).toContain("••••");
  });

  it("--preview masks the proxy.password sentinel (update)", async () => {
    const { runAccountUpdate } = await import("../../src/commands/account.js");
    const client = makeClient();
    const out = makeOut();
    await runAccountUpdate(
      client as never,
      { "account-id": "acc_1", "proxy-host": "proxy.example.com", "proxy-password": SENTINEL, preview: true } as never,
      out,
    );
    const written = out.stdout.write.mock.calls.map((c) => c[0] as string).join("");
    expect(written).not.toContain(SENTINEL);
    expect(written).toContain("••••");
  });

  it("masking runs on a copy: a later non-preview call with the same flags still sends the real secret", async () => {
    const { runAccountLink } = await import("../../src/commands/account.js");
    const client = makeClient();
    (client.auth.intent as Mock).mockResolvedValue({ object: "account" });
    const flags = { "seat-id": "seat_1", "auth-method": "credentials", country: "US", email: "a@b.c", password: SENTINEL, json: true };

    await runAccountLink(client as never, { ...flags, preview: true } as never, makeOut());
    const realOut = makeOut();
    await runAccountLink(client as never, flags as never, realOut);

    expect(client.auth.intent).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: { email: "a@b.c", password: SENTINEL } }),
    );
  });
});
