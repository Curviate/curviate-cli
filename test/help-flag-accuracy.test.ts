/**
 * Every `--flag` a command's help text mentions must be a flag that command
 * actually declares.
 *
 * ## Why this test exists
 *
 * `group list`'s description said "Pass `--profile` to enumerate another
 * member's groups". The declared argument is `target`, so the flag is
 * `--target`; `--profile` is the GLOBAL config-profile selector. Following the
 * help text therefore selected a config profile and silently returned your own
 * groups, with no error anywhere. That is worse than the same mistake in an
 * article: help text is the last thing someone checks before concluding the
 * tool is broken.
 *
 * It was also the second help-vs-behaviour mismatch found in one day, after
 * `message search` being documented as a read while resolving to a send. Two of
 * the same class is a pattern, so the sweep is mechanical and permanent rather
 * than a one-time read-through: the flags named in help are extracted from the
 * live command tree and checked against the args that same node declares.
 */

import { describe, it, expect } from "vitest";
import type { CommandDef } from "citty";
import { successorHint } from "../src/dispatch.js";

const asCmd = (c: unknown): CommandDef => c as CommandDef;

async function resolveValue<T>(input: T | (() => T) | (() => Promise<T>)): Promise<T> {
  return typeof input === "function" ? (input as () => T | Promise<T>)() : input;
}

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

/**
 * Flags every command inherits from the global set, so naming one in help is
 * always accurate regardless of what the node itself declares.
 */
const GLOBAL_FLAG_NAMES = new Set([
  "account",
  "json",
  "fields",
  "limit",
  "cursor",
  "all",
  "max-pages",
  "page-delay",
  "preview",
  "verbose",
  "api-key",
  "base-url",
  "timeout",
  "profile",
  "help",
  "version",
]);

interface Finding {
  /** The command whose help text carries the mention. */
  path: string;
  /** The command the flag was validated against (differs on a cross-reference). */
  against: string;
  flag: string;
  declared: string[];
}

/**
 * Collect `path -> declared flag names` for every node in the tree, plus the
 * help text each node carries.
 */
async function collectTree(): Promise<
  Map<string, { declared: Set<string>; helpText: string }>
> {
  const tree = new Map<string, { declared: Set<string>; helpText: string }>();

  async function walk(cmd: CommandDef, path: string): Promise<void> {
    const meta = (await resolveValue(cmd.meta ?? {})) as Record<string, unknown>;
    const args = (await resolveValue(cmd.args ?? {})) as Record<
      string,
      { alias?: string | string[]; description?: string } | undefined
    >;

    const declared = new Set<string>();
    // Each arg's own description string, right alongside the command-level
    // meta text below. Without this, a flag or command-name mention living in
    // e.g. `--posts`'s own description (as opposed to the command's overall
    // description/usage) is invisible to every check in this file — which is
    // exactly how the `profile me --posts` "use 'post list'" defect survived
    // the ORIGINAL version of this sweep: `--target`/`--profile` in the
    // `group list` regression happened to live in the command-level
    // description, so that one check never needed arg-level text to pass.
    const argDescriptions: string[] = [];
    for (const [name, def] of Object.entries(args)) {
      declared.add(name);
      const alias = def?.alias;
      if (typeof alias === "string") declared.add(alias);
      else if (Array.isArray(alias)) for (const a of alias) declared.add(a);
      if (def?.description) argDescriptions.push(def.description);
    }

    // Every free-text field on meta (description, usage, anything added
    // later), plus every declared arg's own description.
    const helpText = [
      ...Object.entries(meta)
        .filter(([key, value]) => key !== "name" && typeof value === "string")
        .map(([, value]) => value as string),
      ...argDescriptions,
    ].join("\n");

    tree.set(path, { declared, helpText });

    const subs = (await resolveValue(cmd.subCommands)) as Record<string, unknown> | undefined;
    for (const [name, sub] of Object.entries(subs ?? {})) {
      await walk(asCmd(await resolveValue(sub)), `${path} ${name}`);
    }
  }

  for (const [name, load] of Object.entries(GROUPS)) {
    await walk(await load(), name);
  }
  return tree;
}

