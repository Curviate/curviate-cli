/**
 * Black-box tests — spawn the BUILT bin (dist/cli.js) and verify:
 *   1. Bare "-" as TEXT positional is correctly bound (reads stdin) — REQ-092/Defect-1.
 *   2. Empty stdin → exit 2 with no request sent — contact-safety guard.
 *   3. `message send <chat> <text>` routes to the correct chat — REQ-092/Defect-2.
 *
 * These tests MUST spawn the real bin. Unit tests that call run-functions directly
 * with `text:"-"` give a false pass (citty-routing trap): they never exercise
 * the argv-parsing layer where the bug lives.
 *
 * Probe strategy: all write commands use `--preview` so no network call is made.
 * Empty-stdin tests assert exit 2 before preview renders (no network ever reached).
 *
 * Build prereq: dist/cli.js must exist. The beforeAll builds it if absent.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { spawnSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { SPAWN_TIMEOUT_MS, spawnTestTimeout } from "../helpers/spawn-budget.js";

// Vitest's default (5s) is shorter than the spawn's own timeout below (see spawn-budget.ts).
vi.setConfig({ testTimeout: spawnTestTimeout() });

const __dirname = dirname(fileURLToPath(import.meta.url));
// Test lives in test/commands/ — two levels above the package root.
const pkgRoot = resolve(__dirname, "../..");
const cliPath = resolve(pkgRoot, "dist", "cli.js");

const BASE_ENV = {
  ...process.env,
  NODE_ENV: "production",
  CURVIATE_API_KEY: "rdc_live_bin_test_stub",
};

function run(args: string[], opts: { input?: string } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    env: BASE_ENV,
    input: opts.input,
  });
}

/** Parse the single JSON preview line from stdout. */
function parsePreview(stdout: string): Record<string, unknown> {
  const line = stdout.trim();
  return JSON.parse(line) as Record<string, unknown>;
}

beforeAll(() => {
  if (!existsSync(cliPath)) {
    execSync("node_modules/.bin/tsup", { cwd: pkgRoot, stdio: "ignore" });
  }
});

// ---------------------------------------------------------------------------
// Defect 1 — empty stdin exits 2 before any request (contact-safety guard)
// ---------------------------------------------------------------------------

