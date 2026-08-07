/**
 * A RESOLVED LEAF must never silently discard an unconsumed positional.
 *
 * ## The defect
 *
 * The pre-router validated extra positionals in exactly one place: the branch
 * where a node that declares BOTH subcommands AND a bare positional runs its
 * bare form. Every other way of reaching an executable node returned it
 * unchecked, so citty bound the node's declared positionals and swallowed the
 * rest into `args._`, which no handler reads.
 *
 * `profile me relations` therefore returned the caller's OWN PROFILE at exit 0
 * with an empty stderr: a single object where a list was asked for. A caller
 * reading `.items` finds nothing and concludes the account has no connections.
 * `profile me zzzz-not-a-command` behaved identically, so the class is "any
 * trailing token on a leaf", not one unlucky alias collision.
 *
 * ## Why these tests are organised by REACH PATH
 *
 * The same class was closed twice before and came back, because each fix was
 * scoped to the path the bug was reported on rather than to the class. So the
 * cases below are derived from the command tree itself (a walk of all 147
 * leaves, 10 groups with a bare positional, 20 pure groups) and cover EVERY
 * way an executable node can be reached:
 *
 *   1. root-level leaf                 `login <extra>`
 *   2. descent, depth 1                `profile me <extra>`
 *   3. descent, depth 2                `account checkpoint solve <id> <extra>`
 *   4. descent, depth 3                `recruiter project-job budget <a> <b> <extra>`
 *   5. over-arity on a leaf that       `profile followers <id> <extra>`
 *      does declare positionals
 *   6. id-first reroute into a leaf    `company <id> managed`
 *      of lower arity than the group
 *   7. bare form of a group that       `company <id> <bogus>`  (already guarded;
 *      also has subcommands             locked here as a regression)
 *   8. group reached with no token     `curviate account`      (no extras possible)
 *
 * Two reach paths named in the report do NOT exist in this tree, verified by
 * walking it rather than by reading: no subcommand registry maps two keys to
 * the same command object (no aliases), and no group declares a default
 * subcommand (citty has no such feature and no group's `run` delegates to a
 * sibling). Both are asserted structurally below so a future alias or default
 * cannot be added without this file going red.
 *
 * ## Why `resolveLeaf`, not a spawn, for most cases
 *
 * `resolveLeaf` makes the routing DECISION assertable without executing a
 * handler or reaching the network. The end-to-end proof that no request is
 * made lives in the bin-level suite (test/leaf-extras-bin.test.ts), which also
 * measures the exit code unpiped.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { CommandDef } from "citty";
import { resolveLeaf } from "../src/dispatch.js";
import { accountCommand } from "../src/commands/account.js";
import { companyCommand } from "../src/commands/company.js";
import { loginCommand } from "../src/commands/login.js";
import { messageCommand } from "../src/commands/message.js";
import { profileCommand } from "../src/commands/profile.js";
import { recruiterCommand } from "../src/commands/recruiter.js";
import { searchCommand } from "../src/commands/search.js";
import { webhookCommand } from "../src/commands/webhook.js";
import { jobCommand } from "../src/commands/job.js";
import { commentCommand } from "../src/commands/comment.js";
import { configCommand } from "../src/commands/config.js";
import { connectCommand } from "../src/commands/connect.js";
import { feedCommand } from "../src/commands/feed.js";
import { groupCommand } from "../src/commands/group.js";
import { inboxCommand } from "../src/commands/inbox.js";
import { inboxesCommand } from "../src/commands/inboxes.js";
import { notificationCommand } from "../src/commands/notification.js";
import { postCommand } from "../src/commands/post.js";
import { salesNavCommand } from "../src/commands/sales-nav.js";

const asCmd = (c: unknown): CommandDef => c as CommandDef;

async function nameOf(cmd: CommandDef): Promise<string | undefined> {
  const meta =
    typeof cmd.meta === "function"
      ? await (cmd.meta as () => Promise<{ name?: string }>)()
      : cmd.meta;
  return (meta as { name?: string } | undefined)?.name;
}

function mockExit() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
}

/** Run resolveLeaf expecting a usage exit, returning everything written to stderr. */
async function expectUsageExit(tree: CommandDef, rawArgs: string[]): Promise<string> {
  const writes: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => {
    writes.push(String(s));
    return true;
  });
  const exit = mockExit();
  await expect(resolveLeaf(tree, rawArgs)).rejects.toThrow("process.exit(2)");
  exit.mockRestore();
  return writes.join("");
}

