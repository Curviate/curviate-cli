/**
 * The bare-form fall-through audit, pinned against the live command registry.
 *
 * ## The defect class
 *
 * A command node that declares BOTH `subCommands` and at least one positional
 * argument has an ambiguous first token. The dispatcher descends into a
 * subcommand when the token names one; otherwise it runs the node's own `run()`
 * with that token bound to the first positional. So an unregistered or mistyped
 * subcommand silently becomes an argument to the bare form.
 *
 * Whether that matters depends entirely on what the bare form DOES. A read
 * wastes a round trip. A write performs an action nobody asked for, and two
 * nodes are write-bearing: `message` (sends a message) and `connect` (sends a
 * connection invitation). Those two are the contact-safety surface, and both
 * are guarded.
 *
 * ## Why the table is asserted rather than written down
 *
 * A hand-maintained list of "which groups have this shape" is stale the moment
 * someone adds a positional to an existing group, and the defect is invisible
 * until it ships. So the audit below is derived from the real command tree at
 * runtime and diffed against the expected verdicts: adding a positional to a
 * group with subcommands, or a subcommand to a group with positionals, fails
 * this test and forces an explicit verdict on the new node.
 */

import { describe, it, expect } from "vitest";
import type { CommandDef } from "citty";

/** citty types each command as CommandDef<ItsOwnArgs>; the router walks the plain form. */
const asCmd = (c: unknown): CommandDef => c as CommandDef;

async function resolveValue<T>(input: T | (() => T) | (() => Promise<T>)): Promise<T> {
  return typeof input === "function" ? (input as () => T | Promise<T>)() : input;
}

/**
 * Every top-level group, mirroring src/cli.ts's registry. Kept as its own map
 * rather than imported from cli.ts because importing that module executes
 * `dispatch(main, process.argv)` at import time.
 */
const GROUPS: Record<string, () => Promise<CommandDef>> = {
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

interface AuditRow {
  /** Full command path, e.g. "recruiter project-job". */
  path: string;
  /** Positional argument names the node declares, in order. */
  positionals: string[];
  /** Whether an unregistered first token reaches this node's own run(). */
  fallthroughReachable: boolean;
}

/** Walk the tree, recording every node that declares subCommands. */
async function auditTree(): Promise<AuditRow[]> {
  const rows: AuditRow[] = [];

  async function walk(cmd: CommandDef, path: string): Promise<void> {
    const args = (await resolveValue(cmd.args ?? {})) as Record<string, { type?: string }>;
    const positionals = Object.entries(args)
      .filter(([, def]) => def?.type === "positional")
      .map(([name]) => name);

    const subs = (await resolveValue(cmd.subCommands)) as Record<string, unknown> | undefined;
    const subNames = subs ? Object.keys(subs) : [];
    if (subNames.length === 0) return;

    rows.push({
      path,
      positionals,
      // A node with no positionals cannot absorb an unknown token: the
      // dispatcher reports "unknown command" instead. A node WITH positionals
      // and a run() will bind the token and execute the bare form.
      fallthroughReachable: positionals.length > 0 && typeof cmd.run === "function",
    });

    for (const name of subNames) {
      await walk(asCmd(await resolveValue(subs![name])), `${path} ${name}`);
    }
  }

  for (const [name, load] of Object.entries(GROUPS)) {
    await walk(await load(), name);
  }
  return rows;
}

type Verdict =
  /** No positional, so an unknown token is rejected as an unknown command. */
  | "safe-no-positional"
  /** Fall-through reaches a READ. Wasteful on a typo, but it changes nothing. */
  | "unsafe-read-only"
  /** Fall-through reaches a WRITE. This is the contact-safety surface. */
  | "unsafe-write-bearing-guarded";

/**
 * The audit's verdict for every node that declares subcommands.
 *
 * A node missing from this map, or whose reachability no longer matches, fails
 * the test below. That is the point: a new command group cannot be added, and
 * a positional cannot be added to an existing one, without someone deciding
 * whether its bare form writes.
 */
const EXPECTED: Record<string, Verdict> = {
  // --- Write-bearing bare forms. Both guarded; see bare-form-guard.ts. ---
  message: "unsafe-write-bearing-guarded", // bare form sends a message
  connect: "unsafe-write-bearing-guarded", // bare form sends a connection invitation

  // --- Read-only bare forms. A typo costs a round trip and nothing else. ---
  profile: "unsafe-read-only", // bare form retrieves a profile
  company: "unsafe-read-only", // bare form retrieves a company
  search: "unsafe-read-only", // bare form runs a pasted search URL
  "sales-nav search": "unsafe-read-only",
  "recruiter search": "unsafe-read-only",
  "recruiter project": "unsafe-read-only",
  "recruiter project-job": "unsafe-read-only",
  "recruiter applicant": "unsafe-read-only",

  // --- No positional: an unknown token is a usage error at the dispatcher. ---
  config: "safe-no-positional",
  job: "safe-no-positional",
  "job applicant": "safe-no-positional",
  inbox: "safe-no-positional",
  inboxes: "safe-no-positional",
  post: "safe-no-positional",
  comment: "safe-no-positional",
  account: "safe-no-positional",
  "account connect-session": "safe-no-positional",
  "account checkpoint": "safe-no-positional",
  webhook: "safe-no-positional",
  "sales-nav": "safe-no-positional",
  "sales-nav message": "safe-no-positional",
  recruiter: "safe-no-positional",
  "recruiter message": "safe-no-positional",
  "recruiter job": "safe-no-positional",
  group: "safe-no-positional",
  feed: "safe-no-positional",
  notification: "safe-no-positional",
};

describe("bare-form fall-through audit", () => {
  it("every node with subcommands has a recorded verdict", async () => {
    const rows = await auditTree();
    const audited = rows.map((r) => r.path).sort();
    const expected = Object.keys(EXPECTED).sort();

    // Both directions: a new group needs a verdict, and a removed group must
    // not linger in the table pretending to have been audited.
    expect(audited).toEqual(expected);
  });

  it("each node's fall-through reachability matches its recorded verdict", async () => {
    const rows = await auditTree();
    for (const row of rows) {
      const verdict = EXPECTED[row.path];
      expect(verdict, `no audit verdict recorded for \`${row.path}\``).toBeDefined();

      const shouldBeReachable = verdict !== "safe-no-positional";
      expect(
        row.fallthroughReachable,
        `\`${row.path}\` declares positionals ${JSON.stringify(row.positionals)}; ` +
          `its bare form is ${row.fallthroughReachable ? "reachable" : "unreachable"}, ` +
          `but the audit recorded "${verdict}". Decide whether its bare form writes ` +
          `and update EXPECTED (and guard it, if it does).`,
      ).toBe(shouldBeReachable);
    }
  });

  it("the write-bearing set is exactly `message` and `connect`", async () => {
    // Named explicitly because this is the contact-safety surface: a third
    // entry appearing here is a new way for a typo to reach a real person.
    const writeBearing = Object.entries(EXPECTED)
      .filter(([, v]) => v === "unsafe-write-bearing-guarded")
      .map(([path]) => path)
      .sort();
    expect(writeBearing).toEqual(["connect", "message"]);
  });

  it("every write-bearing node exports a guard", async () => {
    const message = await import("../src/commands/message.js");
    const connect = await import("../src/commands/connect.js");
    expect(typeof message.guardBareMessageForm).toBe("function");
    expect(typeof connect.guardBareConnectForm).toBe("function");
  });
});