describe("stdin guard — empty stdin exits 2 without sending a request", () => {
  it("message <chat> - with empty stdin: exit 2, no preview rendered", () => {
    const r = run(
      ["message", "chat_test_1", "-", "--preview", "--account", "acc_1"],
      { input: "" },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("stdin: empty input");
    // No preview output — request must NOT have been constructed.
    expect(r.stdout.trim()).toBe("");
  });

  it("message new --to <id> - with empty stdin: exit 2, no preview rendered", () => {
    const r = run(
      ["message", "new", "--to", "ACoAAA123", "-", "--preview", "--account", "acc_1"],
      { input: "" },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("stdin: empty input");
    expect(r.stdout.trim()).toBe("");
  });

  it("message edit <chat_id> <msg_id> - with empty stdin: exit 2, no preview rendered", () => {
    const r = run(
      ["message", "edit", "chat_9", "msg_abc", "-", "--preview", "--account", "acc_1"],
      { input: "" },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("stdin: empty input");
    expect(r.stdout.trim()).toBe("");
  });

  it("message inmail --to <id> - with empty stdin: exit 2, no preview rendered", () => {
    const r = run(
      [
        "message", "inmail",
        "--to", "ACoAAA123",
        "--subject", "Hi",
        "-",
        "--preview",
        "--account", "acc_1",
      ],
      { input: "" },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("stdin: empty input");
    expect(r.stdout.trim()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Defect 1 — stdin content is read and passed as text
// ---------------------------------------------------------------------------

describe("stdin content — bare '-' binds to TEXT positional and reads stdin", () => {
  it("message <chat> - reads single-line stdin and passes it as body.text", () => {
    const r = run(
      ["message", "chat_9", "-", "--preview", "--account", "acc_1"],
      { input: "Hello from stdin\n" },
    );
    expect(r.status).toBe(0);
    const preview = parsePreview(r.stdout);
    expect(preview.method).toBe("messaging.sendMessage");
    const body = preview.body as Record<string, unknown>;
    expect(body.text).toBe("Hello from stdin");
  });

  it("message <chat> - preserves internal newlines, strips only trailing newline", () => {
    const r = run(
      ["message", "chat_9", "-", "--preview", "--account", "acc_1"],
      { input: "Line 1\nLine 2\n" },
    );
    expect(r.status).toBe(0);
    const preview = parsePreview(r.stdout);
    const body = preview.body as Record<string, unknown>;
    expect(body.text).toBe("Line 1\nLine 2");
  });

  it("message new --to <id> - reads stdin and passes it as body.text for startChat", () => {
    const r = run(
      ["message", "new", "--to", "ACoAAA123", "-", "--preview", "--account", "acc_1"],
      { input: "Hello via stdin\n" },
    );
    expect(r.status).toBe(0);
    const preview = parsePreview(r.stdout);
    expect(preview.method).toBe("messaging.startChat");
    const body = preview.body as Record<string, unknown>;
    expect(body.text).toBe("Hello via stdin");
  });

  it("message edit <chat_id> <msg_id> - reads stdin and passes it as body.text for editMessage", () => {
    const r = run(
      ["message", "edit", "chat_9", "msg_abc", "-", "--preview", "--account", "acc_1"],
      { input: "Edited body\n" },
    );
    expect(r.status).toBe(0);
    const preview = parsePreview(r.stdout);
    expect(preview.method).toBe("messaging.editMessage");
    const body = preview.body as Record<string, unknown>;
    expect(body.text).toBe("Edited body");
  });

  it("message inmail --to <id> - reads stdin and passes it as body.text for sendInMail", () => {
    const r = run(
      [
        "message", "inmail",
        "--to", "ACoAAA123",
        "--subject", "Greetings",
        "-",
        "--preview",
        "--account", "acc_1",
      ],
      { input: "InMail via stdin\n" },
    );
    expect(r.status).toBe(0);
    const preview = parsePreview(r.stdout);
    expect(preview.method).toBe("messaging.sendInMail");
    const body = preview.body as Record<string, unknown>;
    expect(body.text).toBe("InMail via stdin");
  });
});

// ---------------------------------------------------------------------------
// Defect 2 — `message send <chat> <text>` routes to the correct endpoint
// ---------------------------------------------------------------------------

describe("message send subcommand — routes to correct chat_id, not 'send'", () => {
  it("message send <chat_id> <text> --preview: method=messaging.sendMessage, args.chat_id=<chat_id>", () => {
    const r = run([
      "message", "send", "chat_correct_123", "hi",
      "--preview",
      "--account", "acc_1",
    ]);
    expect(r.status).toBe(0);
    const preview = parsePreview(r.stdout);
    expect(preview.method).toBe("messaging.sendMessage");
    // args.chat_id must be the real chat id, NOT "send".
    const args = preview.args as Record<string, unknown>;
    expect(args.chat_id).toBe("chat_correct_123");
    expect(args.chat_id).not.toBe("send");
  });

  it("message send <chat_id> - --preview with stdin: text is read from stdin", () => {
    const r = run(
      ["message", "send", "chat_correct_123", "-", "--preview", "--account", "acc_1"],
      { input: "stdin via send\n" },
    );
    expect(r.status).toBe(0);
    const preview = parsePreview(r.stdout);
    expect(preview.method).toBe("messaging.sendMessage");
    const args = preview.args as Record<string, unknown>;
    const body = preview.body as Record<string, unknown>;
    expect(args.chat_id).toBe("chat_correct_123");
    expect(body.text).toBe("stdin via send");
  });

  it("bare message <chat_id> <text> --preview still works (back-compat)", () => {
    const r = run([
      "message", "chat_bare_456", "hello",
      "--preview",
      "--account", "acc_1",
    ]);
    expect(r.status).toBe(0);
    const preview = parsePreview(r.stdout);
    expect(preview.method).toBe("messaging.sendMessage");
    const args = preview.args as Record<string, unknown>;
    expect(args.chat_id).toBe("chat_bare_456");
  });
});

// ---------------------------------------------------------------------------
// Regression guard — message subcommands unaffected by send addition
// ---------------------------------------------------------------------------

describe("message subcommand routing — existing subcommands still route correctly", () => {
  it("message new --preview still routes to messaging.startChat (not affected by send subcommand)", () => {
    const r = run([
      "message", "new",
      "--to", "ACoAAA123",
      "hello text",
      "--preview",
      "--account", "acc_1",
    ]);
    expect(r.status).toBe(0);
    const preview = parsePreview(r.stdout);
    expect(preview.method).toBe("messaging.startChat");
    expect(r.stdout).not.toContain("messaging.sendMessage");
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
  });
});
