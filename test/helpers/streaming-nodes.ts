/**
 * The streaming command surface, derived at test run time from the live
 * command tree (never a hand-written list): every leaf command that declares
 * `--all`. Shared by every bin-level test that exercises a guard scoped to
 * exactly that set, so the set itself is computed once and the same way
 * everywhere it matters — a new streaming command is picked up automatically,
 * and none of these tests can silently skip it.
 *
 * Lifted out of `test/all-flag-streams-bin.test.ts` (the original discoverer
 * of this pattern) rather than re-derived, so a future change to how the
 * surface is walked only has one place to change.
 */

import type { CommandDef } from "citty";

export type ArgDef = { type?: string; required?: boolean };
export type Node = {
  path: string[];
  defs: Record<string, ArgDef>;
  hasSubs: boolean;
  /** The leaf's bound citty `run` closure, kept so a consumer can inspect
   * which exported command function it delegates to (via
   * `Function.prototype.toString`) without re-walking the tree itself. */
  run?: CommandDef["run"];
};

const asCmd = (c: unknown): CommandDef => c as CommandDef;

async function resolveValue<T>(input: T | (() => T) | (() => Promise<T>)): Promise<T> {
  return typeof input === "function" ? (input as () => T | Promise<T>)() : input;
}

async function walk(cmd: CommandDef, path: string[], out: Node[]): Promise<void> {
  const subs = (await resolveValue(cmd.subCommands ?? {})) as Record<string, unknown>;
  if (cmd.run) {
    out.push({
      path,
      defs: (await resolveValue(cmd.args ?? {})) as Record<string, ArgDef>,
      hasSubs: Object.keys(subs).length > 0,
      run: cmd.run,
    });
  }
  for (const [name, sub] of Object.entries(subs)) {
    await walk(asCmd(await resolveValue(sub as CommandDef)), [...path, name], out);
  }
}

/** Values for required flags whose value is validated before any request. */
export const FLAG_VALUES: Record<string, string> = {
  state: "OPEN",
  source: "messaging",
  type: "LOCATION",
  keywords: "xyz",
  "channel-id": "c1",
  "request-url": "https://h.test/x",
  "account-ids": "acc_1",
  "endorsement-id": "e1",
};

/** Where the default argv would not reach the stream: a URL-only form, a query minimum, a flag that selects the list. */
export const OVERRIDES: Record<string, string[]> = {
  search: ["search", "https://www.linkedin.com/search/results/people/?keywords=x"],
  "recruiter search": ["recruiter", "search", "https://www.linkedin.com/talent/search?searchContextId=1"],
  "sales-nav search": ["sales-nav", "search", "https://www.linkedin.com/sales/search/people?query=x"],
  "inbox search": ["inbox", "search", "hello"],
  "search groups": ["search", "groups", "hello"],
  "company search-chats": ["company", "search-chats", "1", "hello"],
  profile: ["profile", "1", "--posts"],
  "profile me": ["profile", "me", "--posts"],
};

export function argvFor(node: Node): string[] {
  const key = node.path.join(" ");
  if (OVERRIDES[key]) return OVERRIDES[key]!;
  // Numeric, not "x1": a numeric-looking identifier takes a resolver's fast
  // path (e.g. `resolveCompanyId` skips the extra `companies.get` lookup for
  // anything matching `^\d+$`), so the ONLY request a list command sends is
  // the one whose guard is under test — an alphanumeric id would mask a
  // missing plain-branch guard behind an unrelated, already-guarded resolve
  // call that happens to fail first against a uniformly-bad fake server.
  const positionals = Object.values(node.defs)
    .filter((d) => d.type === "positional" && d.required !== false)
    .map(() => "1");
  const required = Object.entries(node.defs)
    .filter(([, d]) => d.type !== "positional" && d.required)
    .flatMap(([name]) => [`--${name}`, FLAG_VALUES[name] ?? "x"]);
  return [...node.path, ...positionals, ...required];
}

/** Every command group that can carry a streaming leaf. */
async function commandGroups(): Promise<Array<[string, CommandDef]>> {
  return [
    ["account", asCmd((await import("../../src/commands/account.js")).accountCommand)],
    ["comment", asCmd((await import("../../src/commands/comment.js")).commentCommand)],
    ["company", asCmd((await import("../../src/commands/company.js")).companyCommand)],
    ["connect", asCmd((await import("../../src/commands/connect.js")).connectCommand)],
    ["feed", asCmd((await import("../../src/commands/feed.js")).feedCommand)],
    ["group", asCmd((await import("../../src/commands/group.js")).groupCommand)],
    ["inbox", asCmd((await import("../../src/commands/inbox.js")).inboxCommand)],
    ["inboxes", asCmd((await import("../../src/commands/inboxes.js")).inboxesCommand)],
    ["job", asCmd((await import("../../src/commands/job.js")).jobCommand)],
    ["message", asCmd((await import("../../src/commands/message.js")).messageCommand)],
    ["notification", asCmd((await import("../../src/commands/notification.js")).notificationCommand)],
    ["post", asCmd((await import("../../src/commands/post.js")).postCommand)],
    ["profile", asCmd((await import("../../src/commands/profile.js")).profileCommand)],
    ["recruiter", asCmd((await import("../../src/commands/recruiter.js")).recruiterCommand)],
    ["sales-nav", asCmd((await import("../../src/commands/sales-nav.js")).salesNavCommand)],
    ["search", asCmd((await import("../../src/commands/search.js")).searchCommand)],
    ["webhook", asCmd((await import("../../src/commands/webhook.js")).webhookCommand)],
  ];
}

/** A group that only prints its usage (no positional of its own) sends nothing either way. */
function usageOnly(n: Node): boolean {
  return n.hasSubs && !Object.values(n.defs).some((d) => d.type === "positional") && !OVERRIDES[n.path.join(" ")];
}

/** Every leaf command in the live tree, whatever surface it belongs to. */
export async function allNodes(): Promise<Node[]> {
  const nodes: Node[] = [];
  for (const [name, cmd] of await commandGroups()) await walk(cmd, [name], nodes);
  return nodes;
}

/**
 * Every leaf command that declares `--all` (the streaming surface),
 * discovered from the live command tree — never a hand-written list.
 */
export async function discoverStreamingNodes(): Promise<Node[]> {
  return (await allNodes()).filter((n) => "all" in n.defs && !usageOnly(n));
}

/**
 * Every leaf command that declares `--cursor` (the paginated surface), same
 * live-tree derivation. A SUPERSET of the streaming surface: a command can
 * take a cursor without offering `--all` (NON_STREAM_FLAGS declares
 * `--cursor` but not `--all`), and those are precisely the ones that have
 * historically accepted the flag and dropped it.
 */
export async function discoverCursorNodes(): Promise<Node[]> {
  return (await allNodes()).filter((n) => "cursor" in n.defs && !usageOnly(n));
}