/**
 * Resolve the deepest known command path from a `curviate a b c …` reference,
 * so a cross-reference is checked against the command it actually names.
 *
 * Help text legitimately points at other commands ("finish with
 * `curviate account checkpoint solve <account_id> --code`"), and `--code` is
 * correct there even though `account link` does not declare it. Attributing
 * that flag to the mentioning command would be a false positive; ignoring
 * cross-references entirely would miss a reference that names a WRONG flag.
 * So the reference is resolved and the flag validated against its own command.
 */
function resolveReferencedPath(
  tokens: string[],
  tree: Map<string, unknown>,
): string | null {
  let best: string | null = null;
  let candidate = "";
  for (const token of tokens) {
    candidate = candidate ? `${candidate} ${token}` : token;
    if (tree.has(candidate)) best = candidate;
    else if (best !== null) break;
  }
  return best;
}

/**
 * Every flag mentioned in `helpText`, paired with the command path it should be
 * validated against: the command named by the enclosing `curviate …` reference
 * when there is one, otherwise the mentioning command itself.
 */
function mentionsWithContext(
  helpText: string,
  ownPath: string,
  tree: Map<string, unknown>,
): Array<{ flag: string; against: string }> {
  const out: Array<{ flag: string; against: string }> = [];

  // Split into backticked spans and the prose between them. A `curviate …`
  // span rebinds the context for the flags inside it; prose does not.
  const spans = helpText.split(/(`[^`]*`)/);
  for (const span of spans) {
    let against = ownPath;
    const isCode = span.startsWith("`") && span.endsWith("`");
    if (isCode) {
      const inner = span.slice(1, -1).trim();
      const words = inner.split(/\s+/);
      if (words[0] === "curviate") {
        const referenced = resolveReferencedPath(words.slice(1), tree);
        if (referenced) against = referenced;
      }
    }
    for (const match of span.matchAll(/--([a-z][a-z0-9]*(?:-[a-z0-9]+)*)/g)) {
      out.push({ flag: match[1]!, against });
    }
  }
  return out;
}

/** Walk the tree and collect every help-mentioned flag its command does not declare. */
async function findMismatches(): Promise<Finding[]> {
  const tree = await collectTree();
  const findings: Finding[] = [];

  for (const [path, { helpText }] of tree) {
    for (const { flag, against } of mentionsWithContext(helpText, path, tree)) {
      const declared = tree.get(against)!.declared;
      // `--no-x` is citty's implicit negation of a declared boolean `x`.
      const base = flag.startsWith("no-") ? flag.slice(3) : flag;
      if (declared.has(flag) || declared.has(base)) continue;
      if (GLOBAL_FLAG_NAMES.has(flag) || GLOBAL_FLAG_NAMES.has(base)) continue;
      findings.push({ path, against, flag: `--${flag}`, declared: [...declared].sort() });
    }
  }
  return findings;
}

describe("help text names only flags the command declares", () => {
  it("no command's description or usage mentions an undeclared flag", async () => {
    const findings = await findMismatches();
    const report = findings.map(
      (f) =>
        `  ${f.path}: help says \`${f.flag}\`, but \`${f.against}\` declares only ` +
        `[${f.declared.join(", ")}] (plus the global flags)`,
    );
    expect(report, `help-vs-args mismatches:\n${report.join("\n")}`).toEqual([]);
  });

  it("the `group list` regression specifically: --target, never --profile", async () => {
    // The original defect. `--profile` is the global config-profile selector,
    // so following the old help text silently returned your own groups.
    const groupCmd = await GROUPS["group"]!();
    const subs = (await resolveValue(groupCmd.subCommands)) as Record<string, unknown>;
    const list = asCmd(await resolveValue(subs["list"]));

    const meta = (await resolveValue(list.meta ?? {})) as { description?: string };
    const args = (await resolveValue(list.args ?? {})) as Record<string, unknown>;

    expect(Object.keys(args)).toContain("target");
    expect(meta.description ?? "").toContain("--target");
    expect(meta.description ?? "").not.toContain("--profile");

    // And the parent group's usage block agrees.
    const parentMeta = (await resolveValue(groupCmd.meta ?? {})) as Record<string, unknown>;
    const parentText = Object.values(parentMeta)
      .filter((v): v is string => typeof v === "string")
      .join("\n");
    expect(parentText).not.toContain("--profile");
  });
});