// ---------------------------------------------------------------------------
// The reported case, in full.
// ---------------------------------------------------------------------------

describe("resolved leaf — the reported case", () => {
  afterEach(() => vi.restoreAllMocks());

  it("`profile me relations` exits 2 instead of returning the caller's own profile", async () => {
    const stderr = await expectUsageExit(asCmd(profileCommand), ["me", "relations"]);
    expect(stderr).toContain("relations");
    // The message must name the form the caller actually typed...
    expect(stderr).toContain("curviate profile me");
    // ...and point at the correct one, since `profile relations` is a real
    // sibling and is what the caller meant.
    expect(stderr).toContain("curviate profile relations");
  });

  it("`profile me relations --limit 3 --json` still exits 2 (flags do not launder the extra)", async () => {
    const stderr = await expectUsageExit(asCmd(profileCommand), [
      "me",
      "relations",
      "--limit",
      "3",
      "--json",
    ]);
    expect(stderr).toContain("relations");
  });

  it("`profile me zzzz-not-a-command` exits 2 (the class is any trailing token, not one alias)", async () => {
    const stderr = await expectUsageExit(asCmd(profileCommand), ["me", "zzzz-not-a-command"]);
    expect(stderr).toContain("zzzz-not-a-command");
    // Not a sibling subcommand, so no did-you-mean is invented for it.
    expect(stderr).not.toContain("Did you mean");
  });

  it("`profile me relations extra1 extra2` exits 2, naming the FIRST unconsumed token", async () => {
    const stderr = await expectUsageExit(asCmd(profileCommand), [
      "me",
      "relations",
      "extra1",
      "extra2",
    ]);
    expect(stderr).toContain("relations");
  });
});

// ---------------------------------------------------------------------------
// One case per derived reach path.
// ---------------------------------------------------------------------------

describe("resolved leaf — every reach path rejects an unconsumed positional", () => {
  afterEach(() => vi.restoreAllMocks());

  // [label, tree, rawArgs, the token the message must name, the path it must name]
  const cases: Array<[string, CommandDef, string[], string, string]> = [
    // 1. Root-level leaf (no descent at all).
    ["login <extra>", asCmd(loginCommand), ["zzz-extra"], "zzz-extra", "curviate login"],
    // 2. Descent, depth 1, leaf declaring no positionals.
    ["profile me <extra>", asCmd(profileCommand), ["me", "zzz-extra"], "zzz-extra", "curviate profile me"],
    ["search parameters <extra>", asCmd(searchCommand), ["parameters", "zzz-extra"], "zzz-extra", "curviate search parameters"],
    ["webhook list <extra>", asCmd(webhookCommand), ["list", "zzz-extra"], "zzz-extra", "curviate webhook list"],
    ["feed home <extra>", asCmd(feedCommand), ["home", "zzz-extra"], "zzz-extra", "curviate feed home"],
    // 3. Descent, depth 2.
    [
      "account checkpoint solve <id> <extra>",
      asCmd(accountCommand),
      ["checkpoint", "solve", "acc_1", "zzz-extra"],
      "zzz-extra",
      "curviate account checkpoint solve",
    ],
    [
      "job applicant get <a> <b> <extra>",
      asCmd(jobCommand),
      ["applicant", "get", "job_1", "app_1", "zzz-extra"],
      "zzz-extra",
      "curviate job applicant get",
    ],
    // 4. Descent, depth 3 (the deepest path in the tree).
    [
      "recruiter project-job budget <a> <b> <extra>",
      asCmd(recruiterCommand),
      ["project-job", "budget", "proj_1", "job_1", "zzz-extra"],
      "zzz-extra",
      "curviate recruiter project-job budget",
    ],
    [
      "sales-nav search people <extra>",
      asCmd(salesNavCommand),
      ["search", "people", "zzz-extra"],
      "zzz-extra",
      "curviate sales-nav search people",
    ],
    // 5. Over-arity on a leaf that does declare positionals.
    [
      "profile followers <id> <extra>",
      asCmd(profileCommand),
      ["followers", "jdoe", "zzz-extra"],
      "zzz-extra",
      "curviate profile followers",
    ],
    [
      "comment reply <a> <b> <c> <extra>",
      asCmd(commentCommand),
      ["reply", "p1", "c1", "text", "zzz-extra"],
      "zzz-extra",
      "curviate comment reply",
    ],
    [
      "message send <chat> <text> <extra>",
      asCmd(messageCommand),
      ["send", "chat_1", "hello", "zzz-extra"],
      "zzz-extra",
      "curviate message send",
    ],
    // 6. Id-first reroute landing on a leaf of LOWER arity than the group it
    //    came from. The group sees exactly one extra that names a subcommand,
    //    reroutes, and the id it carried over is then unconsumed at the leaf.
    //    Pre-fix this listed YOUR managed companies and ignored `1035`.
    [
      "company <id> managed (reroute, leaf takes no positional)",
      asCmd(companyCommand),
      ["1035", "managed"],
      "1035",
      "curviate company managed",
    ],
    [
      "profile <id> subscription (reroute, leaf takes no positional)",
      asCmd(profileCommand),
      ["jdoe", "subscription"],
      "jdoe",
      "curviate profile subscription",
    ],
    [
      "search <id> parameters (reroute, leaf takes no positional)",
      asCmd(searchCommand),
      ["some-url", "parameters"],
      "some-url",
      "curviate search parameters",
    ],
  ];

  it.each(cases)(
    "%s exits 2, naming the token and the resolved form",
    async (_label, tree, rawArgs, token, path) => {
      const stderr = await expectUsageExit(tree, rawArgs);
      expect(stderr).toContain(token);
      expect(stderr).toContain(path);
    },
  );

  // 7. Regression lock on the one path that was already guarded, so a
  //    refactor that moves the check cannot quietly drop it.
  it("company <id> <bogus> (bare form of a group with subcommands) still exits 2", async () => {
    const stderr = await expectUsageExit(asCmd(companyCommand), ["1035", "zzz-bogus"]);
    expect(stderr).toContain("zzz-bogus");
  });
});

