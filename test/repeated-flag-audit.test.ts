/**
 * A repeated flag never crashes and never silently changes meaning: citty
 * turns `--account a --account b` into an array (and `--json --json` into
 * `[true, true]`, which reads as "not JSON"). Every flag on every command is
 * swept; only the flags declared repeatable accumulate.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CommandDef } from "citty";
import { repeatedFlag, REPEATABLE_FLAGS } from "../src/dispatch.js";
import { runBin } from "./helpers/run-bin.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pkgRoot } from "./helpers/built-cli.js";

const asCmd = (c: unknown): CommandDef => c as CommandDef;

async function resolveValue<T>(input: T | (() => T) | (() => Promise<T>)): Promise<T> {
  return typeof input === "function" ? (input as () => T | Promise<T>)() : input;
}

const GROUPS: Record<string, () => Promise<CommandDef>> = {
  setup: () => import("../src/commands/setup.js").then((m) => asCmd(m.setupCommand)),
  doctor: () => import("../src/commands/doctor.js").then((m) => asCmd(m.doctorCommand)),
  login: () => import("../src/commands/login.js").then((m) => asCmd(m.loginCommand)),
  config: () => import("../src/commands/config.js").then((m) => asCmd(m.configCommand)),
  profile: () => import("../src/commands/profile.js").then((m) => asCmd(m.profileCommand)),
  company: () => import("../src/commands/company.js").then((m) => asCmd(m.companyCommand)),
  job: () => import("../src/commands/job.js").then((m) => asCmd(m.jobCommand)),
  connect: () => import("../src/commands/connect.js").then((m) => asCmd(m.connectCommand)),
  search: () => import("../src/commands/search.js").then((m) => asCmd(m.searchCommand)),
  inbox: () => import("../src/commands/inbox.js").then((m) => asCmd(m.inboxCommand)),
  inboxes: () => import("../src/commands/inboxes.js").then((m) => asCmd(m.inboxesCommand)),
  message: () => import("../src/commands/message.js").then((m) => asCmd(m.messageCommand)),
  post: () => import("../src/commands/post.js").then((m) => asCmd(m.postCommand)),
  comment: () => import("../src/commands/comment.js").then((m) => asCmd(m.commentCommand)),
  account: () => import("../src/commands/account.js").then((m) => asCmd(m.accountCommand)),
  webhook: () => import("../src/commands/webhook.js").then((m) => asCmd(m.webhookCommand)),
  "sales-nav": () => import("../src/commands/sales-nav.js").then((m) => asCmd(m.salesNavCommand)),
  recruiter: () => import("../src/commands/recruiter.js").then((m) => asCmd(m.recruiterCommand)),
  group: () => import("../src/commands/group.js").then((m) => asCmd(m.groupCommand)),
  feed: () => import("../src/commands/feed.js").then((m) => asCmd(m.feedCommand)),
  notification: () =>
    import("../src/commands/notification.js").then((m) => asCmd(m.notificationCommand)),
};

type ArgDef = { type?: string };

async function leaves(cmd: CommandDef, path: string[], out: Array<{ path: string; cmd: CommandDef }>) {
  const subs = (await resolveValue(cmd.subCommands ?? {})) as Record<string, unknown>;
  if (cmd.run) out.push({ path: path.join(" "), cmd });
  for (const [name, sub] of Object.entries(subs)) {
    await leaves(asCmd(await resolveValue(sub as CommandDef)), [...path, name], out);
  }
}

describe("every flag, repeated", () => {
  it("is refused unless declared repeatable, on every command", async () => {
    const all: Array<{ path: string; cmd: CommandDef }> = [];
    for (const [name, load] of Object.entries(GROUPS)) await leaves(await load(), [name], all);
    expect(all.length).toBeGreaterThan(100);

    let checked = 0;
    const wrong: string[] = [];
    for (const { path, cmd } of all) {
      const defs = (await resolveValue(cmd.args ?? {})) as Record<string, ArgDef>;
      for (const [flag, def] of Object.entries(defs)) {
        if (def.type === "positional") continue;
        const once = def.type === "boolean" ? [`--${flag}`] : [`--${flag}`, "v"];
        const verdict = await repeatedFlag(cmd, [...once, ...once]);
        const expected = REPEATABLE_FLAGS.includes(flag) ? null : flag;
        if (verdict !== expected) wrong.push(`${path} --${flag}: ${verdict}`);
        // a single use is never refused
        if ((await repeatedFlag(cmd, once)) !== null) wrong.push(`${path} --${flag} once`);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500);
    expect(wrong).toEqual([]);
  });

  it("the repeatable list is exactly the flags a command reads as an array", () => {
    const dir = resolve(pkgRoot, "src", "commands");
    const arrayFlags = new Set<string>();
    for (const f of readdirSync(dir)) {
      for (const m of readFileSync(join(dir, f), "utf8").matchAll(/^\s*"?([a-z-]+)"?\?: string \| string\[\];/gm)) {
        arrayFlags.add(m[1]!);
      }
    }
    expect([...arrayFlags].sort()).toEqual([...REPEATABLE_FLAGS].sort());
  });
});

describe("through the built bin", () => {
  const xdg = mkdtempSync(join(tmpdir(), "curviate-repeat-"));
  mkdirSync(join(xdg, "curviate"), { recursive: true });
  writeFileSync(join(xdg, "curviate", "config.json"), JSON.stringify({ active: "default", profiles: { default: {} } }));

  it("--account a --account b exits 2 with a clear message", () => {
    const r = runBin(["profile", "me", "--api-key", "cvt_test_x", "--account", "a", "--account", "b", "--base-url", "http://127.0.0.1:9"], xdg);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/--account was given more than once/);
    expect(r.stderr).not.toMatch(/is not a function|Internal error/);
  });

  it("-o x --output y counts the alias as the same flag", () => {
    const r = runBin(["job", "applicant", "resume", "a", "b", "-o", "x", "--output", "y", "--api-key", "cvt_test_x", "--account", "acc_1", "--base-url", "http://127.0.0.1:9"], xdg);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/--output was given more than once/);
  });

  it("--json --json exits 2", () => {
    const r = runBin(["config", "list", "--json", "--json"], xdg);
    expect(r.status, r.stderr).toBe(2);
  });

  it("--json once still works (positive control)", () => {
    const r = runBin(["config", "list", "--json"], xdg);
    expect(r.status, r.stderr).toBe(0);
  });
});
