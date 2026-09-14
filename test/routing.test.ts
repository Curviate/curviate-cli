/**
 * Black-box routing tests — spawn the BUILT bin (dist/cli.js) and assert the
 * dispatcher routes bare intent-shaped forms and subcommands correctly.
 *
 * These tests exercise the real command-line router end-to-end, which the
 * unit tests (which call the exported run functions directly) cannot: the
 * router lives between argv and those functions, and a routing regression is
 * invisible unless argv is actually parsed by the bin.
 *
 * Two probe strategies, both network-free or deterministically-network:
 *   - `--preview` on a write form renders the pending request and exits 0
 *     without any network call. We assert the rendered method + a single
 *     render line.
 *   - For reads, we point `--base-url` at an unroutable host and assert the
 *     failure is the downstream network/SDK error (exit code from the
 *     error→exit map), NOT a routing "Unknown command" (which would mean the
 *     bare positional never reached the handler).
 *
 * NODE_ENV=production is required so the underlying CLI framework's console
 * is not silenced by test-mode detection.
 *
 * Build prerequisite: `pnpm build` must have produced a current dist/cli.js.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const cliPath = resolve(pkgRoot, "dist", "cli.js");

// A syntactically-valid but unroutable base URL: connections are refused
// immediately, so the SDK surfaces a network error fast (no long timeout).
const UNROUTABLE = "http://127.0.0.1:1";

function run(args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, NODE_ENV: "production", CURVIATE_API_KEY: "rdc_live_routing_test_stub" },
  });
}

/** Combined output, useful for "must NOT be a routing error" assertions. */
function combined(r: ReturnType<typeof run>): string {
  return (r.stdout ?? "") + (r.stderr ?? "");
}

/** True when the output is the framework's "unknown command" routing error. */
function isUnknownCommand(r: ReturnType<typeof run>): boolean {
  return /Unknown command/i.test(combined(r));
}

beforeAll(() => {
  // Ensure dist is current. The build is fast (~60ms) and idempotent.
  if (!existsSync(cliPath)) {
    execSync("pnpm build", { cwd: pkgRoot, stdio: "ignore" });
  }
});

describe("router — bare intent-shaped forms reach the handler (not 'Unknown command')", () => {
  it("connect <slug> --note --preview renders invites.send and exits 0", () => {
    const r = run([
      "connect", "jdoe",
      "--note", "hi",
      "--preview",
      "--account", "acc_x",
    ]);
    expect(isUnknownCommand(r)).toBe(false);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("invites.send");
    // Exactly one preview render line (no stray second method).
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
  });

  it("profile <slug> (bare get) reaches the SDK path — network error, not a routing error", () => {
    const r = run([
      "profile", "jdoe",
      "--account", "acc_x",
      "--base-url", UNROUTABLE,
      "--json",
    ]);
    expect(isUnknownCommand(r)).toBe(false);
    // Reached the SDK and failed on the network — no response is a transient platform fault, exit 7.
    expect(r.status).toBe(7);
    expect(r.stdout).toMatch(/"error"/);
  });

  it("profile <slug> --posts reaches the list-posts SDK path (not a routing error)", () => {
    const r = run([
      "profile", "jdoe",
      "--posts",
      "--account", "acc_x",
      "--base-url", UNROUTABLE,
      "--json",
    ]);
    expect(isUnknownCommand(r)).toBe(false);
    expect(r.status).toBe(7);
    expect(r.stdout).toMatch(/"error"/);
  });

  it("profile '<url>' --posts reaches the SDK path (url-shaped positional)", () => {
    const r = run([
      "profile", "https://www.linkedin.com/in/jdoe/",
      "--posts",
      "--account", "acc_x",
      "--base-url", UNROUTABLE,
      "--json",
    ]);
    expect(isUnknownCommand(r)).toBe(false);
    expect(r.status).toBe(7);
    expect(r.stdout).toMatch(/"error"/);
  });

  it("company <id> (bare get) reaches the companies.get SDK path — network error, not a routing error", () => {
    // company mixes a bare positional (retrieve) with subCommands
    // (employees/posts/jobs) — the exact coexistence the
    // pre-router (dispatch.ts) exists to make work. A non-subcommand token
    // must resolve to the bare form, not "Unknown command t-systems".
    const r = run([
      "company", "t-systems",
      "--account", "acc_x",
      "--base-url", UNROUTABLE,
      "--json",
    ]);
    expect(isUnknownCommand(r)).toBe(false);
    expect(r.status).toBe(7);
    expect(r.stdout).toMatch(/"error"/);
  });

  it("message <chat_id> \"text\" --preview renders ONLY messaging.sendMessage, exits 0", () => {
    const r = run([
      "message", "chat_9", "hi",
      "--preview",
      "--account", "acc_x",
    ]);
    expect(isUnknownCommand(r)).toBe(false);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("messaging.sendMessage");
    // The bare send form must NOT also fan out to startChat.
    expect(r.stdout).not.toContain("messaging.startChat");
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
  });
});