// ---------------------------------------------------------------------------
// Command-name references: help text naming a REMOVED command, not an
// undeclared flag. Same defect family as the flag-mismatch sweep above
// (stale advice a reader would follow straight into an error), one field
// over: a command path instead of a flag name.
//
// `profile me --posts`'s description recommended 'post list' for
// authored-only posts; `post list` was removed (src/dispatch.ts's own
// REMOVED_COMMANDS map answers it with a successor hint), so following that
// advice hit "post list was removed" on the same binary that printed the
// recommendation. The flag-only sweep above could never have caught this:
// 'post list' is a command-path reference, not a `--flag`. Scoped to
// QUOTED spans specifically (backtick, single, or double) — a help author
// writing a command reference reaches for quotes ('post list', `post list`),
// which is the same signal that separates an intentional reference from
// prose that merely happens to start with a group name.
// ---------------------------------------------------------------------------

/** Every backtick-, single-, or double-quoted span in `helpText`, trimmed. */
function quotedSpans(helpText: string): string[] {
  const out: string[] = [];
  for (const m of helpText.matchAll(/`([^`]*)`|'([^']*)'|"([^"]*)"/g)) {
    const inner = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (inner) out.push(inner);
  }
  return out;
}

interface StaleCommandFinding {
  /** The command whose help text carries the stale reference. */
  path: string;
  /** The quoted span as written. */
  quoted: string;
  /** The successor hint dispatch.ts already carries for the removed token. */
  hint: string;
}

/**
 * Walk the tree and collect every quoted `<group> <token>` reference where
 * `<token>` is a command dispatch.ts's own REMOVED_COMMANDS map already
 * knows was removed/renamed under `<group>` — the exact shape of the
 * `post list` defect. A leading "curviate" in the quoted span is stripped
 * first, so both "post list" and "curviate post list" style references
 * resolve the same way.
 *
 * Deliberately does NOT flag a quoted reference that fails to resolve to
 * anything at all (live or removed): that would also catch ordinary quoted
 * prose that happens to start with a group name, which is not this defect
 * class and would make the check too noisy to keep passing honestly.
 * Checking against the removed-command map specifically keeps the false-positive
 * rate at zero: it only fires on a token dispatch.ts itself documents as gone.
 */
function findStaleCommandReferences(
  tree: Map<string, { helpText: string }>,
): StaleCommandFinding[] {
  const findings: StaleCommandFinding[] = [];
  const groupNames = new Set(Object.keys(GROUPS));

  for (const [path, { helpText }] of tree) {
    for (const quoted of quotedSpans(helpText)) {
      const words = quoted.split(/\s+/).filter(Boolean);
      if (words[0] === "curviate") words.shift();
      const group = words[0];
      const token = words[1];
      if (group === undefined || token === undefined) continue;
      if (!groupNames.has(group)) continue;

      const hint = successorHint(group, token);
      if (hint) findings.push({ path, quoted, hint });
    }
  }
  return findings;
}

describe("help text names only commands that still exist", () => {
  it("no command's description or usage quotes a removed/renamed command", async () => {
    const tree = await collectTree();
    const findings = findStaleCommandReferences(tree);
    const report = findings.map(
      (f) => `  ${f.path}: help quotes \`${f.quoted}\`, which was removed. ${f.hint}`,
    );
    expect(report, `stale command-name references:\n${report.join("\n")}`).toEqual([]);
  });

  it("the `profile me --posts` regression specifically: points at the real successor, not the removed command", async () => {
    const profileCmd = await GROUPS["profile"]!();
    const subs = (await resolveValue(profileCmd.subCommands)) as Record<string, unknown>;
    const me = asCmd(await resolveValue(subs["me"]));
    const args = (await resolveValue(me.args ?? {})) as Record<string, { description?: string }>;
    const postsDescription = args["posts"]?.description ?? "";

    // 'post list' is exactly the token dispatch.ts's REMOVED_COMMANDS answers
    // with a successor hint — the description must not send a reader there.
    expect(successorHint("post", "list")).not.toBeNull();
    expect(postsDescription).not.toMatch(/['"`]post list['"`]/);
    expect(postsDescription).toContain("post user-posts");
  });
});
