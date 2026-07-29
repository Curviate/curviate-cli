/**
 * Successor-hint tests — removed/renamed commands point at their replacement.
 *
 * The 0.15.0 release removed or renamed a batch of commands. An agent that
 * pattern-matches the old grammar (`post list`, `connect respond`,
 * `profile connections`, …) previously got a bare "unknown command" (or, for
 * the bare-positional groups, a confusing downstream 404 when the removed
 * keyword was swallowed as an id). A small map keyed by `<group> <token>` now
 * appends a "did you mean" line to the usage error, saving the agent a wasted
 * lookup turn. Exit code stays 2.
 *
 * Two layers are asserted:
 *   1. `successorHint(group, token)` — the map itself, directly.
 *   2. `resolveLeaf` — the hint reaches stderr and the process exits 2, for
 *      BOTH pure groups (token never matched a subcommand) and bare-positional
 *      groups (where the token would otherwise be swallowed as the bare id).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { CommandDef } from "citty";
import { resolveLeaf, successorHint } from "../src/dispatch.js";
import { postCommand } from "../src/commands/post.js";
import { connectCommand } from "../src/commands/connect.js";
import { profileCommand } from "../src/commands/profile.js";
import { accountCommand } from "../src/commands/account.js";
import { inboxCommand } from "../src/commands/inbox.js";
import { webhookCommand } from "../src/commands/webhook.js";
import { recruiterCommand } from "../src/commands/recruiter.js";
import { salesNavCommand } from "../src/commands/sales-nav.js";

const asCmd = (c: unknown): CommandDef => c as CommandDef;

function mockExit() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
}

describe("successorHint — the removed/renamed map", () => {
  // [group, token, a substring the hint MUST contain]
  const cases: Array<[string, string, string]> = [
    ["post", "list", "post user-posts"],
    ["post", "comment", "comment add"],
    ["post", "comments", "comment list"],
    ["connect", "respond", "connect accept"],
    ["connect", "respond", "connect decline"],
    ["profile", "connections", "profile relations"],
    ["account", "connect-link", "account link"],
    ["account", "reconnect-link", "account link"],
    ["account", "reconnect", "account link"],
    ["inbox", "sync", "inbox messages"],
    ["inbox", "sync-chat", "inbox messages"],
    ["recruiter", "add-candidate", "recruiter save-candidate"],
    ["recruiter", "sync", "sync"],
    ["recruiter", "project-jobs", "recruiter project-job"],
    ["sales-nav", "sync", "sync"],
    ["webhook", "state-diff", "state-diff"],
  ];

  it.each(cases)("%s %s → hint mentions %s", (group, token, expected) => {
    const hint = successorHint(group, token);
    expect(hint, `expected a successor hint for \`${group} ${token}\``).not.toBeNull();
    expect(hint!).toContain(expected);
  });

  it("returns null for a token that is a valid identifier, not a removed command", () => {
    expect(successorHint("connect", "john-doe")).toBeNull();
    expect(successorHint("profile", "some-slug")).toBeNull();
    expect(successorHint("company", "1035")).toBeNull();
  });

  it("returns null for an unknown group", () => {
    expect(successorHint("curviate", "bogus")).toBeNull();
    expect(successorHint("nonsuch", "list")).toBeNull();
  });
});

describe("resolveLeaf — removed command under a PURE group exits 2 with the successor hint", () => {
  afterEach(() => vi.restoreAllMocks());

  const cases: Array<[string, CommandDef, string[], string]> = [
    ["post list", asCmd(postCommand), ["list"], "post user-posts"],
    ["post comment", asCmd(postCommand), ["comment"], "comment add"],
    ["account reconnect", asCmd(accountCommand), ["reconnect"], "account link"],
    ["inbox sync", asCmd(inboxCommand), ["sync"], "inbox messages"],
    ["webhook state-diff", asCmd(webhookCommand), ["state-diff"], "state-diff"],
    ["recruiter add-candidate", asCmd(recruiterCommand), ["add-candidate"], "recruiter save-candidate"],
    ["sales-nav sync", asCmd(salesNavCommand), ["sync"], "sync"],
  ];

  it.each(cases)("%s → exit 2, stderr carries the hint", async (_label, tree, rawArgs, expected) => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => {
      writes.push(String(s));
      return true;
    });
    const exit = mockExit();
    await expect(resolveLeaf(tree, rawArgs)).rejects.toThrow("process.exit(2)");
    expect(writes.join("")).toContain(expected);
    exit.mockRestore();
  });
});

describe("resolveLeaf — removed command under a BARE-POSITIONAL group hints instead of swallowing the id", () => {
  afterEach(() => vi.restoreAllMocks());

  const cases: Array<[string, CommandDef, string[], string]> = [
    ["connect respond", asCmd(connectCommand), ["respond"], "connect accept"],
    ["connect respond --decline x", asCmd(connectCommand), ["respond", "--decline", "x"], "connect decline"],
    ["profile connections", asCmd(profileCommand), ["connections"], "profile relations"],
  ];

  it.each(cases)("%s → exit 2, stderr carries the hint (not a bare-id swallow)", async (_label, tree, rawArgs, expected) => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => {
      writes.push(String(s));
      return true;
    });
    const exit = mockExit();
    await expect(resolveLeaf(tree, rawArgs)).rejects.toThrow("process.exit(2)");
    expect(writes.join("")).toContain(expected);
    exit.mockRestore();
  });
});

describe("resolveLeaf — a real subcommand or valid bare id is UNAFFECTED by the hint map", () => {
  afterEach(() => vi.restoreAllMocks());

  it("connect sent still descends to the sent subcommand", async () => {
    const { leaf } = await resolveLeaf(asCmd(connectCommand), ["sent"]);
    const meta = typeof leaf.meta === "function" ? await (leaf.meta as () => Promise<{ name?: string }>)() : leaf.meta;
    expect((meta as { name?: string }).name).toBe("sent");
  });

  it("connect <valid-slug> still resolves to the bare connect node", async () => {
    const { leaf, leafArgs } = await resolveLeaf(asCmd(connectCommand), ["john-doe"]);
    const meta = typeof leaf.meta === "function" ? await (leaf.meta as () => Promise<{ name?: string }>)() : leaf.meta;
    expect((meta as { name?: string }).name).toBe("connect");
    expect(leafArgs).toEqual(["john-doe"]);
  });
});