describe("router — subcommands still route after the bare-form fix", () => {
  it("profile me reaches the getMe SDK path (subcommand, not bare)", () => {
    const r = run([
      "profile", "me",
      "--account", "acc_x",
      "--base-url", UNROUTABLE,
      "--json",
    ]);
    expect(isUnknownCommand(r)).toBe(false);
    expect(r.status).toBe(7);
    expect(r.stdout).toMatch(/"error"/);
  });

  it("connect sent reaches the listSent SDK path (subcommand)", () => {
    const r = run([
      "connect", "sent",
      "--account", "acc_x",
      "--base-url", UNROUTABLE,
      "--json",
    ]);
    expect(isUnknownCommand(r)).toBe(false);
    expect(r.status).toBe(7);
    expect(r.stdout).toMatch(/"error"/);
  });

  it("message new --preview renders ONLY messaging.startChat (one method), exits 0", () => {
    const r = run([
      "message", "new",
      "--to", "ACo123", "hello",
      "--preview",
      "--account", "acc_x",
    ]);
    expect(isUnknownCommand(r)).toBe(false);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("messaging.startChat");
    expect(r.stdout).not.toContain("messaging.sendMessage");
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
  });

  it("job get <url> reaches the jobs.get SDK path (subcommand, not bare)", () => {
    const r = run([
      "job", "get", "https://www.linkedin.com/jobs/view/4428113858",
      "--account", "acc_x",
      "--base-url", UNROUTABLE,
      "--json",
    ]);
    expect(isUnknownCommand(r)).toBe(false);
    expect(r.status).toBe(7);
    expect(r.stdout).toMatch(/"error"/);
  });

  it("recruiter job get <id> reaches the recruiter.getJob SDK path (nested subcommand)", () => {
    const r = run([
      "recruiter", "job", "get", "4428113858",
      "--account", "acc_x",
      "--base-url", UNROUTABLE,
      "--json",
    ]);
    expect(isUnknownCommand(r)).toBe(false);
    expect(r.status).toBe(7);
    expect(r.stdout).toMatch(/"error"/);
  });

  it("recruiter applicants <project_id> routes to the top-level project-scoped command", () => {
    const r = run([
      "recruiter", "applicants", "proj_99",
      "--channel-id", "ch_1",
      "--account", "acc_x",
      "--base-url", UNROUTABLE,
      "--json",
    ]);
    expect(isUnknownCommand(r)).toBe(false);
    expect(r.status).toBe(7);
    expect(r.stdout).toMatch(/"error"/);
  });

  it("company employees <id> reaches the companies.employees SDK path (subcommand, not the bare retrieve)", () => {
    const r = run([
      "company", "employees", "112013061",
      "--account", "acc_x",
      "--base-url", UNROUTABLE,
      "--json",
    ]);
    expect(isUnknownCommand(r)).toBe(false);
    expect(r.status).toBe(7);
    expect(r.stdout).toMatch(/"error"/);
  });

  it("company posts <id> reaches the companies.posts SDK path (subcommand)", () => {
    const r = run([
      "company", "posts", "112013061",
      "--account", "acc_x",
      "--base-url", UNROUTABLE,
      "--json",
    ]);
    expect(isUnknownCommand(r)).toBe(false);
    expect(r.status).toBe(7);
    expect(r.stdout).toMatch(/"error"/);
  });

  it("company jobs <id> reaches the companies.jobs SDK path (subcommand)", () => {
    const r = run([
      "company", "jobs", "112013061",
      "--account", "acc_x",
      "--base-url", UNROUTABLE,
      "--json",
    ]);
    expect(isUnknownCommand(r)).toBe(false);
    expect(r.status).toBe(7);
    expect(r.stdout).toMatch(/"error"/);
  });

});

