/**
 * `--preview` renders the request, and every value that arrived through a
 * secret flag (`SECRET_FLAGS`) is masked in it: an OTP, a password, a session
 * cookie, a proxy password, the API key. Swept over every command that takes
 * both `--preview` and a secret flag, through the built bin. `--signature` on
 * `recruiter message new` is message content, not a credential, and stays.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandDef } from "citty";
import { SECRET_FLAGS } from "../src/dispatch.js";
import { runBin } from "./helpers/run-bin.js";

const xdg = mkdtempSync(join(tmpdir(), "curviate-preview-secret-"));
const MARK = "ZZSECRET4242ZZ";
const common = ["--preview", "--api-key", `cvt_test_${MARK}abcdef`, "--base-url", "http://127.0.0.1:9"];

const asCmd = (c: unknown): CommandDef => c as CommandDef;
async function resolveValue<T>(input: T | (() => T) | (() => Promise<T>)): Promise<T> {
  return typeof input === "function" ? (input as () => T | Promise<T>)() : input;
}
async function leaves(cmd: CommandDef, path: string[], out: Array<{ path: string; cmd: CommandDef }>) {
  const subs = (await resolveValue(cmd.subCommands ?? {})) as Record<string, unknown>;
  if (cmd.run) out.push({ path: path.join(" "), cmd });
  for (const [name, sub] of Object.entries(subs)) await leaves(asCmd(await resolveValue(sub as CommandDef)), [...path, name], out);
}

/** argv per command, with every secret flag it takes set to a marker, and the non-secret values the preview must still show. */
const CASES: Record<string, Array<{ argv: string[]; shows: string[] }>> = {
  "account checkpoint solve": [
    { argv: ["account", "checkpoint", "solve", "acc_1", "--code", MARK], shows: ["acc_1"] },
    { argv: ["account", "checkpoint", "solve", "acc_1", "--code=" + MARK], shows: ["acc_1"] },
  ],
  "account link": [
    {
      argv: ["account", "link", "--seat-id", "seat_1", "--auth-method", "credentials", "--email", "e@x.test", "--password", MARK,
        "--proxy-host", "proxy.test", "--proxy-password", MARK],
      shows: ["seat_1", "e@x.test", "proxy.test"],
    },
    {
      argv: ["account", "link", "--seat-id", "seat_1", "--auth-method", "cookie", "--li-at", MARK, "--li-a", MARK, "--user-agent", "UA/1"],
      shows: ["seat_1", "UA/1"],
    },
  ],
  "account update": [
    { argv: ["account", "update", "acc_1", "--proxy-host", "proxy.test", "--proxy-password", MARK], shows: ["acc_1", "proxy.test"] },
  ],
};

describe("--preview masks every secret flag's value", () => {
  it("the swept commands are exactly those taking --preview and a secret flag", async () => {
    const groups: Array<readonly [string, CommandDef]> = [
      ["account", asCmd((await import("../src/commands/account.js")).accountCommand)],
      ["comment", asCmd((await import("../src/commands/comment.js")).commentCommand)],
      ["company", asCmd((await import("../src/commands/company.js")).companyCommand)],
      ["connect", asCmd((await import("../src/commands/connect.js")).connectCommand)],
      ["feed", asCmd((await import("../src/commands/feed.js")).feedCommand)],
      ["group", asCmd((await import("../src/commands/group.js")).groupCommand)],
      ["inbox", asCmd((await import("../src/commands/inbox.js")).inboxCommand)],
      ["inboxes", asCmd((await import("../src/commands/inboxes.js")).inboxesCommand)],
      ["job", asCmd((await import("../src/commands/job.js")).jobCommand)],
      ["message", asCmd((await import("../src/commands/message.js")).messageCommand)],
      ["notification", asCmd((await import("../src/commands/notification.js")).notificationCommand)],
      ["post", asCmd((await import("../src/commands/post.js")).postCommand)],
      ["profile", asCmd((await import("../src/commands/profile.js")).profileCommand)],
      ["recruiter", asCmd((await import("../src/commands/recruiter.js")).recruiterCommand)],
      ["sales-nav", asCmd((await import("../src/commands/sales-nav.js")).salesNavCommand)],
      ["search", asCmd((await import("../src/commands/search.js")).searchCommand)],
      ["webhook", asCmd((await import("../src/commands/webhook.js")).webhookCommand)],
      ["setup", asCmd((await import("../src/commands/setup.js")).setupCommand)],
      ["login", asCmd((await import("../src/commands/login.js")).loginCommand)],
      ["doctor", asCmd((await import("../src/commands/doctor.js")).doctorCommand)],
      ["config", asCmd((await import("../src/commands/config.js")).configCommand)],
    ];
    const all: Array<{ path: string; cmd: CommandDef }> = [];
    for (const [name, cmd] of groups) await leaves(cmd, [name], all);
    expect(all.length).toBeGreaterThan(100);
    const found: string[] = [];
    for (const { path, cmd } of all) {
      const defs = (await resolveValue(cmd.args ?? {})) as Record<string, unknown>;
      if ("preview" in defs && SECRET_FLAGS.some((f) => f !== "api-key" && f in defs)) found.push(path);
    }
    expect(found.sort()).toEqual(Object.keys(CASES).sort());
  });

  for (const [path, cases] of Object.entries(CASES)) {
    for (const { argv, shows } of cases) {
      it(`${path}: ${argv.filter((a) => a.startsWith("--")).map((a) => a.split("=")[0]).join(" ")}`, () => {
        const r = runBin([...argv, ...common], xdg);
        expect(r.status, r.stdout + r.stderr).toBe(0);
        const preview = JSON.parse(r.stdout.trim()) as { method: string };
        expect(preview.method).toBeTruthy();
        expect(r.stdout).toContain("••••");
        for (const value of shows) expect(r.stdout).toContain(value);
        expect(r.stdout + r.stderr).not.toContain(MARK);
      });
    }
  }

  it("--signature is message content, not a secret: shown in the preview", () => {
    const r = runBin(
      ["recruiter", "message", "new", "--to", "ACoAAB", "--subject", "Hello", "--signature", "Best, Sam", "hi there", "--beta", "--account", "acc_1", ...common],
      xdg,
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("Best, Sam");
    expect(SECRET_FLAGS).not.toContain("signature");
  });
});