// ---------------------------------------------------------------------------
// Negative controls: every legitimate form must still route.
// ---------------------------------------------------------------------------

describe("resolved leaf — legitimate forms are untouched", () => {
  afterEach(() => vi.restoreAllMocks());

  const ok: Array<[string, CommandDef, string[], string, string[]]> = [
    ["profile me", asCmd(profileCommand), ["me"], "me", []],
    ["profile me --posts", asCmd(profileCommand), ["me", "--posts"], "me", ["--posts"]],
    ["profile me --sections skills", asCmd(profileCommand), ["me", "--sections", "skills"], "me", ["--sections", "skills"]],
    ["profile relations --limit 3", asCmd(profileCommand), ["relations", "--limit", "3"], "relations", ["--limit", "3"]],
    ["profile followers <id>", asCmd(profileCommand), ["followers", "jdoe"], "followers", ["jdoe"]],
    ["company employees <id> --keywords eng", asCmd(companyCommand), ["employees", "1035", "--keywords", "eng"], "employees", ["1035", "--keywords", "eng"]],
    ["company <id> employees (reroute, arities match)", asCmd(companyCommand), ["1035", "employees"], "employees", ["1035"]],
    ["message send <chat> <text>", asCmd(messageCommand), ["send", "chat_1", "hello world"], "send", ["chat_1", "hello world"]],
    ["message react <chat> <msg> <emoji>", asCmd(messageCommand), ["react", "c1", "m1", "thumb"], "react", ["c1", "m1", "thumb"]],
    ["message send <chat> - (bare dash stdin sentinel is a positional)", asCmd(messageCommand), ["send", "chat_1", "-"], "send", ["chat_1", "-"]],
    ["config rename <a> <b>", asCmd(configCommand), ["rename", "old", "new"], "rename", ["old", "new"]],
    ["recruiter project-job budget <a> <b>", asCmd(recruiterCommand), ["project-job", "budget", "p1", "j1"], "budget", ["p1", "j1"]],
    ["account checkpoint solve <id>", asCmd(accountCommand), ["checkpoint", "solve", "acc_1"], "solve", ["acc_1"]],
    ["inbox messages <chat>", asCmd(inboxCommand), ["messages", "chat_1"], "messages", ["chat_1"]],
    ["inboxes chats <id>", asCmd(inboxesCommand), ["chats", "in_1"], "chats", ["in_1"]],
    ["group members <id>", asCmd(groupCommand), ["members", "g1"], "members", ["g1"]],
    ["notification list", asCmd(notificationCommand), ["list"], "list", []],
    ["post user-posts me", asCmd(postCommand), ["user-posts", "me"], "user-posts", ["me"]],
    ["connect accept <id>", asCmd(connectCommand), ["accept", "inv_1"], "accept", ["inv_1"]],
    ["connect <slug> (bare form)", asCmd(connectCommand), ["john-doe"], "connect", ["john-doe"]],
    ["feed home --limit 5", asCmd(feedCommand), ["home", "--limit", "5"], "home", ["--limit", "5"]],
    ["webhook verify --body - --secret s", asCmd(webhookCommand), ["verify", "--body", "-", "--secret", "s"], "verify", ["--body", "-", "--secret", "s"]],
  ];

  it.each(ok)("%s still resolves, args intact", async (_label, tree, rawArgs, leafName, leafArgs) => {
    const exit = mockExit();
    const { leaf, leafArgs: got } = await resolveLeaf(tree, rawArgs);
    expect(exit).not.toHaveBeenCalled();
    expect(await nameOf(leaf)).toBe(leafName);
    expect(got).toEqual(leafArgs);
    exit.mockRestore();
  });

  it("a value-flag whose value looks like a subcommand is not counted as a positional", async () => {
    const exit = mockExit();
    const { leaf, leafArgs } = await resolveLeaf(asCmd(profileCommand), [
      "followers",
      "jdoe",
      "--account",
      "relations",
    ]);
    expect(exit).not.toHaveBeenCalled();
    expect(await nameOf(leaf)).toBe("followers");
    expect(leafArgs).toEqual(["jdoe", "--account", "relations"]);
    exit.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Structural locks on the two reach paths this tree does not currently have.
// If either is ever added, the guard above must be revisited, so these fail
// loudly rather than letting a new path in unguarded.
// ---------------------------------------------------------------------------

describe("command tree — reach paths that must not appear without revisiting the guard", () => {
  const roots: Array<[string, CommandDef]> = [
    ["profile", asCmd(profileCommand)],
    ["company", asCmd(companyCommand)],
    ["job", asCmd(jobCommand)],
    ["connect", asCmd(connectCommand)],
    ["search", asCmd(searchCommand)],
    ["inbox", asCmd(inboxCommand)],
    ["inboxes", asCmd(inboxesCommand)],
    ["message", asCmd(messageCommand)],
    ["post", asCmd(postCommand)],
    ["comment", asCmd(commentCommand)],
    ["account", asCmd(accountCommand)],
    ["webhook", asCmd(webhookCommand)],
    ["sales-nav", asCmd(salesNavCommand)],
    ["recruiter", asCmd(recruiterCommand)],
    ["group", asCmd(groupCommand)],
    ["feed", asCmd(feedCommand)],
    ["notification", asCmd(notificationCommand)],
    ["config", asCmd(configCommand)],
  ];

  const resolveMaybe = async (v: unknown): Promise<unknown> =>
    typeof v === "function" ? await (v as () => unknown)() : v;

  it("no subcommand registry maps two keys to the same command (no aliases exist)", async () => {
    const dupes: string[] = [];
    async function walk(cmd: CommandDef, path: string[]): Promise<void> {
      const subs = (await resolveMaybe(cmd.subCommands)) as Record<string, unknown> | undefined;
      if (!subs) return;
      const seen = new Map<unknown, string>();
      for (const [key, value] of Object.entries(subs)) {
        const resolved = await resolveMaybe(value);
        const prior = seen.get(resolved);
        if (prior) dupes.push(`${path.join(" ")}: ${prior} and ${key}`);
        else seen.set(resolved, key);
        await walk(resolved as CommandDef, [...path, key]);
      }
    }
    for (const [name, root] of roots) await walk(root, [name]);
    expect(dupes).toEqual([]);
  });

  it("no group node names a default subcommand (citty has no such field)", async () => {
    const withDefault: string[] = [];
    async function walk(cmd: CommandDef, path: string[]): Promise<void> {
      const node = cmd as unknown as Record<string, unknown>;
      if (node["defaultSubCommand"] !== undefined || node["default"] !== undefined) {
        withDefault.push(path.join(" "));
      }
      const subs = (await resolveMaybe(cmd.subCommands)) as Record<string, unknown> | undefined;
      if (!subs) return;
      for (const [key, value] of Object.entries(subs)) {
        await walk((await resolveMaybe(value)) as CommandDef, [...path, key]);
      }
    }
    for (const [name, root] of roots) await walk(root, [name]);
    expect(withDefault).toEqual([]);
  });
});