describe("router — usage/routing errors exit 2", () => {
  it("unknown top-level command exits 2", () => {
    const r = run(["bogus-command"]);
    expect(r.status).toBe(2);
  });

  it("unknown subcommand under a pure group exits 2", () => {
    const r = run(["account", "bogus-sub"]);
    expect(r.status).toBe(2);
  });

  it("unknown flag exits 2", () => {
    const r = run(["profile", "me", "--no-such-flag", "--account", "acc_x"]);
    expect(r.status).toBe(2);
  });

  it("missing required flag exits 2 (usage error, not internal)", () => {
    // `webhook create` requires --source / --request-url / --account-ids.
    const r = run(["webhook", "create"]);
    expect(r.status).toBe(2);
  });

  it("a bare form with a non-subcommand extra positional exits 2 (never silent-swallow, D4a)", () => {
    // `company <id> bogus` — `bogus` is neither a second positional company
    // accepts nor a subcommand. The pre-router must NOT bind `<id>` and swallow
    // `bogus` (which returned the base company profile, exit 0, pre-fix).
    const r = run(["company", "1035", "bogus", "--account", "acc_x"]);
    expect(r.status).toBe(2);
    expect(combined(r)).toMatch(/unexpected argument `bogus`/);
  });

  it("`profile <id> bogus` exits 2 (non-subcommand extra positional, D4a)", () => {
    const r = run(["profile", "jdoe", "bogus", "--account", "acc_x"]);
    expect(r.status).toBe(2);
  });

  it("bare `connect` (no id, no subcommand) exits 2 — missing required positional, not a silent 0", () => {
    // The M3-cited finding: `connect`'s <id> is functionally required for the
    // bare form; the group's own usage-printing run() must not fall through
    // to Node's default exit 0. See test/dispatch-bare-group.test.ts for the
    // full class of commands this generalizes to (profile/message/search).
    const r = run(["connect"]);
    expect(r.status).toBe(2);
    expect(combined(r)).toMatch(/Usage: curviate connect/);
  });

  it("bare `account` (pure group, no bare positional) stays exit 0 — showing the subcommand menu is not a usage error", () => {
    // Contrast case: account has no intent-shaped bare form at all (every
    // action requires a keyword: list/get/link/…), so there is no positional
    // to be "missing". This end-to-end pairing with the connect case above
    // pins both halves of the convention against the real built binary.
    const r = run(["account"]);
    expect(r.status).toBe(0);
    expect(combined(r)).toMatch(/Usage: curviate account/);
  });
});

describe("router — id-first reroute reaches the subcommand, not the bare form (D4a)", () => {
  // `company <id> employees` must reroute to the employees sub-resource, NOT
  // silently return the base company retrieve. Against an unroutable base URL
  // both network-fail, so the observable end-to-end signal here is simply that
  // it routes to a handler (exit 7, not a routing usage error 2 / "Unknown
  // command"); the exact reroute target is pinned in test/dispatch.test.ts.
  for (const sub of ["employees", "posts", "jobs"] as const) {
    it(`company <id> ${sub} routes to a handler (not exit 2 / Unknown command)`, () => {
      const r = run([
        "company", "112013061", sub,
        "--account", "acc_x",
        "--base-url", UNROUTABLE,
        "--json",
      ]);
      expect(isUnknownCommand(r)).toBe(false);
      expect(r.status).not.toBe(2);
      expect(r.status).toBe(7);
    });
  }
});

describe("router — successful data commands write nothing to stderr", () => {
  it("connect <slug> --preview: stderr is empty on success", () => {
    const r = run([
      "connect", "jdoe",
      "--note", "hi",
      "--preview",
      "--account", "acc_x",
    ]);
    expect(r.status).toBe(0);
    expect(r.stderr.trim()).toBe("");
  });

  it("webhook create --preview: stderr is empty on success", () => {
    const r = run([
      "webhook", "create",
      "--source", "messaging",
      "--request-url", "https://example.com/hook",
      "--account-ids", "acc_1",
      "--preview",
    ]);
    expect(r.status).toBe(0);
    expect(r.stderr.trim()).toBe("");
  });
});

describe("router — projection arg validated before any SDK call", () => {
  it("--fields '' exits 2 (validated pre-call, no network)", () => {
    const r = run([
      "profile", "me",
      "--fields", "",
      "--account", "acc_x",
      "--base-url", UNROUTABLE,
      "--json",
    ]);
    // Must be the usage exit (2), NOT a downstream INTERNAL network error (1).
    expect(r.status).toBe(2);
  });
});

describe("router — unknown-flag detection vs. citty negation", () => {
  it("a literally-declared no-prefixed flag (--no-interactive) is accepted, not rejected as unknown", () => {
    // `account link` declares "no-interactive" (not "interactive") as its own
    // flag name. The unknown-flag check must match the full declared name
    // FIRST, before falling back to stripping a "no-" prefix for citty's
    // built-in negation — otherwise a literally-declared no-prefixed flag is
    // always misread as negating an undeclared "interactive" flag and
    // rejected as unknown on every invocation.
    const r = run([
      "account", "link",
      "--seat-id", "seat_1",
      "--auth-method", "credentials",
      "--email", "otp@example.com",
      "--password", "test-password",
      "--no-interactive",
      "--preview",
    ]);
    expect(combined(r)).not.toMatch(/unknown flag/i);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("auth.intent");
  });

  it("citty's negation fallback still works for a flag not literally declared with a no- prefix", () => {
    // `connect` declares "json" (not "no-json"). The full-name check misses,
    // so the no--stripped fallback must still fire and match "json".
    const r = run([
      "connect", "jdoe",
      "--note", "hi",
      "--preview",
      "--account", "acc_x",
      "--no-json",
    ]);
    expect(combined(r)).not.toMatch(/unknown flag/i);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("invites.send");
  });
});
